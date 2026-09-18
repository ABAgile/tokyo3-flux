// Generic DOM construction helpers. No module-level state: every export is a
// pure factory over its arguments, so it is safe to import anywhere.
const $ = id => document.getElementById(id);
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
 label.append(input); parent.append(label); return input;
}

export {$, el, button, options, svgNode, syncAttributes, field};
