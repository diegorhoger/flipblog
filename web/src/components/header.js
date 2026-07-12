import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';

export async function renderHeader(container) {
  const me = await api.me().catch(() => ({ ok: false }));
  const link = (label, path) =>
    h('a', { href: `#${path}`, onclick: (e) => { e.preventDefault(); navigate(path); } }, label);

  const authed = me.ok && me.data?.user;
  const isAdmin = authed?.role === 'admin';

  const nav = h(
    'nav',
    { class: 'nav' },
    link('Início', '/'),
    authed
      ? h(
          'span',
          { class: 'nav-group' },
          link('Painel', '/admin'),
          isAdmin ? link('Registrar', '/register') : null
        )
      : link('Entrar', '/login')
  );

  container.replaceChildren(
    h(
      'div',
      { class: 'header-inner' },
      h(
        'a',
        { class: 'brand', href: '#/', onclick: (e) => { e.preventDefault(); navigate('/'); } },
        h('span', { class: 'logo' }, '📖'),
        'FlipBlog'
      ),
      nav
    )
  );
}
