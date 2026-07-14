import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import { h, clear } from './lib/dom.js';
import { navigate, resolveRoute } from './lib/router.js';
import { renderHeader } from './components/header.js';
import { createFooter } from './components/footer.js';
import * as home from './pages/home.js';
import * as reader from './pages/reader.js';
import * as login from './pages/login.js';
import * as register from './pages/register.js';
import * as profile from './pages/profile.js';
import * as admin from './pages/admin.js';

const routes = [
  { pattern: '/', view: home.render },
  { pattern: '/read/:slug', view: reader.render },
  { pattern: '/login', view: login.render },
  { pattern: '/register', view: register.render },
  { pattern: '/profile', view: profile.render },
  { pattern: '/admin', view: admin.renderDashboard },
  { pattern: '/admin/edit', view: admin.renderEditor },
  { pattern: '/admin/edit/:id', view: admin.renderEditor },
  { pattern: '*', view: home.render },
];

const app = document.getElementById('app');
const headerEl = h('header', { id: 'site-header' });
const view = h('main', { id: 'view' });
const footerEl = h('footer', { id: 'site-footer' });
app.append(headerEl, view, footerEl);

const THEME_KEY = 'flipblog-theme';
const themeBtn = h('button', {
  class: 'btn-tema-escuro',
  title: 'Alternar tema',
  onclick: () => {
    const dark = !document.body.classList.contains('tema-escuro');
    applyTheme(dark);
    localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
  },
});
document.body.append(themeBtn);

function applyTheme(dark) {
  document.body.classList.toggle('tema-escuro', dark);
  themeBtn.textContent = dark ? '☀️' : '🌓';
}
applyTheme(localStorage.getItem(THEME_KEY) === 'dark');

let cleanup = null;
async function render() {
  if (cleanup) {
    try {
      cleanup();
    } catch {
      /* noop */
    }
    cleanup = null;
  }
  await renderHeader(headerEl);
  footerEl.replaceChildren(createFooter());
  clear(view);
  const { route, params } = resolveRoute(routes);
  const result = await route.view({ params, view, navigate });
  if (typeof result === 'function') cleanup = result;
}

window.addEventListener('hashchange', render);
render();
