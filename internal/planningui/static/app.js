// Bootstrap: the saved theme, one App render at the body, then startup.
import { html } from './modules/vdom.js';
import { render } from './modules/vendor-preact.js';
import { setState } from './modules/state.js';
import { App } from './modules/app-shell.js';
import { startApp } from './modules/actions.js';

const theme =
  localStorage.getItem('flux-plan-theme') ||
  (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.dataset.theme = theme;
setState({ theme });
render(html`<${App} />`, document.body);
void startApp();
