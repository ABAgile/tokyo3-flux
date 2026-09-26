// Generic DOM helpers for the few nodes built outside lit templates: page
// roots, the attachment tooltip, and in-place patches of observation nodes.
// Apart from the id counter, every export is a pure function of its arguments,
// so it is safe to import anywhere.
const $ = (id) => document.getElementById(id);
// Unique element ids for controls that need one but must not carry a form name:
// the item editor and the detail pane can render the same control at once, so a
// fixed id would be duplicated.
let uidSequence = 0;
function uid(prefix) {
  uidSequence += 1;
  return `${prefix}-${uidSequence}`;
}
function el(tag, text, className) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (className) e.className = className;
  return e;
}
function syncAttributes(target, source) {
  [...target.attributes].forEach((attribute) => {
    if (!source.hasAttribute(attribute.name)) target.removeAttribute(attribute.name);
  });
  [...source.attributes].forEach((attribute) => {
    if (target.getAttribute(attribute.name) !== attribute.value)
      target.setAttribute(attribute.name, attribute.value);
  });
}

export { $, el, syncAttributes, uid };
