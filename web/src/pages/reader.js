import { h, clear } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';
import { formatDate } from '../lib/format.js';
import { createFlipbook } from '../components/flipbook.js';

export async function render({ params, view }) {
  clear(view);
  view.append(h('div', { class: 'container' }, h('div', { class: 'loader' }, h('div', { class: 'spinner' }))));

  const { ok, data } = await api.getPost(params.slug).catch(() => ({ ok: false }));

  clear(view);
  if (!ok || !data) {
    view.append(
      h(
        'div',
        { class: 'container empty-state' },
        h('h2', null, 'Publicação não encontrada'),
        h('button', { class: 'btn btn-accent', onclick: () => navigate('/') }, 'Voltar ao início')
      )
    );
    return;
  }

  const fb = createFlipbook(data);

  const children = [
    h(
      'div',
      { class: 'reader-head' },
      h('h1', null, data.title),
      h('p', { class: 'text-suave' }, `por ${data.author || 'Anônimo'} · ${formatDate(data.created_at)}`)
    ),
  ];
  if (data.cover_image) {
    children.push(h('img', { class: 'reader-cover', src: data.cover_image, alt: data.title, loading: 'lazy' }));
  }
  children.push(fb.element);
  children.push(
    h(
      'div',
      { style: { textAlign: 'center', marginTop: '10px' } },
      h('button', { class: 'btn btn-ghost', onclick: () => navigate('/') }, '← Todas as publicações')
    )
  );

  view.append(h('div', { class: 'container' }, ...children));

  return fb.destroy;
}
