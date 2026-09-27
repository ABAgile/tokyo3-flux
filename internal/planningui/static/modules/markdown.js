// Markdown rendering and the Markdown editor control. Rendering produces Preact
// templates whose text parts Preact writes as text, never as markup, so item and
// comment bodies cannot inject HTML. Link targets are filtered through
// markdownURL.
import { html } from './vdom.js';
import { useId, useLayoutEffect, useRef, useState } from './vendor-preact.js';

function markdownURL(value) {
  const raw = String(value || '').trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: URLs with control characters are rejected on purpose.
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return '';
  try {
    const url = new URL(raw, location.href);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return '';
    return url.href;
  } catch {
    return '';
  }
}
function markdownEscaped(value) {
  return value === String.fromCharCode(92) || '`*_[]~'.includes(value);
}
function markdownLink(href, content) {
  const external = new URL(href, location.href).origin !== location.origin;
  return external
    ? html`<a href=${href} target="_blank" rel="noopener noreferrer">${content}</a>`
    : html`<a href=${href}>${content}</a>`;
}
// Inline Markdown as template parts. Plain text is gathered into runs and
// rendered as text by Preact, which never parses it as markup.
function markdownInline(source) {
  const parts = [];
  let text = '';
  const push = (part) => {
    if (text) parts.push(text);
    text = '';
    parts.push(part);
  };
  let i = 0;
  while (i < source.length) {
    if (
      source[i] === String.fromCharCode(92) &&
      i + 1 < source.length &&
      markdownEscaped(source[i + 1])
    ) {
      text += source[i + 1];
      i += 2;
      continue;
    }
    if (source[i] === '`') {
      const match = /^`+/.exec(source.slice(i));
      const marker = match?.[0];
      const end = marker ? source.indexOf(marker, i + marker.length) : -1;
      if (marker && end > i + marker.length) {
        push(
          html`<code class="markdown-inline-code">${source.slice(i + marker.length, end)}</code>`,
        );
        i = end + marker.length;
        continue;
      }
    }
    if (source.startsWith('![', i)) {
      text += '![';
      i += 2;
      continue;
    }
    const link = /^([^\]\n]+)\]\(([^)\s]+)(?:\s+["'][^"\n]*["'])?\)/.exec(
      source.slice(i).startsWith('[') ? source.slice(i).slice(1) : '',
    );
    if (source[i] === '[' && link) {
      const whole = `[${link[0]}`;
      const href = markdownURL(link[2]);
      if (href) push(markdownLink(href, markdownInline(link[1])));
      else text += whole;
      i += whole.length;
      continue;
    }
    const auto = /^<((?:https?|mailto):[^<>\s]+)>/.exec(source.slice(i));
    if (auto) {
      const href = markdownURL(auto[1]);
      if (href) push(markdownLink(href, auto[1]));
      else text += auto[0];
      i += auto[0].length;
      continue;
    }
    let formatted = false;
    for (const [marker, tag] of [
      ['**', 'strong'],
      ['__', 'strong'],
      ['~~', 'del'],
      ['*', 'em'],
      ['_', 'em'],
    ]) {
      if (!source.startsWith(marker, i)) continue;
      if (
        (marker === '*' || marker === '_') &&
        /\w/.test(source[i - 1] || '') &&
        /\w/.test(source[i + marker.length] || '')
      )
        continue;
      const end = source.indexOf(marker, i + marker.length);
      if (end <= i + marker.length) continue;
      const content = markdownInline(source.slice(i + marker.length, end));
      push(
        tag === 'strong'
          ? html`<strong>${content}</strong>`
          : tag === 'del'
            ? html`<del>${content}</del>`
            : html`<em>${content}</em>`,
      );
      i = end + marker.length;
      formatted = true;
      break;
    }
    if (formatted) continue;
    text += source[i];
    i++;
  }
  if (text) parts.push(text);
  return parts;
}
function markdownBlockStart(line) {
  return /^\s{0,3}(?:#{1,6}\s|`{3,}|~{3,}|>\s?|[-+*]\s+|\d+[.)]\s+|(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(
    line,
  );
}
function markdownTableCells(line) {
  const value = line.trim();
  if (!value.includes('|')) return null;
  const withoutStart = value.startsWith('|') ? value.slice(1) : value;
  const source = withoutStart.endsWith('|') ? withoutStart.slice(0, -1) : withoutStart;
  const cells = [];
  let cell = '';
  let escaped = false;
  for (const character of source) {
    if (character === '|' && !escaped) {
      cells.push(cell.trim());
      cell = '';
    } else cell += character;
    escaped = character === '\\' && !escaped;
    if (character !== '\\') escaped = false;
  }
  cells.push(cell.trim());
  return cells;
}
const HEADINGS = {
  1: (content) => html`<h1>${content}</h1>`,
  2: (content) => html`<h2>${content}</h2>`,
  3: (content) => html`<h3>${content}</h3>`,
  4: (content) => html`<h4>${content}</h4>`,
  5: (content) => html`<h5>${content}</h5>`,
  6: (content) => html`<h6>${content}</h6>`,
};
function markdownTable(header, alignments, rows) {
  const cell = (tag, value, index) => {
    const align = alignments[index] ? { 'text-align': alignments[index] } : {};
    return tag === 'th'
      ? html`<th style=${align}>${markdownInline(value)}</th>`
      : html`<td style=${align}>${markdownInline(value)}</td>`;
  };
  return html`<table class="markdown-table">
    <thead>
      <tr>${header.map((value, index) => cell('th', value, index))}</tr>
    </thead>
    <tbody>
      ${rows.map((row) => html`<tr>${row.map((value, index) => cell('td', value, index))}</tr>`)}
    </tbody>
  </table>`;
}
function MarkdownTask({ checked, content }) {
  return html`<li class="markdown-task">
    <input
      id=${`markdown-task-${useId()}`}
      type="checkbox"
      checked=${checked}
      disabled
      tabindex="-1"
      aria-label=${checked ? 'Completed task' : 'Incomplete task'}
    />${content}
  </li>`;
}
// Markdown blocks as a list of templates.
function markdownTemplate(source) {
  const blocks = [];
  const lines = String(source || '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].trim()) {
      index++;
      continue;
    }
    const tableHeader = markdownTableCells(lines[index]);
    const tableRule = index + 1 < lines.length ? markdownTableCells(lines[index + 1]) : null;
    if (
      tableHeader?.length &&
      tableRule?.length === tableHeader.length &&
      tableRule.every((cell) => /^:?-{3,}:?$/.test(cell))
    ) {
      const alignments = tableRule.map((cell) =>
        cell.startsWith(':') && cell.endsWith(':')
          ? 'center'
          : cell.startsWith(':')
            ? 'left'
            : cell.endsWith(':')
              ? 'right'
              : '',
      );
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim()) {
        const cells = markdownTableCells(lines[index]);
        if (!cells || cells.length !== tableHeader.length) break;
        rows.push(cells);
        index++;
      }
      blocks.push(markdownTable(tableHeader, alignments, rows));
      continue;
    }
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*(.*)$/.exec(lines[index]);
    if (fence) {
      const marker = fence[1];
      const code = [];
      index++;
      while (index < lines.length) {
        const trimmed = lines[index].trim();
        if (
          trimmed.length >= marker.length &&
          [...trimmed].every((character) => character === marker[0])
        ) {
          index++;
          break;
        }
        code.push(lines[index++]);
      }
      blocks.push(html`<pre class="markdown-code-block"><code>${code.join('\n')}</code></pre>`);
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(lines[index]);
    if (heading) {
      blocks.push(HEADINGS[heading[1].length](markdownInline(heading[2])));
      index++;
      continue;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(lines[index])) {
      blocks.push(html`<hr class="markdown-rule" />`);
      index++;
      continue;
    }
    const quote = /^\s{0,3}>\s?(.*)$/.exec(lines[index]);
    if (quote) {
      const quoteLines = [];
      while (index < lines.length) {
        const line = /^\s{0,3}>\s?(.*)$/.exec(lines[index]);
        if (!line) break;
        quoteLines.push(line[1]);
        index++;
      }
      blocks.push(html`<blockquote>${markdownTemplate(quoteLines.join('\n'))}</blockquote>`);
      continue;
    }
    const unordered = /^\s{0,3}[-+*]\s+(.+)$/.exec(lines[index]);
    const ordered = /^\s{0,3}\d+[.)]\s+(.+)$/.exec(lines[index]);
    if (unordered || ordered) {
      const pattern = ordered ? /^\s{0,3}\d+[.)]\s+(.+)$/ : /^\s{0,3}[-+*]\s+(.+)$/;
      const items = [];
      while (index < lines.length) {
        const item = pattern.exec(lines[index]);
        if (!item) break;
        const task = /^\[([ xX])\]\s+(.+)$/.exec(item[1]);
        items.push(
          task
            ? html`<${MarkdownTask}
                checked=${task[1].toLowerCase() === 'x'}
                content=${markdownInline(task[2])}
              />`
            : html`<li>${markdownInline(item[1])}</li>`,
        );
        index++;
      }
      blocks.push(ordered ? html`<ol>${items}</ol>` : html`<ul>${items}</ul>`);
      continue;
    }
    const paragraphLines = [lines[index++]];
    while (index < lines.length && lines[index].trim() && !markdownBlockStart(lines[index]))
      paragraphLines.push(lines[index++]);
    blocks.push(
      html`<p>${paragraphLines.map((line, lineIndex) =>
        lineIndex ? html`<br />${markdownInline(line)}` : markdownInline(line),
      )}</p>`,
    );
  }
  return blocks;
}
const prefixLines = (text, prefix) =>
  text
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
// Toolbar entries in order; `null` is a divider.
/** @type {([string, string, (text: string) => string, string] | null)[]} */
const MARKDOWN_TOOLS = [
  null,
  ['Bold', 'B', (text) => `**${text}**`, 'bold text'],
  ['Italic', 'I', (text) => `_${text}_`, 'italic text'],
  ['Strikethrough', 'S', (text) => `~~${text}~~`, 'struck text'],
  null,
  ['Inline code', '<>', (text) => `\`${text}\``, 'code'],
  ['Code block', '▣', (text) => `\`\`\`\n${text}\n\`\`\``, 'code block'],
  ['Link', '↗', (text) => `[${text}](https://example.com)`, 'link text'],
  null,
  ['Heading', 'H', (text) => prefixLines(text, '## '), 'heading'],
  [
    'Insert table',
    '▦',
    (text) => `\n\n| ${text} | Header 2 |\n| --- | --- |\n| Cell 1 | Cell 2 |\n\n`,
    'Header 1',
  ],
  null,
  ['Bulleted list', '•', (text) => prefixLines(text, '- '), 'list item'],
  [
    'Numbered list',
    '1.',
    (text) =>
      text
        .split('\n')
        .map((line, index) => `${index + 1}. ${line}`)
        .join('\n'),
    'list item',
  ],
  ['Task list', '☑', (text) => prefixLines(text, '- [ ] '), 'task item'],
  null,
  ['Quote', '❝', (text) => prefixLines(text, '> '), 'quoted text'],
  ['Horizontal rule', '—', () => '---', ''],
];
const MARKDOWN_SHORTCUTS = {
  b: [(text) => `**${text}**`, 'bold text'],
  i: [(text) => `_${text}_`, 'italic text'],
  k: [(text) => `[${text}](https://example.com)`, 'link text'],
};
function markdownPreview(source, emptyText) {
  return html`${markdownTemplate(source)}${
    String(source || '').trim() ? null : html`<p class="help">${emptyText}</p>`
  }`;
}
// The Markdown editor keeps preview mode in component state. By default the
// native textarea owns its draft for the lifetime of the enclosing form; with
// `settings.onValueChange` the caller owns `value` and the field is controlled.
function markdownEditorTemplate(
  name,
  title,
  value,
  maxLength,
  readOnly,
  previewByDefault,
  settings = {},
) {
  return html`<${MarkdownEditor}
    name=${name}
    title=${title}
    value=${value}
    maxLength=${maxLength}
    readOnly=${readOnly}
    previewByDefault=${previewByDefault}
    settings=${settings}
  />`;
}
/**
 * @typedef {{ inputRef?: { current: HTMLTextAreaElement | null },
 *   onValueChange?: (value: string) => void, subject?: string,
 *   commentControl?: boolean }} MarkdownEditorSettings
 */
/** @param {{ name: string, title: string, value?: string, maxLength?: number,
 *   readOnly?: boolean, previewByDefault?: boolean, settings?: MarkdownEditorSettings }} props */
function MarkdownEditor({
  name,
  title,
  value = '',
  maxLength = 4000,
  readOnly = false,
  previewByDefault = false,
  settings = {},
}) {
  const inputID = `markdown-${useId()}`;
  const [previewing, setPreviewing] = useState(!!previewByDefault);
  const [previewSource, setPreviewSource] = useState(previewByDefault ? value : null);
  const ownInput = useRef();
  // `settings.inputRef` lets the owner focus the native field.
  const input = settings.inputRef || ownInput;
  const controlled = typeof settings.onValueChange === 'function';
  const onInput = (event) => {
    if (controlled) settings.onValueChange(event.currentTarget.value);
  };
  const wasPreviewing = useRef(previewing);
  useLayoutEffect(() => {
    if (wasPreviewing.current && !previewing) input.current?.focus();
    wasPreviewing.current = previewing;
  }, [previewing]);
  const replaceSelection = (transform, placeholder = 'text') => {
    const target = input.current;
    if (!target) return;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    const selected = target.value.slice(start, end) || placeholder;
    target.setRangeText(transform(selected), start, end, 'select');
    // setRangeText does not announce the edit; the input event keeps the
    // enclosing form's draft tracking and a controlled owner in step.
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.focus();
  };
  const shortcut = (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    const action =
      MARKDOWN_SHORTCUTS[key] ||
      (event.shiftKey && key === 'x' ? [(text) => `~~${text}~~`, 'struck text'] : undefined);
    if (!action) return;
    event.preventDefault();
    replaceSelection(...action);
  };
  const subject = settings.subject || (title === 'Description' ? 'description' : 'comment');
  const label = html`<label class="markdown-label" for=${inputID}><span>${title}</span></label>`;
  if (readOnly)
    return html`<div class="markdown-field">${label}<div class="markdown-preview">${markdownPreview(value, 'No content.')}</div></div>`;
  const modeLabel = previewing ? `Edit ${subject}` : `Preview ${subject}`;
  const shownPreview = controlled && previewing ? value : previewSource;
  return html`<div class="markdown-field">${label}<div class="markdown-editor">
    <div class="markdown-toolbar">
      <button
        type="button"
        class="markdown-mode"
        aria-label=${modeLabel}
        title=${modeLabel}
        onClick=${() => {
          if (!previewing) setPreviewSource(controlled ? value : (input.current?.value ?? ''));
          setPreviewing(!previewing);
        }}
      >${previewing ? 'Edit' : 'Preview'}</button>
      ${MARKDOWN_TOOLS.map((tool) =>
        tool
          ? html`<button
              type="button"
              class="markdown-tool"
              aria-label=${tool[0]}
              title=${tool[0]}
              hidden=${previewing}
              onClick=${() => replaceSelection(tool[2], tool[3])}
            >${tool[1]}</button>`
          : html`<span
              class="markdown-divider"
              role="separator"
              aria-orientation="vertical"
              aria-hidden="true"
              hidden=${previewing}
            ></span>`,
      )}
    </div>
    <textarea
      id=${inputID}
      name=${name}
      maxlength=${maxLength}
      placeholder="Write Markdown…"
      spellcheck="true"
      data-markdown-control="true"
      data-comment-control=${settings.commentControl ? 'true' : null}
      autocomplete="off"
      ...${controlled ? { value } : { defaultValue: value || '' }}
      hidden=${previewing}
      ref=${input}
      onInput=${onInput}
      onKeydown=${shortcut}
    ></textarea>
    <div class="markdown-preview" hidden=${!previewing} tabindex="0">
      ${shownPreview === null ? null : markdownPreview(shownPreview, 'Nothing to preview yet.')}
    </div>
  </div></div>`;
}
export { markdownTemplate, markdownEditorTemplate };
