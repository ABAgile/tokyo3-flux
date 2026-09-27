// Board rendering probe. Execute with playwright-cli run-code (use --raw) against a
// FRESH seeded disposable workspace; never use team data. It clones the seeded
// items into a synthetic board of several sizes in the page only (nothing is
// written to the server) and times the App-owned board render path:
//   first    new workspace identity, then renderContent (build from scratch)
//   same     renderContent again with unchanged data (a refresh or poll)
//   one      renderContent after one item's title changed (a typical write)
// Each time includes the forced style and layout that follows, and "nodes"
// counts distinct elements inserted into the board by that render, moves
// included (DOM churn).
// Results are medians of several runs, in milliseconds; compare runs on the
// same machine only.
// biome-ignore lint/correctness/noUnusedVariables: Playwright run-code invokes this function.
async function run(page) {
  page.setDefaultTimeout(30000);
  await page.waitForFunction(() => document.querySelector('#planning-body .board .card'));
  return page.evaluate(async () => {
    const { state } = await import('/modules/state.js');
    const { hooks } = await import('/modules/hooks.js');
    const body = document.getElementById('planning-body');
    const seeded = state.board.items.filter((item) => !item.archived);
    const seededParticipants = state.board.participants || [];
    const seededLinks = state.board.links.map((link) => ({ ...link, items: [...link.items] }));
    document.getElementById('scope').value = 'all';
    const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const measure = (prepare) => {
      const observer = new MutationObserver(() => {});
      observer.observe(body, { childList: true, subtree: true });
      prepare?.();
      const start = performance.now();
      hooks.renderContent();
      void body.offsetHeight;
      const time = performance.now() - start;
      const inserted = new Set();
      for (const record of observer.takeRecords())
        for (const node of record.addedNodes)
          if (node.nodeType === Node.ELEMENT_NODE)
            for (const element of [node, ...node.querySelectorAll('*')]) inserted.add(element);
      observer.disconnect();
      return { time, added: inserted.size };
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
        const first = measure(() => {
          state.board.workspace = {
            ...state.board.workspace,
            id: `performance-${size}-${round}`,
          };
          state.board.items = items;
          state.board.participants = participants;
          state.board.links = links;
        });
        const same = measure();
        const one = measure(() => {
          const index = (round * 37) % items.length;
          items[index] = { ...items[index], title: `${items[index].title} *` };
        });
        runs.first.push(first);
        runs.same.push(same);
        runs.one.push(one);
      }
      results[size] = Object.fromEntries(
        Object.entries(runs).map(([name, values]) => [
          name,
          {
            ms: Number(median(values.map((value) => value.time)).toFixed(1)),
            nodes: median(values.map((value) => value.added)),
          },
        ]),
      );
    }
    return JSON.stringify({ cards: document.querySelectorAll('.card').length, results });
  });
}
