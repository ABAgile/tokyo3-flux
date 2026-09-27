// Small markup helpers shared by component templates.
// Unique element ids for controls that need one but must not carry a form name:
// the item editor and the detail pane can render the same control at once, so a
// fixed id would be duplicated.
let uidSequence = 0;
function uid(prefix) {
  uidSequence += 1;
  return `${prefix}-${uidSequence}`;
}
function classNames(classes) {
  return Object.keys(classes)
    .filter((name) => classes[name])
    .join(' ');
}

export { classNames, uid };
