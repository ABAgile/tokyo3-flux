// Entry for the vendored lit-html bundle; `make vendor-web` rebuilds
// internal/planningui/static/modules/vendor-lit-html.js from it. Export only
// what modules/lit.js uses, so the bundle stays small and reviewable.
export { html, nothing, render } from 'lit-html';
export { Directive, directive, PartType } from 'lit-html/directive.js';
export { classMap } from 'lit-html/directives/class-map.js';
export { keyed } from 'lit-html/directives/keyed.js';
export { repeat } from 'lit-html/directives/repeat.js';
