// Run against a same-origin static fixture with #fixture, the application CSS,
// /modules/*.js and script-src/style-src 'self'. No API or workspace is mutated.
// biome-ignore lint/correctness/noUnusedVariables: invoked by playwright-cli run-code.
async function run(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const result = await page.evaluate(async () => {
    const { html, renderIsland, unmountIsland, useLayoutEffect } = await import(
      '/modules/preact.js'
    );
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
    const steps = [
      {
        title: 'Create a project',
        help: 'Projects classify work items.',
        action: 'Open Projects',
        done: false,
        run: () => {},
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
  await page.keyboard.press('Tab');
  if (errors.length) throw new Error(errors.join('\n'));
  return { passed: result, layouts: 'light/dark at 1440, 768, 390', errors };
}
