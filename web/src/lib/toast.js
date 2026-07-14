import { h } from './dom.js';

let container;

function ensureContainer() {
  if (!container) {
    container = h('div', { class: 'toast-container', 'aria-live': 'polite', 'aria-atomic': 'false' });
    document.body.append(container);
  }
  return container;
}

export function toast(message, type = 'info', timeout = 3200) {
  const el = h('div', { class: `toast toast-${type}`, role: type === 'error' ? 'alert' : 'status' }, message);
  ensureContainer().append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  const remove = () => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  };
  el.addEventListener('click', remove);
  if (timeout) setTimeout(remove, timeout);
  return remove;
}
