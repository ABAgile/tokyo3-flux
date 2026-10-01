// App-owned renderer and component-lifetime checks against a fresh seeded app.
// Synthetic records stay in this page; the final editor save changes only a
// seeded disposable item to verify post-save controller replacement.
// biome-ignore lint/correctness/noUnusedVariables: Playwright run-code invokes this function.
async function run(page) {
  await page.waitForFunction(() => document.querySelector('.board .card'));
  const result = await page.evaluate(async () => {
    const { state, setState } = await import('/modules/state.js');
    const original = state.board;
    const originalView = state.view;
    const originalLists = state.attachmentLists;
    const body = document.getElementById('planning-body');
    const check = (ok, message) => {
      if (!ok) throw new Error(message);
    };
    // Store updates render on the next microtask; native toggle events are tasks.
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const renderedID = body.querySelector('.card')?.dataset.item;
    const item = original.items.find((value) => value.id === renderedID);
    const columns = original.columns;
    check(item && columns.length > 1, 'fixture needs an active item and two columns');
    const draft = { ...item, column_id: columns[0].id, attachment_count: 1 };
    try {
      setState({
        board: { ...original, items: [draft] },
        attachmentLists: {
          [item.id]: [
            {
              id: 123,
              item_id: item.id,
              name: 'fixture.txt',
              size: 12,
              content_type: 'text/plain',
            },
          ],
        },
      });
      await flush();
      let card = body.querySelector('.card');
      const title = card.querySelector('.card-title');
      const attachments = card.querySelector('.card-attachments');
      attachments.open = true;
      title.focus();
      await flush();
      setState({ board: { ...state.board } });
      await flush();
      check(body.querySelector('.card') === card, 'unchanged refresh retains card identity');
      check(
        document.activeElement === title && attachments.open,
        'refresh preserves focus and disclosure',
      );
      const moved = { ...draft, title: 'Current title', column_id: columns[1].id };
      setState({ board: { ...state.board, items: [moved] } });
      await flush();
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
      const boardRoot = body.firstElementChild;
      setState({ view: 'projects' });
      await flush();
      check(
        document.getElementById('planning-frame').hidden && body.firstElementChild === boardRoot,
        'the inactive planning frame retains its App-owned content',
      );
      setState({ view: 'board' });
      await flush();
      check(body.firstElementChild === boardRoot, 'returning to the board retains its root');
    } finally {
      setState({ board: original, view: originalView, attachmentLists: originalLists });
      await flush();
    }
    return 'keyed refresh identity, cross-column focus/disclosure, current props and persistent App-owned planning content';
  });
  await page.locator('#presentation-list').click();
  await page.locator('.list-row-title').first().click();
  const pane = page.locator('.item-detail-pane');
  const detailTitle = pane.getByLabel('Title', { exact: true });
  await detailTitle.fill('Draft survives a board update');
  await page.evaluate(async () => {
    const { state, setState } = await import('/modules/state.js');
    setState({ board: { ...state.board } });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  if ((await detailTitle.inputValue()) !== 'Draft survives a board update')
    throw new Error('Board update reset the detail editor draft');
  await detailTitle.fill('Renderer detail-save regression');
  await pane.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.item-detail-pane')?.hidden);
  if (
    !(await page.locator('.list-row-title', { hasText: 'Renderer detail-save regression' }).count())
  )
    throw new Error('Saving the detail pane did not close it with the saved title in its row');
  return `PASS: ${result}, detail save closing the pane.`;
}
