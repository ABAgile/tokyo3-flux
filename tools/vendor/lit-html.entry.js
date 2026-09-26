// Entry for the vendored lit-html bundle; `make vendor-web` rebuilds
// internal/planningui/static/modules/vendor-lit-html.js from it. Export only
// what modules/lit.js uses, so the bundle stays small and reviewable.
export { html, nothing, render, svg } from 'lit-html';
export { Directive, directive, PartType } from 'lit-html/directive.js';
export { classMap } from 'lit-html/directives/class-map.js';
export { guard } from 'lit-html/directives/guard.js';
export { keyed } from 'lit-html/directives/keyed.js';
export { live } from 'lit-html/directives/live.js';
export { repeat } from 'lit-html/directives/repeat.js';
