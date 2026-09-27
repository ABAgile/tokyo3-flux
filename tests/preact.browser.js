// Run against a same-origin static fixture with #fixture, the application CSS,
// /modules/*.js and script-src/style-src 'self'. No API or workspace is mutated.
// biome-ignore lint/correctness/noUnusedVariables: invoked by playwright-cli run-code.
async function run(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const result = await page.evaluate(async () => {
    const { html } = await import('/modules/vdom.js');
    const { render, useLayoutEffect, useRef, useState, useReducer } = await import(
      '/modules/vendor-preact.js'
    );
    const renderIsland = (host, template) => render(template, host);
    const unmount = (host) => render(null, host);
    const { useRequest, useDismiss, useMutation, useEventListener, useFocusRestore } = await import(
      '/modules/ui-hooks.js'
    );
    const { state, setState, useStore } = await import('/modules/state.js');
    const { StatusBars, notice, showPlanningChangeNotice, clearPlanningChangeNotice } =
      await import('/modules/notices.js');
    const { App, DIALOGS } = await import('/modules/app-shell.js');
    const { LabelsPage } = await import('/modules/view-labels.js');
    const { MembersPage } = await import('/modules/view-members.js');
    const { FormDialog, CommandDialog } = await import('/modules/dialog.js');
    const { ErrorBoundary } = await import('/modules/error-boundary.js');
    const { focusRequestPatch, useFocusRequest } = await import('/modules/focus-request.js');
    const { openDialog, closeEditor } = await import('/modules/dialog-state.js');
    const { api, apiUpload } = await import('/modules/api.js');
    const { helpPopoverTemplate, MultiSelect } = await import('/modules/multi-select.js');
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
    setState({
      workspaceCreateDraft: '',
      workspaceCreating: false,
      workspaceCreateStatus: '',
      workspaceCreateStatusError: false,
    });
    renderIsland(
      host,
      html`<${WorkspaceCreation} name="Tester" hasWorkspaces=${true} submit=${(value) => {
        submitted = value;
      }} back=${() => {}} />`,
    );
    const input = host.querySelector('input');
    check(document.activeElement === input, 'creation focuses its name field after mounting');
    check(
      input.required && input.maxLength === 120 && input.autocomplete === 'organization',
      'native field contract',
    );
    input.value = 'Local workspace';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    host.querySelector('form').requestSubmit();
    check(submitted === 'Local workspace', 'native submission reads the Preact-owned field');
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
    unmount(host);
    unmount(host);
    check(
      stopped === 1 && !host.children.length,
      'direct Preact unmount releases hooks exactly once',
    );
    function ReducerCounter() {
      const [count, dispatch] = useReducer((value, action) => value + action, 0);
      return html`<button onClick=${() => dispatch(1)}>Reduced ${count}</button>`;
    }
    renderIsland(host, html`<${ReducerCounter} />`);
    host.firstElementChild.click();
    await flush();
    check(host.textContent === 'Reduced 1', 'useReducer updates component state');
    setState({ probeCount: 0 });
    let storeRenders = 0;
    function StoreProbe() {
      storeRenders++;
      const count = useStore((current) => current.probeCount);
      return html`<button onClick=${() =>
        setState((current) => ({
          probeCount: current.probeCount + 1,
        }))}>Store ${count}</button>`;
    }
    renderIsland(host, html`<${StoreProbe} />`);
    host.firstElementChild.click();
    await flush();
    check(
      host.textContent === 'Store 1' && storeRenders === 2,
      'store selector reacts to state updates',
    );
    setState({ errorText: 'Unrelated update' });
    await flush();
    check(storeRenders === 2, 'selector skips unrelated state changes');
    setState({ errorText: '' });
    // A render failure replaces only its boundary; Retry and a new reset key
    // render the content again.
    let fragileFails = true;
    function Fragile() {
      if (fragileFails) throw new Error('probe render failure');
      return html`<p id="fragile">Recovered</p>`;
    }
    const boundaryProbe = (key) =>
      html`<div><button id="outside">Outside</button><${ErrorBoundary} label="Probe content" resetKey=${key}><${Fragile} /></${ErrorBoundary}></div>`;
    renderIsland(host, boundaryProbe('a'));
    await flush();
    const failure = host.querySelector('[data-error-boundary]');
    check(
      failure?.getAttribute('role') === 'alert' &&
        failure.textContent.includes('Probe content could not be shown') &&
        host.querySelector('#outside'),
      'a render failure replaces only the boundary content',
    );
    fragileFails = false;
    failure.querySelector('button').click();
    await flush();
    check(
      host.querySelector('#fragile')?.textContent === 'Recovered' &&
        !host.querySelector('[data-error-boundary]'),
      'Retry renders the boundary content again',
    );
    fragileFails = true;
    renderIsland(host, boundaryProbe('a'));
    await flush();
    fragileFails = false;
    renderIsland(host, boundaryProbe('b'));
    await flush();
    check(host.querySelector('#fragile'), 'a changed reset key clears the failure');
    unmount(host);
    // A selector that throws surfaces at render, where its boundary catches
    // it, and does not stop the update from reaching other subscribers.
    setState({ probeBroken: false });
    function BrokenSelector() {
      const value = useStore((current) => {
        if (current.probeBroken) throw new Error('probe selector failure');
        return current.probeCount;
      });
      return html`<span>${value}</span>`;
    }
    function HealthySelector() {
      return html`<span id="healthy">${useStore((current) => current.probeCount)}</span>`;
    }
    renderIsland(
      host,
      html`<div><${ErrorBoundary} label="Broken probe"><${BrokenSelector} /></${ErrorBoundary}><${HealthySelector} /></div>`,
    );
    await flush();
    setState({ probeBroken: true, probeCount: 5 });
    await flush();
    check(
      host.querySelector('[data-error-boundary]') &&
        host.querySelector('#healthy')?.textContent === '5',
      'a throwing selector reaches its boundary without stopping other subscribers',
    );
    unmount(host);
    setState({ probeBroken: false, probeCount: 1 });
    // A focus request rides in the patch that renders its target; the scoped
    // consumer focuses the target after that render commits and clears it.
    setState({ probeShown: false });
    function FocusRequestProbe({ scope }) {
      const ref = useRef(null);
      const shown = useStore((current) => current.probeShown);
      useFocusRequest(scope, ref);
      return html`<div ref=${ref}>${
        shown ? html`<button data-focus-key="probe:target">Target</button>` : null
      }</div>`;
    }
    renderIsland(
      host,
      html`<div><${FocusRequestProbe} scope="probe" /><${FocusRequestProbe} scope="other" /></div>`,
    );
    await flush();
    setState({ probeShown: true, ...focusRequestPatch('probe', 'probe:target') });
    await flush();
    check(
      document.activeElement === host.querySelector('[data-focus-key="probe:target"]') &&
        state.focusRequest === undefined,
      'a focus request is consumed by its scope after the render showing its target',
    );
    document.activeElement.blur();
    setState(focusRequestPatch('missing', 'probe:target'));
    await flush();
    check(
      document.activeElement !== host.querySelector('[data-focus-key="probe:target"]') &&
        state.focusRequest?.scope === 'missing',
      'other scopes leave a focus request alone',
    );
    setState({ focusRequest: undefined, probeShown: false });
    unmount(host);
    let rejected = false;
    try {
      state.probeCount = 5;
    } catch {
      rejected = true;
    }
    check(rejected && state.probeCount === 1, 'the state view is read-only; writes use setState');
    const selection = ['one'];
    setState({ bulkSelection: selection });
    setState((current) => ({ bulkSelection: [...current.bulkSelection, 'two'] }));
    check(
      selection.length === 1 && state.bulkSelection.length === 2,
      'list-valued state is replaced, never mutated',
    );
    setState({ bulkSelection: [] });
    unmount(host);

    const previousLabelBoard = state.board;
    const labels = [{ name: 'type::component', color: '#ffcc00' }];
    setState({
      board: { role: 'admin', labels, items: [{ labels: ['type::component'] }] },
    });
    renderIsland(host, html`<${LabelsPage} />`);
    await flush();
    check(
      host.querySelector('.label-maintenance-row') && host.textContent.includes('1 card'),
      'Labels page renders current label usage',
    );
    setState({ board: { role: 'admin', labels, items: [] } });
    await flush();
    check(host.textContent.includes('0 cards'), 'Labels page updates when item usage changes');
    unmount(host);
    setState({ board: previousLabelBoard });

    const previousMembersBoard = state.board;
    const previousSession = state.session;
    const members = [{ subject: '1', name: 'Ada Example', role: 'member' }];
    setState({
      board: { role: 'admin', members, items: [] },
      session: { subject: '1', name: 'Ada Example' },
    });
    renderIsland(host, html`<${MembersPage} />`);
    await flush();
    check(
      host.querySelector('.member-role-member') && host.querySelector('button[data-admin-write]'),
      'Members page renders admin actions and role details',
    );
    setState({ board: { role: 'viewer', members, items: [] } });
    await flush();
    check(
      !host.querySelector('button[data-admin-write]') &&
        !host.querySelector('[aria-label="Edit member"]') &&
        host.textContent.includes('Review workspace members'),
      'Members page reacts to role changes',
    );
    unmount(host);
    setState({ board: previousMembersBoard, session: previousSession });

    const previousGate = state.workspaceGate;
    const previousBoard = state.board;
    const previousView = state.view;
    // Dialogs are data looked up in the App's map; probes join the real ones.
    let editorBuilds = 0;
    function ProbeDialog({ title, text, name = 'probe', value = 'initial' }) {
      editorBuilds++;
      return html`<${CommandDialog} title=${title} command=${() => ({ kind: 'probe' })}>
        <div><p id="dialog-field-root">${text}</p>
        <label>Probe<input name=${name} defaultValue=${value} /></label></div>
      </${CommandDialog}>`;
    }
    let customSubmission;
    function CustomProbeDialog() {
      return html`<${FormDialog}
        title="Custom form probe"
        saveText="Submit probe"
        onSubmit=${(data) => {
          customSubmission = data.get('probe');
          throw new Error('Keep this draft');
        }}
      ><label>Probe<input name="probe" defaultValue="initial" /></label></${FormDialog}>`;
    }
    function BrokenProbeDialog() {
      throw new Error('probe dialog failure');
    }
    const dialogs = {
      ...DIALOGS,
      probe: ProbeDialog,
      'custom.probe': CustomProbeDialog,
      'broken.probe': BrokenProbeDialog,
    };
    // Mounted planning content renders from complete board payloads only.
    const fixtureBoard = (extra) => ({
      role: 'member',
      workspace: { revision: 1, id: 'test' },
      projects: [],
      sprints: [],
      items: [],
      columns: [],
      labels: [],
      members: [],
      links: [],
      participants: [],
      closed_scope: [],
      integration: { instance: '', projects: [] },
      ...extra,
    });
    renderIsland(host, html`<${App} dialogs=${dialogs} />`);
    const legacyBody = host.querySelector('#planning-body');
    check(
      host.querySelector('#title')?.textContent === 'Loading planning data',
      'app shell renders its initial title',
    );
    const previousTheme = state.theme;
    setState({ theme: 'dark' });
    await flush();
    check(
      host.querySelector('#theme')?.textContent === '☀' &&
        host.querySelector('#theme')?.title === 'Switch to light theme',
      'theme control is rendered from store state',
    );
    setState({ theme: previousTheme });
    await flush();
    setState({ board: fixtureBoard() });
    openDialog('probe', { title: 'Dialog snapshot', text: 'Reactive dialog content' });
    await flush();
    check(
      host.querySelector('#editor')?.open &&
        host.querySelector('#dialog-field-root')?.textContent === 'Reactive dialog content' &&
        editorBuilds === 1,
      'EditorDialog opens and mounts a Preact snapshot',
    );
    host.querySelector('[name="probe"]').value = 'draft';
    setState({ board: previousBoard, workspaceGate: 'select' });
    await flush();
    const gateRoot = host.querySelector('#page-root');
    check(
      host.querySelector('#title')?.textContent === 'Choose a workspace' &&
        gateRoot?.parentElement === host.querySelector('#content') &&
        gateRoot.children.length === 1 &&
        gateRoot.firstElementChild?.dataset.contentView === 'workspace-select' &&
        host.querySelector('#planning-body')?.parentElement ===
          host.querySelector('#planning-frame') &&
        host.querySelector('nav')?.hidden &&
        !gateRoot.hidden &&
        host.querySelector('#planning-frame')?.hidden &&
        host.querySelector('#planning-body') === legacyBody &&
        host.querySelector('#dialog-field-root')?.textContent === 'Reactive dialog content' &&
        host.querySelector('[name="probe"]')?.value === 'draft' &&
        host.querySelector('#editor-title')?.textContent === 'Dialog snapshot' &&
        editorBuilds === 1,
      'App owns workspace page content without replacing mounts or editor snapshots',
    );
    const pageBoard = fixtureBoard({
      role: 'admin',
      sprints: [
        { id: 'active', name: 'Active sprint', state: 'active', goal: '', start: '', end: '' },
      ],
      columns: [{ id: 'todo', name: 'To do', category: 'todo', wip: 0 }],
    });
    setState({ board: pageBoard, workspaceGate: '', view: 'labels' });
    await flush();
    check(
      gateRoot.children.length === 1 &&
        gateRoot.firstElementChild?.classList.contains('page-stack') &&
        gateRoot.firstElementChild?.dataset.contentView === 'labels' &&
        gateRoot.textContent.includes('No labels yet.'),
      'App renders page components directly inside its content mount',
    );
    setState({ view: 'board', loading: false });
    await flush();
    const planningBody = host.querySelector('#planning-body');
    const boardRoot = planningBody.firstElementChild;
    check(
      boardRoot?.classList.contains('board') &&
        boardRoot.dataset.contentView === 'board' &&
        !!planningBody.querySelector('.column'),
      'board content renders as an App-owned component',
    );
    setState({ view: 'projects' });
    await flush();
    check(
      host.querySelector('#planning-frame')?.hidden &&
        host.querySelector('#page-root')?.querySelector('[data-content-view="projects"]') &&
        planningBody.firstElementChild === boardRoot,
      'the inactive planning frame retains its content lifetime',
    );
    setState({ view: 'board', loading: true });
    await flush();
    check(
      !host.querySelector('#planning-frame')?.hidden &&
        planningBody.getAttribute('aria-busy') === 'true' &&
        !host.querySelector('#page-root')?.hasAttribute('aria-busy') &&
        planningBody.firstElementChild === boardRoot,
      'aria-busy follows the active content body without rebuilding it',
    );
    setState({ view: 'labels', loading: false });
    await flush();
    const dialogNode = host.querySelector('#editor');
    setState({ board: fixtureBoard({ workspace: { revision: 2, id: 'test' } }) });
    openDialog('probe', {
      title: 'Replacement snapshot',
      text: 'Replacement content',
      name: 'replacement',
    });
    await flush();
    check(
      host.querySelector('#editor') === dialogNode &&
        dialogNode.open &&
        host.querySelector('#editor-title')?.textContent === 'Replacement snapshot' &&
        host.querySelector('#dialog-field-root')?.textContent === 'Replacement content' &&
        !host.querySelector('[name="probe"]') &&
        editorBuilds === 2,
      'opening another dialog replaces its snapshot without replacing the dialog',
    );
    check(
      state.editorDialog.revision === 2 && state.editorDialog.type === 'probe',
      'a dialog record is data captured when it opens',
    );
    setState({ board: previousBoard });
    closeEditor();
    await flush();
    check(!host.querySelector('#editor')?.open, 'EditorDialog closes through the controller');

    setState({ board: fixtureBoard({ workspace: { revision: 2, id: 'test' } }) });
    openDialog('probe', { title: 'First field snapshot', name: 'snapshot', value: 'first' });
    await flush();
    const oldFields = host.querySelector('#fields');
    host.querySelector('[name="snapshot"]').value = 'draft';
    openDialog('probe', { title: 'Second field snapshot', name: 'snapshot', value: 'second' });
    await flush();
    check(
      host.querySelector('#fields') !== oldFields &&
        host.querySelector('[name="snapshot"]')?.value === 'second',
      'replacement editor config remounts uncontrolled field snapshots',
    );
    closeEditor();
    await flush();
    openDialog('custom.probe');
    await flush();
    const customInput = host.querySelector('[name="probe"]');
    customInput.value = 'retained';
    host.querySelector('#editor-form').requestSubmit();
    await flush();
    check(
      customSubmission === 'retained' &&
        customInput.value === 'retained' &&
        host.querySelector('#form-error')?.textContent === 'Keep this draft',
      'custom editor submissions retain drafts and render reactive errors',
    );
    host.querySelector('#editor').close();
    await flush();
    check(
      !host.querySelector('#editor')?.open &&
        state.editorDialog === undefined &&
        !host.querySelector('[name="probe"]'),
      'native dialog close disposes its snapshot and controller state',
    );
    openDialog('broken.probe');
    await flush();
    check(
      host.querySelector('#editor')?.open &&
        host.querySelector('#editor-title')?.textContent === 'Dialog unavailable' &&
        host.querySelector('#editor [data-error-boundary]')?.getAttribute('role') === 'alert' &&
        host.querySelector('#planning-frame, #page-root'),
      'a failing dialog renders its fallback inside the dialog only',
    );
    host.querySelector('#dismiss').click();
    await flush();
    check(
      !host.querySelector('#editor')?.open && state.editorDialog === undefined,
      'a failed dialog can still be dismissed',
    );
    setState({ board: previousBoard });
    setState({ undoOffer: [{}], undoText: 'Moved sample item' });
    await flush();
    check(
      !host.querySelector('#undo-bar')?.hidden &&
        host.querySelector('#undo-text')?.textContent === 'Moved sample item' &&
        host.querySelector('#undo-bar')?.getAttribute('aria-live') === 'polite',
      'undo notice is a store-driven polite live region',
    );
    setState({ undoOffer: undefined, undoText: '' });
    const appListeners = [];
    const addListener = document.addEventListener;
    const removeListener = document.removeEventListener;
    document.addEventListener = function (type, listener, options) {
      appListeners.push(type);
      return addListener.call(this, type, listener, options);
    };
    document.removeEventListener = function (type, listener, options) {
      const index = appListeners.indexOf(type);
      if (index >= 0) appListeners.splice(index, 1);
      return removeListener.call(this, type, listener, options);
    };
    try {
      unmount(host);
      renderIsland(host, html`<${App} dialogs=${dialogs} />`);
      await flush();
      check(
        appListeners.filter((type) => type === 'keydown').length === 2 &&
          appListeners.includes('visibilitychange') &&
          appListeners.includes('drop'),
        'App effects install the shortcut, clock and file-drop listeners',
      );
      unmount(host);
      check(!appListeners.length, 'unmounting the App removes every document listener');
    } finally {
      document.addEventListener = addListener;
      document.removeEventListener = removeListener;
    }
    setState({ board: previousBoard, workspaceGate: previousGate, view: previousView });
    // Failures outside rendering reach the error bar; cancelled work and
    // browser notices without an exception stay silent.
    renderIsland(host, html`<${App} dialogs=${dialogs} />`);
    await flush();
    const errorBar = () => {
      const bar = host.querySelector('#error-bar');
      return bar.hidden ? '' : bar.textContent;
    };
    const rejectUnhandled = (reason) => {
      const promise = Promise.reject(reason);
      promise.catch(() => {});
      window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise, reason }));
    };
    rejectUnhandled(new DOMException('Aborted', 'AbortError'));
    await flush();
    check(!errorBar(), 'an aborted fire-and-forget action stays silent');
    rejectUnhandled(new Error('Background action failed'));
    await flush();
    check(
      errorBar().includes('Background action failed'),
      'an unhandled rejection reaches the error bar',
    );
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('Handler failed') }));
    await flush();
    check(errorBar().includes('Handler failed'), 'a throwing event handler reaches the error bar');
    setState({ errorText: '' });
    window.dispatchEvent(new ErrorEvent('error', { message: 'ResizeObserver loop completed' }));
    await flush();
    check(!errorBar(), 'an error event without an exception stays silent');
    // A render failure outside the inner boundaries replaces the shell and
    // stops its effects, leaving a Reload notice.
    const previousWorkspaces = state.workspaces;
    setState({ workspaces: null });
    await flush();
    const shellFailure = host.querySelector('[data-error-boundary]');
    check(
      shellFailure?.getAttribute('role') === 'alert' &&
        shellFailure.querySelector('button')?.textContent === 'Reload' &&
        !host.querySelector('.sidebar'),
      'a shell render failure replaces the page with a Reload notice',
    );
    rejectUnhandled(new Error('After the shell failed'));
    await flush();
    check(!state.errorText, 'a failed shell no longer reports into the removed error bar');
    unmount(host);
    setState({ workspaces: previousWorkspaces });

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
    setState({ probeCount: 2 });
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
    unmount(host);
    check(requestSignals[1].aborted, 'request cleanup aborts work on unmount');

    let mutationSignal;
    let runMutation;
    function MutationProbe() {
      const { run, pending } = useMutation();
      runMutation = run;
      return html`<span>${pending ? 'Saving' : 'Idle'}</span>`;
    }
    renderIsland(host, html`<${MutationProbe} key="one" />`);
    const firstWrite = runMutation(
      (signal) =>
        new Promise((_resolve, reject) => {
          mutationSignal = signal;
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const secondWrite = await runMutation(() => Promise.resolve('second'));
    await flush();
    check(
      host.textContent === 'Saving' && secondWrite === undefined,
      'a pending mutation refuses a second submission',
    );
    renderIsland(host, html`<${MutationProbe} key="two" />`);
    await firstWrite.catch(() => {});
    check(mutationSignal.aborted, 'remounting a keyed component aborts its pending write');
    unmount(host);
    const upload = new AbortController();
    const uploading = apiUpload('/upload-probe', { body: new FormData(), signal: upload.signal });
    upload.abort();
    const uploadError = await uploading.catch((error) => error);
    check(uploadError?.name === 'AbortError', 'apiUpload aborts its request with the signal');

    let keyed = 0;
    function ListenerProbe({ active }) {
      useEventListener(document, 'keyup', () => keyed++, { active });
      return null;
    }
    renderIsland(host, html`<${ListenerProbe} active=${true} />`);
    document.dispatchEvent(new KeyboardEvent('keyup'));
    renderIsland(host, html`<${ListenerProbe} active=${false} />`);
    document.dispatchEvent(new KeyboardEvent('keyup'));
    renderIsland(host, html`<${ListenerProbe} active=${true} />`);
    unmount(host);
    document.dispatchEvent(new KeyboardEvent('keyup'));
    check(keyed === 1, 'event listener effects follow active state and clean up on unmount');

    function FocusProbe({ column }) {
      const ref = useRef(null);
      const focus = useFocusRestore(ref, 'probe');
      return html`<div ref=${ref} ...${focus}>
        ${['left', 'right'].map(
          (name) => html`<section key=${name} data-column=${name}>
            ${column === name ? html`<button key="card" data-focus-key="probe:card">Card</button>` : null}
          </section>`,
        )}
      </div>`;
    }
    renderIsland(host, html`<${FocusProbe} column="left" />`);
    host.querySelector('[data-focus-key="probe:card"]').focus();
    renderIsland(host, html`<${FocusProbe} column="right" />`);
    const movedCard = host.querySelector('[data-focus-key="probe:card"]');
    check(
      movedCard.closest('section').dataset.column === 'right' &&
        document.activeElement === movedCard,
      'focus follows a keyed control recreated in another parent',
    );
    unmount(host);

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
    unmount(host);
    renderIsland(host, html`<${DismissProbe} />`);
    await flush();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    check(dismissed === 2 && !host.children.length, 'useDismiss handles Escape');
    unmount(host);
    outside.remove();

    renderIsland(host, html`<button disabled=${true}>Write</button>`);
    check(host.firstElementChild.disabled, 'Preact applies disabled state from props');
    renderIsland(host, html`<button disabled=${false}>Write</button>`);
    check(!host.firstElementChild.disabled, 'Preact updates disabled state from props');
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
      let changedValues;
      let selectOne;
      renderIsland(
        host,
        html`<${MultiSelect}
          name="labels"
          title="Labels"
          entries=${[['one', 'One'], ['two', 'Two']]}
          single=${true}
          headingAction=${({ select }) => {
            selectOne = select;
            return null;
          }}
          onChange=${(values) => {
            changedValues = values;
          }}
        />`,
      );
      selectOne('two');
      await flush();
      check(
        changedValues?.[0] === 'two' &&
          host.querySelector('input[value="two"]').checked &&
          host.querySelector('.multi-select-chip')?.textContent.includes('Two'),
        'heading actions select through the picker and report committed values',
      );
      host.querySelector('[data-multi-edit]').click();
      await flush();
      check(listeners.size === 1, 'picker registers its outside listener');
      const checkbox = host.querySelector('input[type="checkbox"]');
      checkbox.click();
      await flush();
      check(
        checkbox.checked &&
          changedValues?.length === 1 &&
          changedValues[0] === 'one' &&
          !host.querySelector('input[value="two"]').checked,
        'native checkbox selection updates component state and reports its value',
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
    return 'escaping, keyed identity/focus, events, native forms, lifecycle and listener cleanup, error boundaries, request and mutation cancellation, focus restore, dialog snapshots and permission updates';
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
