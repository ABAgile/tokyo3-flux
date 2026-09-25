// Late-bound calls from feature modules up to the shell. app.js fills these in
// before any module function can run, so no module imports app.js and lower
// modules never import the views above them.
export const hooks = {
  persistPlanningURL: undefined,
  placeFilters: undefined,
  render: undefined,
  renderContent: undefined,
  resetBurndown: undefined,
};
