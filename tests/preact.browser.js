// Run against a same-origin static fixture with #fixture, the application CSS,
// /modules/*.js and script-src/style-src 'self'. No API or workspace is mutated.
// biome-ignore lint/correctness/noUnusedVariables: invoked by playwright-cli run-code.
async function run(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const result = await page.evaluate(async () => {
    const {
      html,
      render,
      renderIsland,
      unmountIsland,
      useLayoutEffect,
      Controller,
      mount,
      nodeOf,
      syncDisabled,
    } = await import('/modules/preact.js');
    const { helpPopoverTemplate, multiSelectTemplate } = await import('/modules/multi-select.js');
    const { markdownTemplate } = await import('/modules/markdown.js');
    const { WorkspaceSelection, WorkspaceCreation, FirstRunChecklist } = await import(
      '/modules/gate-components.js'
    );
    const host = document.querySelector('#fixture');
    const check = (value, message) => {
      if (!value) throw new Error(message);
    };
    const violations = [];
    document.addEventListener('securitypolicyviolation', (event) =>
      violations.push(event.violatedDirective),
    );
    let chosen;
    const choose = (id) => {
      chosen = id;
    };
    const workspaces = [
      { id: 'one', name: '<img src=x onerror=alert(1)>', role: 'admin' },
      { id: 'two', name: 'Second workspace', role: 'viewer' },
    ];
    renderIsland(
      host,
      html`<${WorkspaceSelection} workspaces=${workspaces} choose=${choose} create=${() => {}} />`,
    );
    const first = host.querySelector('[data-workspace-choice="one"]');
    check(!host.querySelector('img'), 'workspace names must remain text');
    first.focus();
    renderIsland(
      host,
      html`<${WorkspaceSelection} workspaces=${[...workspaces].reverse()} choose=${choose} create=${() => {}} />`,
    );
    check(
      host.querySelector('[data-workspace-choice="one"]') === first,
      'keyed choices retain identity',
    );
    check(document.activeElement === first, 'keyed choices retain focus');
    first.click();
    check(chosen === 'one', 'choice action uses workspace id');
    let submitted;
    renderIsland(
      host,
      html`<${WorkspaceCreation} name="Tester" hasWorkspaces=${true} submit=${(event) => {
        event.preventDefault();
        submitted = new FormData(event.currentTarget).get('name');
      }} back=${() => {}} />`,
    );
    const input = host.querySelector('input');
    check(document.activeElement === input, 'creation focuses its name field after mounting');
    check(
      input.required && input.maxLength === 120 && input.autocomplete === 'organization',
      'native field contract',
    );
    input.value = 'Local workspace';
    host.querySelector('form').requestSubmit();
    check(submitted === 'Local workspace', 'native submission retains field name');
    let cleaned = 0;
    function Lifecycle() {
      useLayoutEffect(
        () => () => {
          cleaned++;
        },
        [],
      );
      return html`<span>Mounted</span>`;
    }
    renderIsland(host, html`<${Lifecycle} />`);
    unmountIsland(host);
    unmountIsland(host);
    check(cleaned === 1 && !host.children.length, 'unmount releases hooks exactly once');
    let started = 0,
      stopped = 0,
      childStopped = 0;
    function Child() {
      useLayoutEffect(
        () => () => {
          childStopped++;
        },
        [],
      );
      return html`<input name="draft" defaultValue="Initial" />`;
    }
    function setup(node) {
      started++;
      render(html`<${Child} />`, node);
      return () => {
        stopped++;
      };
    }
    renderIsland(host, html`<${Controller} setup=${setup} />`);
    const draft = host.querySelector('input');
    draft.value = 'Unsaved';
    renderIsland(host, html`<${Controller} setup=${setup} />`);
    check(
      started === 1 && host.querySelector('input') === draft && draft.value === 'Unsaved',
      'controllers retain local draft and initialize once',
    );
    renderIsland(host, null);
    check(
      stopped === 1 && childStopped === 1,
      'component removal releases nested roots and resources',
    );
    const detached = nodeOf(html`<${Controller} setup=${setup} />`);
    host.append(detached);
    unmountIsland(detached);
    check(stopped === 2 && childStopped === 2, 'rendered-once shell nodes release both roots');
    const oldUpdate = mount(host, html`<p>Old form</p>`);
    mount(host, html`<p>New form</p>`);
    oldUpdate(html`<p>Stale response</p>`);
    check(host.textContent === 'New form', 'stale mount updates cannot overwrite a newer form');
    renderIsland(host, html`<button ref=${syncDisabled(false)}>Write</button>`);
    host.firstElementChild.disabled = true;
    renderIsland(host, html`<button ref=${syncDisabled(false)}>Write</button>`);
    check(!host.firstElementChild.disabled, 'busy controls synchronize against real DOM state');
    renderIsland(
      host,
      html`<div>${markdownTemplate('<script>alert(1)</script> [unsafe](javascript:alert) **safe**')}</div>`,
    );
    check(
      !host.querySelector('script,a') && host.querySelector('strong')?.textContent === 'safe',
      'Markdown preserves safe formatting and rejects HTML/script URLs',
    );
    const listeners = new Set();
    const add = document.addEventListener;
    const remove = document.removeEventListener;
    document.addEventListener = function (type, listener, options) {
      if (type === 'click') listeners.add(listener);
      return add.call(this, type, listener, options);
    };
    document.removeEventListener = function (type, listener, options) {
      if (type === 'click') listeners.delete(listener);
      return remove.call(this, type, listener, options);
    };
    try {
      renderIsland(host, helpPopoverTemplate('Context', 'Card'));
      host.querySelector('button').click();
      check(listeners.size === 1, 'popover registers its outside listener');
      renderIsland(host, null);
      check(listeners.size === 0, 'popover releases its outside listener on removal');
      renderIsland(host, multiSelectTemplate('labels', 'Labels', [['one', 'One']], []));
      host.querySelector('[data-multi-edit]').click();
      check(listeners.size === 1, 'picker registers its outside listener');
      const checkbox = host.querySelector('input[type="checkbox"]');
      checkbox.click();
      check(checkbox.checked, 'native checkbox selection updates the picker');
      renderIsland(host, null);
      check(listeners.size === 0, 'picker releases its outside listener on removal');
    } finally {
      document.addEventListener = add;
      document.removeEventListener = remove;
    }
    const steps = [
      {
        title: 'Create a project',
        help: 'Projects classify work items.',
        action: 'Open Projects',
        done: false,
        run: () => {
          host.dataset.keyboardAction = 'projects';
        },
      },
    ];
    host.className = 'panel first-run';
    renderIsland(host, html`<${FirstRunChecklist} steps=${steps} disabled=${false} />`);
    const action = host.querySelector('button');
    action.focus();
    renderIsland(host, html`<${FirstRunChecklist} steps=${steps} disabled=${true} />`);
    check(
      action === host.querySelector('button') && action.disabled,
      'permission changes update retained buttons',
    );
    renderIsland(host, html`<${FirstRunChecklist} steps=${steps} disabled=${false} />`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    check(!violations.length, `CSP violations: ${violations}`);
    return 'escaping, keyed identity/focus, events, native forms, lifecycle cleanup and permission updates';
  });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      if (!(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)))
        throw new Error(`Horizontal overflow: ${theme} ${width}`);
    }
  }
  await page.locator('button').focus();
  await page.keyboard.press('Enter');
  if ((await page.locator('#fixture').getAttribute('data-keyboard-action')) !== 'projects')
    throw new Error('Keyboard activation did not invoke the component action');
  await page.keyboard.press('Tab');
  if (errors.length) throw new Error(errors.join('\n'));
  return { passed: result, layouts: 'light/dark at 1440, 768, 390', errors };
}
