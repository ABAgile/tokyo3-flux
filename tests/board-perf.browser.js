// Board rendering probe. Execute with playwright-cli run-code (use --raw) against a
// FRESH seeded disposable workspace; never use team data. It clones the seeded
// items into a synthetic board of several sizes in the page only (nothing is
// written to the server) and times the store-driven board render path:
//   first    a board with a new workspace identity (build from scratch)
//   same     a new board object with unchanged entities (a merged refresh)
//   one      a board where one item's title changed (a typical write)
// and, on that board, interactions driven through DOM events so any renderer
// revision can be measured with the same probe:
//   search       one keystroke in the search field, before its debounce
//   dragover     one drag-over mark change during a sweep across cards
//   hover        one attachment tooltip shown or hidden on a card tile
//   attachments  one card's attachment list arriving in the store
// Preact's render batch is captured and run synchronously inside the timing.
// Each time includes the forced style and layout that follows, and "nodes"
// counts distinct elements inserted into the board by that render, moves
// included (DOM churn). Interaction times also include the event dispatch and
// the store notification it causes, because that fan-out is what they measure.
// Results are medians of several runs, in milliseconds; compare runs on the
// same machine only.
// biome-ignore lint/correctness/noUnusedVariables: Playwright run-code invokes this function.
async function run(page) {
  page.setDefaultTimeout(30000);
  await page.waitForFunction(() => document.querySelector('#planning-body .board .card'));
  return page.evaluate(async () => {
    const { state, setState } = await import('/modules/state.js');
    const { options } = await import('/modules/vendor-preact.js');
    const body = document.getElementById('planning-body');
    const seeded = state.board.items.filter((item) => !item.archived);
    const seededParticipants = state.board.participants || [];
    const seededLinks = state.board.links.map((link) => ({ ...link, items: [...link.items] }));
    // Every synthetic card is shown, whatever sprint its seed belongs to.
    setState({ scope: 'all' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const measure = (update, includeUpdate = false) => {
      const observer = new MutationObserver(() => {});
      observer.observe(body, { childList: true, subtree: true });
      const scheduled = options.debounceRendering;
      let render;
      options.debounceRendering = (callback) => {
        render = callback;
      };
      const before = performance.now();
      try {
        update();
      } finally {
        options.debounceRendering = scheduled;
      }
      const start = includeUpdate ? before : performance.now();
      render?.();
      void body.offsetHeight;
      const time = performance.now() - start;
      const inserted = new Set();
      for (const record of observer.takeRecords())
        for (const node of record.addedNodes)
          if (node.nodeType === Node.ELEMENT_NODE)
            for (const element of [node, ...node.querySelectorAll('*')]) inserted.add(element);
      observer.disconnect();
      return { time, added: inserted.size, rendered: !!render };
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const attachment = (itemID, id) => ({
      id,
      item_id: itemID,
      name: `probe-${id}.txt`,
      content_type: 'text/plain',
      size: 1,
      digest: `sha256:${'0'.repeat(64)}`,
      uploader: 'probe',
      created_at: new Date(0).toISOString(),
    });
    const interactions = async (size) => {
      const cards = [...body.querySelectorAll('.board .card')];
      const runs = { search: [], dragover: [], hover: [], attachments: [] };
      // Keystrokes stay within one debounce window; the field is cleared after.
      const search = document.getElementById('search');
      for (let i = 0; i < 7; i++)
        runs.search.push(
          measure(() => {
            search.value = i % 2 ? 'zq' : 'z';
            search.dispatchEvent(new Event('input', { bubbles: true }));
          }, true),
        );
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      // One drag from the first card, marking each following card in turn.
      const transfer = new DataTransfer();
      const drag = (type, node, init = {}) =>
        node.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer, ...init }),
        );
      drag('dragstart', cards[0]);
      await settle();
      for (const card of cards.slice(1, 41)) {
        const box = card.getBoundingClientRect();
        runs.dragover.push(
          measure(
            () => drag('dragover', card, { clientX: box.left + 2, clientY: box.top + 2 }),
            true,
          ),
        );
      }
      drag('dragend', cards[0]);
      await settle();
      // Ten cards with an open attachment disclosure provide tiles to hover.
      const withFiles = Array.from({ length: 10 }, (_, index) => cards[index].dataset.item);
      setState({
        attachmentLists: Object.fromEntries(
          withFiles.map((id, index) => [
            id,
            [attachment(id, index + 1), attachment(id, index + 101)],
          ]),
        ),
      });
      await settle();
      for (const summary of body.querySelectorAll('.card-attachments > summary')) summary.click();
      await settle();
      await settle();
      const tiles = [...body.querySelectorAll('.card-attachments[open] .attachment-tile-link')];
      for (let i = 0; i < 14; i++) {
        const tile = tiles[Math.floor(i / 2) % tiles.length];
        runs.hover.push(
          measure(
            () => tile.dispatchEvent(new PointerEvent(i % 2 ? 'pointerleave' : 'pointerenter')),
            true,
          ),
        );
      }
      for (let i = 0; i < 7; i++) {
        const id = cards[20 + i].dataset.item;
        runs.attachments.push(
          measure(
            () =>
              setState({
                attachmentLists: { ...state.attachmentLists, [id]: [attachment(id, 1000 + i)] },
              }),
            true,
          ),
        );
      }
      setState({ attachmentLists: {} });
      await settle();
      if (!tiles.length || runs.dragover.length < 40)
        throw new Error(`interaction setup failed for ${size} cards`);
      return runs;
    };
    const results = {};
    for (const size of [100, 500, 1000]) {
      const items = [];
      const participants = [];
      const links = seededLinks.map((link) => ({ ...link, items: [...link.items] }));
      for (let i = 0; i < size; i++) {
        const base = seeded[i % seeded.length];
        const id = `PERF${String(i).padStart(5, '0')}`;
        items.push({
          ...base,
          id,
          title: `${base.title} ${i}`,
          column_id: state.board.columns[i % state.board.columns.length].id,
        });
        for (const participant of seededParticipants)
          if (participant.item_id === base.id) participants.push({ ...participant, item_id: id });
        for (const link of links) if (link.items.includes(base.id)) link.items.push(id);
      }
      const runs = { first: [], same: [], one: [] };
      for (let round = 0; round < 7; round++) {
        const first = measure(() =>
          setState({
            board: {
              ...state.board,
              workspace: { ...state.board.workspace, id: `performance-${size}-${round}` },
              items,
              participants,
              links,
            },
          }),
        );
        const same = measure(() => setState({ board: { ...state.board } }));
        const one = measure(() => {
          const index = (round * 37) % items.length;
          items[index] = { ...items[index], title: `${items[index].title} *` };
          setState({ board: { ...state.board, items: [...items] } });
        });
        runs.first.push(first);
        runs.same.push(same);
        runs.one.push(one);
      }
      await settle();
      Object.assign(runs, await interactions(size));
      results[size] = Object.fromEntries(
        Object.entries(runs).map(([name, values]) => [
          name,
          {
            ms: Number(median(values.map((value) => value.time)).toFixed(1)),
            nodes: median(values.map((value) => value.added)),
            // Samples whose update scheduled a render; zero means nothing changed.
            rendered: values.filter((value) => value.rendered).length,
            samples: values.length,
          },
        ]),
      );
    }
    return JSON.stringify({ cards: document.querySelectorAll('.card').length, results });
  });
}
