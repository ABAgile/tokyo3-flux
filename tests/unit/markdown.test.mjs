// Exercise the actual Preact renderer: untrusted text must stay text, and only
// explicitly allowed protocols may become links. No HTML parser is involved.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDOM } from './dom.mjs';
import { render } from '../../internal/planningui/static/modules/vendor-preact.js';
import { markdownTemplate } from '../../internal/planningui/static/modules/markdown.js';

const root = installDOM();
globalThis.location = new URL('https://flux.example/workspace');

function nodes(node) {
  return [node, ...node.childNodes.flatMap(nodes)];
}
function rendered(source) {
  const container = root();
  render(markdownTemplate(source), container);
  return container;
}
function assertSafe(container) {
  for (const node of nodes(container)) {
    assert.ok(
      !['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'IMG', 'SVG', 'STYLE'].includes(node.nodeName),
    );
    for (const name of Object.keys(node.attributes)) {
      assert.ok(!/^on/i.test(name), `unsafe attribute ${name}`);
    }
    if (node.nodeName === 'A') {
      const url = new URL(node.attributes.href);
      assert.ok(['https:', 'http:', 'mailto:'].includes(url.protocol), url.href);
      if (url.origin !== location.origin) {
        assert.equal(node.attributes.target, '_blank');
        assert.equal(node.attributes.rel, 'noopener noreferrer');
      }
    }
  }
}

const forbidden = [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'DATA:image/svg+xml,<svg/onload=alert(1)>',
  'vbscript:msgbox(1)',
  'VbScRiPt:msgbox(1)',
  'file:///etc/passwd',
  'blob:https://flux.example/id',
  'java\tscript:alert(1)',
  'java\nscript:alert(1)',
  'java\rscript:alert(1)',
  '\u0000javascript:alert(1)',
  ' javascript:alert(1)',
  'javascript: alert(1)',
];
for (const target of forbidden) {
  test(`Markdown does not link ${JSON.stringify(target)}`, () => {
    const container = rendered(`[click](${target})`);
    assertSafe(container);
    assert.equal(nodes(container).filter((node) => node.nodeName === 'A').length, 0);
    assert.ok(container.textContent.includes('click'));
  });
}

for (const source of [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg><a href="javascript:alert(1)">x</a></svg>',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  '&#60;img src=x onerror=alert(1)&#62;',
  '![avatar](https://example.com/image.png)',
  '![payload](data:image/svg+xml,<svg/onload=alert(1)>)',
  '<javascript:alert(1)>',
]) {
  test(`Markdown preserves hostile markup or images as text: ${source}`, () => {
    const container = rendered(source);
    assertSafe(container);
    assert.equal(container.textContent, source);
  });
}

for (const target of ['javascript&#58;alert', 'jav&#x61;script:alert', '%6aavascript:alert']) {
  test(`entity or percent encoded schemes are not decoded into executable URLs: ${target}`, () => {
    const container = rendered(`[link](${target})`);
    assertSafe(container);
    const link = nodes(container).find((node) => node.nodeName === 'A');
    assert.equal(new URL(link.attributes.href).origin, location.origin);
    assert.ok(link.attributes.href.includes(target), 'entities remain literal URL text');
  });
}

test('Markdown allows same-origin, external and mail links with safe target attributes', () => {
  const container = rendered(
    '[local](/items/one) [external](https://example.com/x) <mailto:user@example.com>',
  );
  assertSafe(container);
  const links = nodes(container).filter((node) => node.nodeName === 'A');
  assert.deepEqual(
    links.map((node) => node.attributes.href),
    ['https://flux.example/items/one', 'https://example.com/x', 'mailto:user@example.com'],
  );
  assert.equal(links[0].attributes.target, undefined);
});

test('nested blocks and emphasis keep unsafe links and HTML inert', () => {
  const source =
    '> ## **Nested _heading_**\n> - [x] ~~[blocked](javascript:alert)~~\n> - [ ] <script>x</script>\n\n| **Name** | Link |\n| :--- | ---: |\n| <img onerror=x> | [safe](https://example.com) |';
  const container = rendered(source);
  assertSafe(container);
  const elements = nodes(container);
  for (const name of ['BLOCKQUOTE', 'H2', 'STRONG', 'EM', 'DEL', 'UL', 'TABLE', 'TH', 'TD']) {
    assert.ok(
      elements.some((node) => node.nodeName === name),
      name,
    );
  }
  assert.equal(elements.filter((node) => node.nodeName === 'A').length, 1);
  const tasks = elements.filter((node) => node.nodeName === 'INPUT');
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every((node) => node.attributes.disabled !== undefined));
  assert.ok(container.textContent.includes('<script>x</script>'));
  assert.ok(container.textContent.includes('<img onerror=x>'));
});

test('code fences and inline code do not interpret links, HTML or emphasis', () => {
  const container = rendered(
    '```html\n<script>x</script>\n[bad](javascript:alert)\n```\n\n`**literal** <img onerror=x>`',
  );
  assertSafe(container);
  assert.equal(nodes(container).filter((node) => node.nodeName === 'A').length, 0);
  assert.ok(container.textContent.includes('<script>x</script>\n[bad](javascript:alert)'));
  assert.ok(container.textContent.includes('**literal** <img onerror=x>'));
});

test('empty and CRLF input, escaped markers, rules and ordered lists render predictably', () => {
  assert.equal(rendered(undefined).textContent, '');
  const container = rendered(
    '# Heading\r\n\r\n\\*literal\\*\r\n\r\n---\r\n\r\n1. first\r\n2. second',
  );
  assertSafe(container);
  assert.ok(container.textContent.includes('*literal*'));
  assert.ok(nodes(container).some((node) => node.nodeName === 'HR'));
  assert.ok(nodes(container).some((node) => node.nodeName === 'OL'));
});
