// The one import point for lit-html. Views render templates with `html` and
// `render`; `attach` wires imperative behaviour (drag, file drops) to an element
// once, when lit creates it, so re-renders never stack listeners.
//
// Never bind a `style` attribute or use lit's styleMap: its first render writes
// the style attribute, which the `style-src 'self'` policy blocks. styleProps
// sets properties through the CSSOM, which the policy allows.
//
// Ownership rule for lit-rendered DOM: a template binds an attribute, property
// or class only if no other code writes it, or binds it with live() when other
// code writes the same derived value (`disabled` on [data-write] controls, which
// renderControls also sets). renderControls owns `draggable`; drag and drop,
// attachment drops and tooltips toggle their own classes and attributes, which
// classMap leaves alone. Code outside a template may change static parts of
// lit-rendered DOM (an unbound status line's text) but never moves, removes or
// re-texts bound parts; it asks for a re-render instead.
import {
  classMap,
  Directive,
  directive,
  guard,
  html,
  keyed,
  live,
  nothing,
  PartType,
  render,
  repeat,
  svg,
} from './vendor-lit-html.js';

export { classMap, guard, html, keyed, live, nothing, render, repeat, svg };

class AttachDirective extends Directive {
  constructor(part) {
    super(part);
    if (part.type !== PartType.ELEMENT) throw new Error('attach() must be used on an element');
  }
  render() {
    return nothing;
  }
  update(part, [setup, ...args]) {
    if (!this.attached) {
      this.attached = true;
      setup(part.element, ...args);
    }
    return nothing;
  }
}
// `attach(setup, ...args)` calls setup(element, ...args) once per element. The
// arguments of later renders are ignored, so pass stable values (ids), and read
// anything that can change from the state at event time.
export const attach = directive(AttachDirective);
class StylePropsDirective extends Directive {
  constructor(part) {
    super(part);
    if (part.type !== PartType.ELEMENT) throw new Error('styleProps() must be used on an element');
  }
  render() {
    return nothing;
  }
  update(part, [properties]) {
    const { style } = part.element;
    for (const name of this.names || [])
      if (!Object.hasOwn(properties, name)) style.removeProperty(name);
    for (const [name, value] of Object.entries(properties)) style.setProperty(name, value);
    this.names = Object.keys(properties);
    return nothing;
  }
}
// `styleProps({ 'background-color': value })` on an element, kebab-case names.
export const styleProps = directive(StylePropsDirective);
// Renders a template into `container`, replacing its children, and returns a
// function that re-renders this mount. Use it for containers other code also
// clears (the editor dialog's fields): lit keeps its bookkeeping on a fresh
// fragment per mount, so a cleared container never leaves stale markers.
export function mount(container, template) {
  const root = document.createDocumentFragment();
  render(template, root);
  container.replaceChildren(root);
  return (next) => render(next, root);
}
// A template as detached elements, for imperative callers that append nodes.
// The returned nodes are plain DOM: lit no longer tracks them.
export function nodesOf(template) {
  const fragment = document.createDocumentFragment();
  render(template, fragment);
  return [...fragment.children];
}
export function nodeOf(template) {
  return nodesOf(template)[0];
}
