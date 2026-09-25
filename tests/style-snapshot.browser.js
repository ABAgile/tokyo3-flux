// Style snapshot. Execute with playwright-browser run-code (use --raw) against a
// FRESH seeded disposable workspace that is first for the test identity. It
// creates one extra empty workspace for the first-run page. Never use team data.
//
// The result is a JSON string; save it outside the repository and compare two
// runs made on the same day with any line diff (seeded sprint dates follow the
// calendar). Each element is keyed by its DOM path and records its
// attributes, own text and computed style (plus ::before/::after/::placeholder),
// stored as a difference from its parent so the output stays small but lossless.
// IDs, clock times, running animations and focus/hover state are masked so that unchanged
// code produces identical output.
// biome-ignore lint/correctness/noUnusedVariables: Playwright run-code invokes this function.
async function run(page) {
  page.setDefaultTimeout(15000);
  const WIDTHS = [1440, 768, 390];
  const THEMES = ['light', 'dark'];
  const HEIGHT = 1000;
  const check = (ok, message) => {
    if (!ok) throw new Error(message);
  };
  const clickSelector = (selector) =>
    page.evaluate((s) => {
      const node = document.querySelector(s);
      if (!node) throw new Error(`missing ${s}`);
      node.click();
    }, selector);
  const settle = async () => {
    await page.waitForFunction(
      () =>
        !document.querySelector('#planning-body[aria-busy="true"], #page-root[aria-busy="true"]'),
    );
    await page.waitForTimeout(400);
    await page.evaluate(async () => {
      for (const animation of document.getAnimations()) {
        if (animation.effect?.getTiming().iterations === Infinity) {
          animation.pause();
          animation.currentTime = 0;
        } else animation.finish();
      }
      document.activeElement?.blur?.();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.mouse.move(0, HEIGHT - 1);
  };
  const title = (text) =>
    page.waitForFunction((t) => document.getElementById('title')?.textContent === t, text);
  const nav = async (name, heading) => {
    await clickSelector(`nav [data-view="${name}"]`);
    await title(heading);
  };
  const closeDialogs = async () => {
    for (let i = 0; i < 3 && (await page.locator('dialog[open]').count()); i++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
    }
  };

  const styles = {};
  const captures = {};
  const capture = async (name) => {
    await settle();
    const result = await page.evaluate(() => {
      const ID = /\b[A-Z2-7]{26}\b/g;
      const UID = /\b[0-9a-f]{32}\b/g;
      const STAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
      const TIME = /\b\d{1,2}:\d{2}(:\d{2})?( ?[AP]M)?\b/g;
      const mask = (value) =>
        String(value)
          .replace(ID, '<id>')
          .replace(UID, '<uid>')
          .replace(STAMP, '<timestamp>')
          .replace(TIME, '<time>');
      const hash = (text) => {
        let h = 0x811c9dc5;
        for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
        return (h >>> 0).toString(16).padStart(8, '0');
      };
      const table = {};
      const store = (props) => {
        if (!props.length) return '';
        const text = props.join('\n');
        let key = hash(text);
        while (table[key] !== undefined && table[key] !== text) key += '+';
        table[key] = text;
        return key;
      };
      const read = (style) => {
        const values = {};
        for (let i = 0; i < style.length; i++) values[style[i]] = style.getPropertyValue(style[i]);
        return values;
      };
      const delta = (values, base) =>
        Object.keys(values)
          .sort()
          .filter((name) => !base || base[name] !== values[name])
          .map((name) => `${name}: ${mask(values[name])}`);
      const rows = [];
      const walk = (node, path, parentValues) => {
        const values = read(getComputedStyle(node));
        const pseudo = {};
        for (const kind of ['::before', '::after', '::placeholder']) {
          if (kind === '::placeholder' && !node.matches('input,textarea')) continue;
          const style = getComputedStyle(node, kind);
          if (kind !== '::placeholder' && style.content === 'none') continue;
          pseudo[kind] = store(delta(read(style), values));
        }
        const attrs = [...node.attributes]
          .map((a) => `${a.name}=${mask(a.value)}`)
          .sort()
          .join(' ');
        const text = [...node.childNodes]
          .filter((child) => child.nodeType === Node.TEXT_NODE)
          .map((child) => child.nodeValue)
          .join('')
          .replace(/\s+/g, ' ')
          .trim();
        const row = [path, attrs, mask(text).slice(0, 160), store(delta(values, parentValues))];
        if ('value' in node && typeof node.value === 'string' && node.tagName !== 'BUTTON')
          row.push(`value=${mask(node.value).slice(0, 160)}`);
        for (const [kind, key] of Object.entries(pseudo)) row.push(`${kind}=${key}`);
        rows.push(row);
        const counts = {};
        for (const child of node.children) {
          const tag = child.tagName.toLowerCase();
          counts[tag] = (counts[tag] || 0) + 1;
          walk(child, `${path}>${tag}[${counts[tag]}]`, values);
        }
      };
      walk(document.documentElement, 'html', undefined);
      return { rows, table };
    });
    for (const [key, text] of Object.entries(result.table)) {
      check(styles[key] === undefined || styles[key] === text, `style hash collision ${key}`);
      styles[key] = text;
    }
    check(!captures[name], `duplicate capture ${name}`);
    captures[name] = result.rows.map((row) => row.join(' | '));
  };

  const workspace = await page.locator('#workspace').inputValue();
  await page.getByRole('heading', { name: 'Kanban board', exact: true }).waitFor();
  const seededViews = async (prefix) => {
    await closeDialogs();
    await nav('board', 'Kanban board');
    await clickSelector('#presentation-board');
    await title('Kanban board');
    await capture(`${prefix}/board`);

    await page.locator('.card .card-title').first().click();
    await page.locator('dialog#editor[open]').waitFor();
    await capture(`${prefix}/item-editor`);
    await closeDialogs();

    await clickSelector('#presentation-list');
    await title('Planning list');
    await capture(`${prefix}/list`);
    await page.locator('.list-row').first().focus();
    await page.keyboard.press('Enter');
    await page.locator('.item-detail-pane').waitFor();
    await capture(`${prefix}/detail-pane`);
    await page.locator('.item-detail-pane .item-detail-close').click();
    await page.locator('.item-detail-pane').waitFor({ state: 'hidden' });
    await clickSelector('#presentation-board');
    await title('Kanban board');

    await nav('sprints', 'Sprints');
    const show = page.getByRole('button', { name: 'Show burn down', exact: true }).first();
    await show.click();
    await page.locator('.burndown-svg').first().waitFor();
    await capture(`${prefix}/sprints-burndown`);
    await page.getByRole('button', { name: 'Hide burn down', exact: true }).first().click();
    await page.locator('.burndown-panel').first().waitFor({ state: 'detached' });

    await nav('projects', 'Projects');
    await capture(`${prefix}/projects`);
    await nav('members', 'Members');
    await capture(`${prefix}/members`);
    await nav('labels', 'Labels');
    await capture(`${prefix}/labels`);
    await nav('history', 'History');
    await page
      .locator('#page-root .history-list, #page-root li, #page-root .empty')
      .first()
      .waitFor();
    await capture(`${prefix}/history`);

    await nav('board', 'Kanban board');
    await clickSelector('#proposals');
    await page.locator('dialog#editor[open]').waitFor();
    await capture(`${prefix}/proposals`);
    await closeDialogs();
  };
  const setTheme = async (themeName) => {
    if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== themeName)
      await clickSelector('#theme');
    check(
      (await page.evaluate(() => document.documentElement.dataset.theme)) === themeName,
      `theme ${themeName} not applied`,
    );
  };
  for (const themeName of THEMES) {
    await setTheme(themeName);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: HEIGHT });
      await seededViews(`${themeName}/${width}`);
    }
  }

  // The first-run checklist only appears on an empty board, so create one
  // empty workspace last; it never affects the seeded captures above.
  await page.setViewportSize({ width: WIDTHS[0], height: HEIGHT });
  await clickSelector('#new-workspace');
  await page.locator('#workspace-name').fill('Style snapshot empty');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await page.locator('.first-run').waitFor();
  check(
    (await page.locator('#workspace').inputValue()) !== workspace,
    'empty workspace not opened',
  );
  for (const themeName of THEMES) {
    await setTheme(themeName);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: HEIGHT });
      await capture(`${themeName}/${width}/first-run`);
    }
  }
  await setTheme(THEMES[0]);

  return JSON.stringify({
    captures,
    styles: Object.fromEntries(
      Object.keys(styles)
        .sort()
        .map((key) => [key, styles[key]]),
    ),
  });
}
