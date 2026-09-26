// Renderer ownership regression checks against a fresh seeded disposable app.
// Synthetic records stay in this page; the final editor save changes only a
// seeded disposable item to verify post-save controller replacement.
// biome-ignore lint/correctness/noUnusedVariables: Playwright run-code invokes this function.
async function run(page) {
  await page.waitForFunction(() => document.querySelector('.board .card'));
  const result = await page.evaluate(async () => {
    const { state } = await import('/modules/state.js');
    const { hooks } = await import('/modules/hooks.js');
    const { renderBoardContent } = await import('/modules/view-board.js');
    const { unmountIsland, replaceContent } = await import('/modules/preact.js');
    const original = state.board;
    const body = document.getElementById('planning-body');
    const check = (ok, message) => {
      if (!ok) throw new Error(message);
    };
    const item = original.items.find((value) => !value.archived);
    const columns = original.columns;
    check(item && columns.length > 1, 'fixture needs an active item and two columns');
    const draft = {
      ...item,
      column_id: columns[0].id,
      attachments: [
        { id: 123, item_id: item.id, name: 'fixture.txt', size: 12, content_type: 'text/plain' },
      ],
    };
    try {
      state.board = { ...original, items: [draft] };
      renderBoardContent(body, [draft]);
      let card = body.querySelector('.card');
      const title = card.querySelector('.card-title');
      const attachments = card.querySelector('.card-attachments');
      attachments.open = true;
      title.focus();
      renderBoardContent(body, [draft]);
      check(body.querySelector('.card') === card, 'unchanged refresh retains card identity');
      check(
        document.activeElement === title && attachments.open,
        'refresh preserves focus and disclosure',
      );
      const moved = { ...draft, title: 'Current title', column_id: columns[1].id };
      state.board = { ...state.board, items: [moved] };
      renderBoardContent(body, [moved]);
      card = body.querySelector('.card');
      check(
        card.closest('.column').dataset.column === columns[1].id,
        'card moves between keyed parents',
      );
      check(
        document.activeElement === card.querySelector('.card-title'),
        'cross-column move restores logical focus',
      );
      check(
        card.querySelector('.card-attachments').open,
        'cross-column move preserves attachment disclosure',
      );
      check(
        card.querySelector('.card-title').textContent === moved.title,
        'retained render uses current data',
      );
      // No old root may remain active after the host is discarded.
      unmountIsland(body);
      check(!body.querySelector('.card'), 'board root disposal clears its subtree');
    } finally {
      replaceContent(body);
      state.board = original;
      hooks.render();
    }
    return 'keyed refresh identity, cross-column focus/disclosure, current props and root disposal';
  });
  await page.locator('#presentation-list').click();
  await page.locator('.list-row-title').first().click();
  const pane = page.locator('.item-detail-pane');
  await pane.getByLabel('Title', { exact: true }).fill('Renderer detail-save regression');
  await pane.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector('.item-detail-title')
      ?.textContent.includes('Renderer detail-save regression'),
  );
  const help = pane.getByRole('button', { name: 'Help: Work item details', exact: true });
  await help.click();
  const revision = await page.evaluate(async () => {
    const { state } = await import('/modules/state.js');
    return state.detailState.item.revision;
  });
  if (
    !(await pane.locator('.item-detail-title .help-popover-content').textContent()).includes(
      `Revision: ${revision}`,
    )
  )
    throw new Error('Saved detail header did not retain a fresh revision popover');
  return `PASS: ${result}, saved detail header and revision popover.`;
}
