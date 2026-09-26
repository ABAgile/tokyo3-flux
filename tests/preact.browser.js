// Run against a same-origin static fixture with #fixture, the application CSS,
// /modules/*.js and script-src/style-src 'self'. No API or workspace is mutated.
// biome-ignore lint/correctness/noUnusedVariables: invoked by playwright-cli run-code.
async function run(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const result = await page.evaluate(async () => {
    const {
      html,
      renderIsland,
      unmountIsland,
      useLayoutEffect,
      useRef,
      useState,
      useReducer,
      mount,
      nodeOf,
      syncDisabled,
    } = await import('/modules/preact.js');
    const { useRequest, useDismiss } = await import('/modules/ui-hooks.js');
    const { state, setState, useStore } = await import('/modules/state.js');
    const { StatusBars, notice, showPlanningChangeNotice, clearPlanningChangeNotice } =
      await import('/modules/notices.js');
    const { App } = await import('/modules/app-shell.js');
    const { api } = await import('/modules/api.js');
    const { helpPopoverTemplate, multiSelectTemplate } = await import('/modules/multi-select.js');
    const { markdownTemplate, markdownEditorTemplate } = await import('/modules/markdown.js');
    const { WorkspaceSelection, WorkspaceCreation, FirstRunChecklist } = await import(
      '/modules/gate-components.js'
    );
    const host = document.querySelector('#fixture');
    const check = (value, message) => {
      if (!value) throw new Error(message);
    };
    const flush = () => new Promise((resolve) => setTimeout(resolve, 60));
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
    let started = 0,
      stopped = 0;
    function Lifecycle() {
      const [count, setCount] = useState(0);
      useLayoutEffect(() => {
        started++;
        return () => {
          stopped++;
        };
      }, []);
      return html`<button onClick=${() => setCount((value) => value + 1)}>Count ${count}</button>`;
    }
    renderIsland(host, html`<${Lifecycle} />`);
    host.firstElementChild.click();
    await flush();
    check(started === 1 && host.textContent === 'Count 1', 'hook state updates a component');
    unmountIsland(host);
    unmountIsland(host);
    check(stopped === 1 && !host.children.length, 'unmount releases hooks exactly once');
    const detached = nodeOf(html`<${Lifecycle} />`);
    host.append(detached);
    await flush();
    unmountIsland(detached);
    check(stopped === 2, 'rendered-once component releases its effects');
    function ReducerCounter() {
      const [count, dispatch] = useReducer((value, action) => value + action, 0);
      return html`<button onClick=${() => dispatch(1)}>Reduced ${count}</button>`;
    }
    renderIsland(host, html`<${ReducerCounter} />`);
    host.firstElementChild.click();
    await flush();
    check(host.textContent === 'Reduced 1', 'useReducer updates component state');
    const initialChord = state.shortcutChord;
    let storeRenders = 0;
    function StoreProbe() {
      storeRenders++;
      const chord = useStore((current) => current.shortcutChord);
      return html`<button onClick=${() =>
        setState((current) => ({
          shortcutChord: current.shortcutChord + 1,
        }))}>Store ${chord}</button>`;
    }
    renderIsland(host, html`<${StoreProbe} />`);
    host.firstElementChild.click();
    await flush();
    check(
      host.textContent === `Store ${initialChord + 1}` && storeRenders === 2,
      'store selector reacts to state updates',
    );
    setState({ errorText: 'Unrelated update' });
    await flush();
    check(storeRenders === 2, 'selector skips unrelated state changes');
    setState({ errorText: '' });
    state.shortcutChord = initialChord + 2;
    await flush();
    check(
      host.textContent === `Store ${initialChord + 2}` && storeRenders === 3,
      'compatibility state writes notify store selectors',
    );
    setState({ shortcutChord: initialChord });

    const previousGate = state.workspaceGate;
    renderIsland(host, html`<${App} refresh=${() => {}} />`);
    const legacyBody = host.querySelector('#planning-body');
    check(
      host.querySelector('#title')?.textContent === 'Loading planning data',
      'app shell renders its initial title',
    );
    setState({ workspaceGate: 'select' });
    await flush();
    check(
      host.querySelector('#title')?.textContent === 'Choose a workspace' &&
        host.querySelector('nav')?.hidden &&
        host.querySelector('#planning-body') === legacyBody,
      'app shell updates gate content without replacing the planning mount',
    );
    unmountIsland(host);
    setState({ workspaceGate: previousGate });

    let refreshes = 0;
    renderIsland(host, html`<${StatusBars} refresh=${() => refreshes++} />`);
    const status = host.querySelector('#notice');
    check(status?.getAttribute('aria-live') === 'polite', 'status live region mounts politely');
    const textChanges = [];
    const observer = new MutationObserver((records) => textChanges.push(...records));
    observer.observe(status, { subtree: true, characterData: true, childList: true });
    notice('Workspace ready');
    await flush();
    const announcedChanges = textChanges.length;
    setState({ shortcutChord: initialChord + 1 });
    await flush();
    check(
      status.textContent === 'Workspace ready' && textChanges.length === announcedChanges,
      'unrelated store updates do not rewrite the live announcement',
    );
    observer.disconnect();
    notice('Permission denied', true);
    await flush();
    check(
      !host.querySelector('#error-bar').hidden &&
        host.querySelector('#error-bar').getAttribute('role') === 'alert',
      'errors use the mounted assertive live region',
    );
    host.querySelector('#error-dismiss').click();
    await flush();
    check(host.querySelector('#error-bar').hidden, 'error dismissal updates store state');
    showPlanningChangeNotice('Review workspace changes');
    await flush();
    check(
      !host.querySelector('#planning-change').hidden &&
        host.querySelector('#planning-change-text').textContent === 'Review workspace changes',
      'planning-change notice reads reactive state',
    );
    host.querySelector('#planning-refresh').click();
    check(refreshes === 1, 'planning-change action calls its prop');
    clearPlanningChangeNotice();
    await flush();
    check(
      host.querySelector('#planning-change').hidden,
      'planning-change notice clears reactively',
    );
    renderIsland(host, null);

    const originalFetch = window.fetch;
    let forwardedSignal;
    window.fetch = async (_path, options) => {
      forwardedSignal = options.signal;
      return new Response('{"ok":true}', {
        headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const controller = new AbortController();
      const response = await api('/api/v2/test', { signal: controller.signal });
      check(response.ok && forwardedSignal === controller.signal, 'api forwards AbortSignal');
    } finally {
      window.fetch = originalFetch;
    }

    const requestSignals = [];
    function RequestProbe({ root }) {
      const result = useRequest(
        (signal) =>
          new Promise((_resolve, reject) => {
            requestSignals.push(signal);
            signal.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
        [root],
      );
      return html`<span>${result.loading ? 'Loading' : 'Idle'}</span>`;
    }
    renderIsland(host, html`<${RequestProbe} root="one" />`);
    await flush();
    renderIsland(host, html`<${RequestProbe} root="two" />`);
    await flush();
    check(
      requestSignals.length === 2 && requestSignals[0].aborted,
      'request key aborts stale work',
    );
    unmountIsland(host);
    check(requestSignals[1].aborted, 'request cleanup aborts work on unmount');

    let dismissed = 0;
    function DismissProbe() {
      const [open, setOpen] = useState(true);
      const ref = useRef(null);
      useDismiss(ref, open, () => {
        dismissed++;
        setOpen(false);
      });
      return open ? html`<div ref=${ref}>Open menu</div>` : null;
    }
    const outside = document.createElement('button');
    document.body.append(outside);
    renderIsland(host, html`<${DismissProbe} />`);
    await flush();
    host.firstElementChild.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await flush();
    check(dismissed === 0, 'useDismiss ignores pointers inside its ref');
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await flush();
    check(dismissed === 1 && !host.children.length, 'useDismiss handles outside pointers');
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await flush();
    check(dismissed === 1, 'useDismiss cleans up after closing');
    unmountIsland(host);
    renderIsland(host, html`<${DismissProbe} />`);
    await flush();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    check(dismissed === 2 && !host.children.length, 'useDismiss handles Escape');
    unmountIsland(host);
    outside.remove();

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
    renderIsland(
      host,
      markdownEditorTemplate('description', 'Description', 'Initial **draft**', 4000, false, true),
    );
    const textarea = host.querySelector('textarea');
    check(
      textarea?.name === 'description' && textarea.maxLength === 4000 && textarea.hidden,
      'Markdown editor preserves the native field contract and preview default',
    );
    check(
      host.querySelector('.markdown-preview strong')?.textContent === 'draft',
      'initial Markdown preview renders',
    );
    host.querySelector('.markdown-mode').click();
    await flush();
    check(
      !textarea.hidden && document.activeElement === textarea,
      'Edit returns focus to the retained draft',
    );
    textarea.value = 'Changed **draft**';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    host.querySelector('.markdown-mode').click();
    await flush();
    check(
      textarea.hidden &&
        host.querySelector('.markdown-preview')?.textContent.includes('Changed') &&
        host.querySelector('.markdown-preview strong')?.textContent === 'draft',
      'preview reflects the current native draft',
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
      await flush();
      check(listeners.size === 1, 'popover registers its outside listener');
      renderIsland(host, null);
      check(listeners.size === 0, 'popover releases its outside listener on removal');
      let pickerControls, changedValues;
      renderIsland(
        host,
        multiSelectTemplate('labels', 'Labels', [['one', 'One']], [], undefined, undefined, {
          onReady: (controls) => {
            pickerControls = controls;
          },
          onChange: (values) => {
            changedValues = values;
          },
        }),
      );
      check(
        pickerControls.group === host.firstElementChild,
        'picker exposes its component-owned controls',
      );
      host.querySelector('[data-multi-edit]').click();
      await flush();
      check(listeners.size === 1, 'picker registers its outside listener');
      const checkbox = host.querySelector('input[type="checkbox"]');
      checkbox.click();
      await flush();
      check(
        checkbox.checked && changedValues?.[0] === 'one' && pickerControls.selected()[0] === 'one',
        'native checkbox selection updates component state and its control API',
      );
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
