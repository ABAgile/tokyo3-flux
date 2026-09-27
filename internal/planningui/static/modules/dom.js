// Small browser DOM utilities for native interactions that Preact cannot own.
const $ = (id) => document.getElementById(id);
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
const initialized = new WeakSet();
function attach(setup, ...args) {
  return (node) => {
    if (!node || initialized.has(node)) return;
    initialized.add(node);
    setup(node, ...args);
  };
}
function syncDisabled(disabled) {
  return (node) => {
    if (node) node.disabled = !!disabled;
  };
}

export { $, attach, classNames, syncDisabled, uid };
