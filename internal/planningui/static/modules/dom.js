// Generic DOM construction helpers. Apart from the id counter, every export is
// a pure factory over its arguments, so it is safe to import anywhere.
const $ = id => document.getElementById(id);
// Unique element ids for controls that need one but must not carry a form name:
// the item editor and the detail pane can render the same control at once, so a
// fixed id would be duplicated.
let uidSequence = 0;
function uid(prefix) { uidSequence += 1; return `${prefix}-${uidSequence}`; }
// Autofill has nothing useful to offer planning controls, and Chrome reports a
// missing autocomplete as an issue, so every text-like control opts out unless
// its caller sets a meaningful token.
function noAutofill(input) { if (!input.getAttribute('autocomplete')) input.autocomplete = 'off'; return input; }
function el(tag, text, className) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; }
function button(text, fn, className) { const b = el('button', text, className); b.type = 'button'; b.onclick = fn; return b; }
function options(select, entries, value) { select.replaceChildren(...entries.map(([id, text]) => { const o = el('option', text); o.value = id; return o; })); if (value !== undefined) select.value = value; }
function svgNode(tag, attributes = {}) { const node = document.createElementNS('http://www.w3.org/2000/svg', tag); Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value)); return node; }
function syncAttributes(target, source) {
 [...target.attributes].forEach(attribute => { if (!source.hasAttribute(attribute.name)) target.removeAttribute(attribute.name); });
 [...source.attributes].forEach(attribute => { if (target.getAttribute(attribute.name) !== attribute.value) target.setAttribute(attribute.name, attribute.value); });
}
function field(parent, name, title, value = '', type = 'text', entries) {
 const label = el('label', title); const input = el(entries ? 'select' : type === 'textarea' ? 'textarea' : 'input'); input.name = name;
 if (entries) options(input, entries, value); else { if (type !== 'textarea') input.type = type; input.value = value; }
 if (!entries && type !== 'checkbox' && type !== 'radio' && type !== 'file') noAutofill(input);
 label.append(input); parent.append(label); return input;
}

export {$, el, button, options, svgNode, syncAttributes, field, uid, noAutofill};
