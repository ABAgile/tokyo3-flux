// Execute with playwright-browser run-code on an EMPTY disposable workspace.
// biome-ignore lint/correctness/noUnusedVariables: Playwright run-code invokes this function.
async function run(page) {
  page.setDefaultTimeout(10000);
  // Keep both drop targets visible; avoid testing browser auto-scroll geometry.
  await page.setViewportSize({ width: 1440, height: 1800 });
  const check = (ok, message) => {
    if (!ok) throw new Error(message);
  };
  const saved = async () => {
    await page.getByRole('status').filter({ hasText: 'Changes saved.' }).waitFor();
  };
  const save = async () => {
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await saved();
  };
  const chooseMulti = async (name, values) => {
    await page.getByRole('button', { name: `Edit ${name}`, exact: true }).click();
    for (const value of values)
      await page.getByRole('checkbox', { name: value, exact: true }).check();
    await page.keyboard.press('Escape');
  };
  const nav = async (name) => {
    await page.getByRole('navigation').getByRole('button', { name }).click();
  };
  const board = () =>
    page.evaluate(async () =>
      (
        await fetch(`/api/v2/workspaces/${document.querySelector('#workspace').value}/board`)
      ).json(),
    );
  const drag = async (source, target, position) => {
    await source.dragTo(target, { targetPosition: position });
  };
  await page.getByRole('heading', { name: 'Kanban board', exact: true }).waitFor();
  check((await board()).items.length === 0, 'requires an empty test workspace');
  for (const name of ['Bug', 'Delivery']) {
    await nav('Labels');
    await page.getByRole('button', { name: '＋ New label', exact: true }).click();
    await page.getByLabel('Label name', { exact: true }).fill(name);
    await save();
  }
  await nav('Members');
  await page.getByRole('heading', { name: 'Members', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Edit member', exact: true }).click();
  await page.getByLabel('Workspace name', { exact: true }).fill('Alex Planner');
  await page.getByRole('button', { name: 'Save member', exact: true }).click();
  await saved();
  await nav('Kanban board');
  await page.getByRole('combobox', { name: 'Scope', exact: true }).selectOption('all');
  for (const name of ['Drag first', 'Drag second']) {
    await page.getByRole('button', { name: '＋ New item', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill(name);
    await chooseMulti('Assignee', ['Alex Planner']);
    await chooseMulti('Labels', ['Bug', 'Delivery']);
    await save();
  }
  const initial = await board();
  const first = initial.items[0],
    second = initial.items[1];
  const ready = initial.columns[0],
    doing = initial.columns[1];
  const card = (id) => page.locator(`[data-item="${id}"]`);
  const column = (id) => page.locator(`[data-column="${id}"]`);
  const handle = (id) => card(id);
  check(
    // Cards name people through the participant stack's accessible labels.
    (await card(first.id)
      .getByRole('img', { name: 'Alex Planner · Assignee', exact: true })
      .count()) === 1,
    'raw subject shown instead of name',
  );
  await page
    .getByRole('combobox', { name: 'Assignee', exact: true })
    .selectOption({ label: 'Alex Planner' });
  check(
    (await page.getByRole('button', { name: 'Drag first', exact: true }).count()) === 1,
    'assignee filter hid assigned work',
  );
  await page.getByRole('combobox', { name: 'Assignee', exact: true }).selectOption('none');
  check(
    (await page.getByRole('button', { name: 'Drag first', exact: true }).count()) === 0,
    'unassigned assignee filter showed assigned work',
  );
  await page.getByRole('combobox', { name: 'Assignee', exact: true }).selectOption('all');
  await drag(handle(second.id), card(first.id), { x: 16, y: 8 });
  await saved();
  check((await board()).items[0].id === second.id, 'card before-drop did not reorder');
  let box = await card(first.id).boundingBox();
  await drag(handle(second.id), card(first.id), { x: 16, y: box.height - 8 });
  await saved();
  check((await board()).items[0].id === first.id, 'card after-drop did not reorder');
  await drag(handle(first.id), column(doing.id), { x: 16, y: 100 });
  await saved();
  check(
    (await board()).items.find((i) => i.id === first.id).column_id === doing.id,
    'cross-list drop failed',
  );
  // The card menu moves a card without dragging: Move to opens a cascade of
  // columns and then Top or Bottom of the chosen one, the card's own column is
  // listed but unavailable, and the keyboard reaches it all and gives focus back
  // to the button.
  const menuButton = card(first.id).getByRole('button', { name: /^Actions for/ });
  const inColumn = async (id, columnID) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await board()).items.find((i) => i.id === id).column_id === columnID) return true;
      await page.waitForTimeout(100);
    }
    return false;
  };
  await menuButton.click();
  await page.getByRole('menuitem', { name: 'Move to' }).click();
  const cascade = page.getByRole('menu', { name: 'Move to', exact: true });
  const leading = cascade.getByRole('menuitem').first();
  check(
    (await leading.innerText()).startsWith(doing.name) &&
      (await leading.getAttribute('aria-disabled')) === 'true' &&
      (await leading.evaluate((e) => e.nextElementSibling?.getAttribute('role'))) === 'separator',
    "the card's own column does not lead the Move to list as an unavailable heading above a divider",
  );
  // Resting the pointer on a column opens its Top and Bottom without a click,
  // and leaves keyboard focus where it was; Bottom is the column's end.
  await page.getByRole('menuitem', { name: ready.name, exact: true }).hover();
  await page.getByRole('menuitem', { name: 'Top', exact: true }).waitFor();
  check(
    await page.evaluate(() => !document.activeElement.closest('[aria-label^="Position in"]')),
    'opening Top and Bottom by hover moved keyboard focus into them',
  );
  await page.getByRole('menuitem', { name: 'Bottom', exact: true }).click();
  check(await inColumn(first.id, ready.id), 'Move to did not move the card');
  check(
    (await column(ready.id).locator('.card').last().getAttribute('data-item')) === first.id,
    'Bottom did not put the card last in the column',
  );
  check((await page.locator('.card-menu').count()) === 0, 'the menu stayed open after a move');
  await menuButton.click();
  await page.getByRole('menuitem', { name: 'Move to' }).click();
  await page.getByRole('menuitem', { name: doing.name, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Top', exact: true }).click();
  check(await inColumn(first.id, doing.id), 'Move to did not move the card back');
  check(
    (await column(doing.id).locator('.card').first().getAttribute('data-item')) === first.id,
    'Top did not put the card first in the column',
  );
  await menuButton.focus();
  await page.keyboard.press('Enter');
  check(
    await page
      .getByRole('menuitem', { name: 'Copy link', exact: true })
      .evaluate((e) => e === document.activeElement),
    'opening the card menu by keyboard did not focus its first item',
  );
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  check(
    await page
      .getByRole('menuitem', { name: ready.name, exact: true })
      .evaluate((e) => e === document.activeElement),
    'ArrowRight did not open the cascade on the first available column',
  );
  await page.keyboard.press('ArrowRight');
  check(
    await page
      .getByRole('menuitem', { name: 'Top', exact: true })
      .evaluate((e) => e === document.activeElement),
    'ArrowRight on a column did not open its Top and Bottom on Top',
  );
  await page.keyboard.press('ArrowLeft');
  check(
    await page
      .getByRole('menuitem', { name: ready.name, exact: true })
      .evaluate((e) => e === document.activeElement),
    'ArrowLeft in Top and Bottom did not return to its column',
  );
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Escape');
  check(
    (await page.locator('.card-menu').count()) === 0 &&
      (await menuButton.evaluate((e) => e === document.activeElement)),
    'Escape did not close the card menu and return focus to its button',
  );
  // Set a real WIP policy and verify that rejected drops never move local cards.
  await page.getByRole('button', { name: 'Board setup', exact: true }).click();
  await page
    .locator('.setup-row')
    .filter({ has: page.getByText(doing.name, { exact: true }) })
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  await page.getByLabel('WIP limit · 0 means unlimited').fill('1');
  await save();
  await drag(handle(second.id), column(doing.id).locator('.column-head'), { x: 16, y: 8 });
  await page.getByRole('alert').filter({ hasText: 'WIP limit' }).waitFor();
  check(
    (await column(ready.id).locator(`[data-item="${second.id}"]`).count()) === 1,
    'rejected drop rearranged local card',
  );
  check(
    (await board()).items.find((i) => i.id === second.id).column_id === ready.id,
    'WIP drop persisted',
  );
  await drag(column(doing.id).locator('.column-head'), column(ready.id), { x: 8, y: 16 });
  await saved();
  check((await board()).columns[0].id === doing.id, 'list before-drop failed');
  box = await column(ready.id).boundingBox();
  await drag(column(doing.id).locator('.column-head'), column(ready.id), {
    x: box.width - 8,
    y: 16,
  });
  await saved();
  check((await board()).columns[0].id === ready.id, 'list after-drop failed');
  await page.reload();
  await page.getByRole('combobox', { name: 'Scope', exact: true }).selectOption('all');
  await page.getByRole('button', { name: 'Drag first', exact: true }).waitFor();
  check(
    (await column(doing.id).locator(`[data-item="${first.id}"]`).count()) === 1,
    'drop did not survive reload',
  );
  check((await card(first.id).getAttribute('draggable')) === 'true', 'card body is not draggable');
  check(
    (await column(doing.id).locator('.column-head').getAttribute('draggable')) === 'true',
    'column header is not draggable',
  );
  // Project filtering changes visibility, never project classification or order.
  await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('none');
  await drag(handle(first.id), card(second.id), { x: 16, y: 8 });
  await saved();
  check(
    (await board()).items.every((i) => i.project_id === ''),
    'project selection drop changed classification',
  );
  await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('all');
  // A drop begun against stale data must conflict, not overwrite another tab.
  const other = await page.context().newPage();
  await other.goto(page.url());
  await other.getByRole('button', { name: 'Drag first', exact: true }).click();
  await other.getByLabel('Title', { exact: true }).fill('Drag first updated');
  await other.getByRole('button', { name: 'Save changes', exact: true }).click();
  await other.getByRole('status').filter({ hasText: 'Changes saved.' }).waitFor();
  await other.close();
  await drag(handle(second.id), column(doing.id), { x: 16, y: 100 });
  await page.getByRole('alert').filter({ hasText: 'planning changed' }).waitFor();
  check(
    (await board()).items.find((i) => i.id === second.id).column_id === ready.id,
    'stale drop persisted',
  );
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: 'Drag first updated', exact: true }).waitFor();
  await page.waitForFunction(() => {
    const refresh = document.querySelector('#refresh');
    const editor = document.querySelector('#editor');
    const form = editor?.querySelector('#editor-form');
    return (
      refresh &&
      !refresh.disabled &&
      editor &&
      !editor.open &&
      // A closed dialog renders no dialog content at all.
      !form
    );
  });
  // Rename applies to existing assignments; archive then delete also updates archived work.
  await nav('Labels');
  await page
    .locator('.setup-row')
    .filter({ has: page.getByText('Bug', { exact: true }) })
    .getByRole('button', { name: 'Rename', exact: true })
    .click();
  await page.getByLabel('Label name', { exact: true }).fill('Defect');
  await save();
  check(
    (await board()).items.every((i) => i.labels.includes('Defect') && !i.labels.includes('Bug')),
    'rename lost assignments',
  );
  await nav('Kanban board');
  await page.getByRole('button', { name: 'Drag first updated', exact: true }).click();
  check(
    (await page
      .getByRole('group', { name: 'Labels', exact: true })
      .locator('.multi-select-chip')
      .count()) === 2,
    'multi-selection not preserved',
  );
  await page.getByRole('button', { name: 'Archive item', exact: true }).click();
  await page.getByRole('button', { name: 'Archive item', exact: true }).click();
  await saved();
  await nav('Labels');
  await page
    .locator('.setup-row')
    .filter({ has: page.getByText('Defect', { exact: true }) })
    .getByRole('button', { name: 'Delete…', exact: true })
    .click();
  await page.getByRole('button', { name: 'Delete label', exact: true }).click();
  await saved();
  check(
    (await board()).items.every((i) => !i.labels.includes('Defect')),
    'delete retained archived assignment',
  );
  await nav('Kanban board');
  await page.getByRole('button', { name: 'Drag second', exact: true }).click();
  // Chips become removable once the field is in edit mode.
  await page.getByRole('button', { name: 'Edit Labels', exact: true }).click();
  await page
    .getByRole('group', { name: 'Labels', exact: true })
    .getByRole('button', { name: 'Remove Delivery', exact: true })
    .click();
  await save();
  check(
    (await board()).items.find((i) => i.id === second.id).labels.length === 0,
    'cannot clear labels',
  );
  // While a card is dragged, holding near the edge of the board scrolls it
  // sideways, even through the board's scroll snapping, and releasing stops it.
  await page.setViewportSize({ width: 390, height: 900 });
  const edgeScroll = await page.evaluate(async () => {
    const { setState } = await import('/modules/state.js');
    const board = document.querySelector('.board');
    board.scrollLeft = 0;
    board.scrollIntoView({ block: 'start' });
    const box = board.getBoundingClientRect();
    const hold = async (x, rounds) => {
      for (let i = 0; i < rounds; i++) {
        document.dispatchEvent(
          new DragEvent('dragover', {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: box.top + 60,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    setState({ dragging: true });
    await hold(box.right - 6, 8);
    const afterRight = board.scrollLeft;
    await hold(box.left + box.width / 2, 4);
    const inMiddle = board.scrollLeft;
    await hold(box.left + 6, 8);
    const afterLeft = board.scrollLeft;
    setState({ dragging: false });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterEnd = board.scrollLeft;
    await new Promise((resolve) => setTimeout(resolve, 300));
    return {
      room: board.scrollWidth - board.clientWidth,
      afterRight,
      inMiddle,
      afterLeft,
      stopped: board.scrollLeft === afterEnd,
      snap: board.style.scrollSnapType,
    };
  });
  check(edgeScroll.room > 100, 'the board does not scroll sideways at phone width');
  check(edgeScroll.afterRight > 100, 'dragging to the right edge did not scroll the board');
  check(
    edgeScroll.inMiddle === edgeScroll.afterRight,
    'the board scrolled with the pointer in its middle',
  );
  check(
    edgeScroll.afterLeft < edgeScroll.afterRight,
    'dragging to the left edge did not scroll back',
  );
  check(
    edgeScroll.stopped && edgeScroll.snap === '',
    'edge scrolling continued or kept snapping off after the drag',
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Check viewer affordances independently of the backend authorization tests.
  await page.route('**/board', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.role = 'viewer';
    await route.fulfill({ response, json: data });
  });
  await page.reload();
  await page.getByRole('combobox', { name: 'Scope', exact: true }).selectOption('all');
  await page.getByRole('button', { name: 'Drag second', exact: true }).waitFor();
  check(
    (await card(second.id)
      .getByRole('button', { name: /^Drag card/ })
      .count()) === 0,
    'explicit card drag handle remains',
  );
  check((await card(second.id).getAttribute('draggable')) === 'false', 'viewer draggable');
  check(
    (await column(doing.id).locator('.column-head').getAttribute('draggable')) === 'false',
    'viewer column draggable',
  );
  await nav('Labels');
  check(
    await page.getByRole('button', { name: '＋ New label', exact: true }).isDisabled(),
    'viewer label creation enabled',
  );
  await nav('Kanban board');
  await page.unroute('**/board');
  await page.reload();
  await page.getByRole('combobox', { name: 'Scope', exact: true }).selectOption('all');
  await page.getByRole('button', { name: 'Drag second', exact: true }).waitFor();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      check(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `overflow ${theme} ${width}`,
      );
      await page.getByRole('button', { name: 'Drag second', exact: true }).focus();
      await page.keyboard.press('Enter');
      const editLabels = page.getByRole('button', { name: 'Edit Labels', exact: true });
      await editLabels.focus();
      await page.keyboard.press('Enter');
      const delivery = page.getByRole('checkbox', { name: 'Delivery', exact: true });
      await delivery.focus();
      await page.keyboard.press('Space');
      check(
        await page.evaluate(() =>
          document.querySelector('dialog').contains(document.activeElement),
        ),
        'label keyboard focus',
      );
      await page.keyboard.press('Escape');
      check(
        await editLabels.evaluate((e) => e === document.activeElement),
        'multi-select focus return',
      );
      // The label toggled above is unsaved input, so Cancel asks before discarding.
      await page.evaluate(() => {
        window.confirm = () => true;
      });
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      check(
        await page
          .getByRole('button', { name: 'Drag second', exact: true })
          .evaluate((e) => e === document.activeElement),
        'editor focus return',
      );
    }
  }
  return 'PASS: implicit card/header before/after drops, cross-list and filtered movement, WIP/stale rejection, persistence, display names, label CRUD/multi-select/archive propagation, viewer controls, responsive keyboard workflows.';
}
