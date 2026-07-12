import { h, clear } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';

function card(post) {
  const cover = post.cover_image
    ? h('img', { class: 'card-cover', src: post.cover_image, alt: post.title, loading: 'lazy' })
    : h('div', { class: 'card-cover placeholder' }, '📖');

  return h(
    'a',
    {
      class: 'card',
      href: `#/read/${post.slug}`,
      onclick: (e) => {
        e.preventDefault();
        navigate(`/read/${post.slug}`);
      },
    },
    cover,
    h(
      'div',
      { class: 'card-body' },
      h('h3', { class: 'card-title' }, post.title),
      h('p', { class: 'card-excerpt' }, post.excerpt || ''),
      h(
        'div',
        { class: 'card-meta' },
        h('span', null, 'por ' + (post.author || 'Anônimo')),
        h('span', { class: 'badge badge-pages' }, `${post.pageCount} pág.`)
      )
    )
  );
}

export async function render({ view }) {
  clear(view);
  view.append(
    h(
      'div',
      { class: 'container' },
      h('div', { class: 'loader' }, h('div', { class: 'spinner' }))
    )
  );

  const { ok, data } = await api.getPosts({ status: 'published', limit: 48 });

  clear(view);
  if (!ok || !data.items.length) {
    view.append(
      h(
        'div',
        { class: 'container empty-state' },
        h('h2', null, 'Nenhuma publicação ainda'),
        h('p', null, 'Acesse o painel para criar seu primeiro flipbook.')
      )
    );
    return;
  }

  view.append(
    h(
      'div',
      { class: 'container' },
      h(
        'section',
        { class: 'hero' },
        h('h1', null, 'FlipBlog'),
        h('p', null, 'Publicações em formato de revista que você folheia como um livro.')
      ),
      h(
        'div',
        { class: 'section-title' },
        h('h2', null, 'Publicações'),
        h('span', { class: 'text-suave' }, `${data.total} artigo(s)`)
      ),
      h('div', { class: 'grid' }, ...data.items.map(card))
    )
  );
}
