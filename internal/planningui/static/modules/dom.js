// Small markup helpers shared by component templates. Element ids for
// controls that need one come from Preact's useId in the owning component: the
// item editor and the detail pane can render the same control at once, so a
// fixed id would be duplicated.
/** @param {Record<string, unknown>} classes */
function classNames(classes) {
  return Object.keys(classes)
    .filter((name) => classes[name])
    .join(' ');
}

export { classNames };
