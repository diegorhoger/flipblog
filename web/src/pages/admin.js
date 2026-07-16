import { h, clear } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';
import { formatDate } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { createEditor } from '../components/editor.js';

async function requireAuth(view, navigate) {
  const me = await api.me().catch(() => ({ ok: false }));
  if (!me.ok) {
    navigate('/login');
    return false;
  }
  return true;
}

export async function renderDashboard({ view }) {
  if (!(await requireAuth(view, navigate))) return;

  clear(view);
  view.append(h('div', { class: 'container' }, h('div', { class: 'loader' }, h('div', { class: 'spinner' }))));

  const { ok, data } = await api.getPosts({ status: 'all', limit: 100 });

  clear(view);
  const reload = () => renderDashboard({ view });

  const table = h(
    'table',
    { class: 'table' },
    h(
      'thead',
      null,
      h(
        'tr',
        null,
        h('th', null, 'Título'),
        h('th', null, 'Status'),
        h('th', null, 'Páginas'),
        h('th', null, 'Atualizado'),
        h('th', null, 'Ações')
      )
    ),
    h('tbody', ...(data.items || []).map((post) => rowFor(post, reload)))
  );

  view.append(
    h(
      'div',
      { class: 'container' },
      h(
        'div',
        { class: 'section-title' },
        h('h2', null, 'Painel de publicações'),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn btn-ghost', onclick: () => navigate('/admin/alt-audit') }, 'Auditar alt-text'),
          h('button', { class: 'btn btn-accent', onclick: () => navigate('/admin/edit') }, '+ Nova publicação')
        )
      ),
      data.items && data.items.length
        ? table
        : h('div', { class: 'empty-state' }, h('p', null, 'Nenhuma publicação ainda. Crie a primeira.'))
    )
  );
}

function rowFor(post, reload) {
  return h(
    'tr',
    null,
    h('td', null, h('strong', null, post.title)),
    h(
      'td',
      null,
      h('span', { class: `badge badge-${post.status}` }, post.status === 'draft' ? 'Rascunho' : 'Publicado')
    ),
    h('td', null, String(post.pageCount)),
    h('td', { class: 'text-suave' }, formatDate(post.updated_at)),
    h(
      'td',
      null,
      h(
        'div',
        { class: 'row-actions' },
        h('button', { class: 'btn btn-ghost', onclick: () => navigate(`/admin/edit/${post.id}`) }, 'Editar'),
        h('button', { class: 'btn btn-ghost', onclick: () => navigate(`/read/${post.slug}`) }, 'Ver'),
        h(
          'button',
          {
            class: 'btn btn-danger',
            onclick: async () => {
              if (!confirm(`Excluir "${post.title}"?`)) return;
              const res = await api.deletePost(post.id);
              if (res.ok) reload();
            },
          },
          'Excluir'
        )
      )
    )
  );
}

export async function renderEditor({ params, view }) {
  if (!(await requireAuth(view, navigate))) return;

  const editing = params.id ? Number(params.id) : null;
  let post = null;
  if (editing) {
    const res = await api.getPostById(editing);
    if (res.ok) post = res.data;
  }

  clear(view);

  const title = h('input', { type: 'text', value: post?.title || '', placeholder: 'Título da publicação', required: true });
  const author = h('input', { type: 'text', value: post?.author || '', placeholder: 'Autor' });
  const excerpt = h('textarea', { rows: '2', placeholder: 'Resumo curto (opcional)' }, post?.excerpt || '');
  const cover = h('input', { type: 'text', value: post?.cover_image || '', placeholder: '/uploads/imagem.png' });
  const status = h(
    'select',
    null,
    h('option', { value: 'published', selected: !post || post.status === 'published' }, 'Publicado'),
    h('option', { value: 'draft', selected: post?.status === 'draft' }, 'Rascunho')
  );

  const coverPreview = h('img', {
    src: post?.cover_image || '',
    alt: '',
    style: { display: post?.cover_image ? 'block' : 'none', maxHeight: '160px', borderRadius: '8px', marginTop: '8px' },
  });

  const removeCover = h(
    'button',
    {
      class: 'btn btn-ghost',
      type: 'button',
      style: { display: post?.cover_image ? 'inline-flex' : 'none' },
      onclick: () => {
        cover.value = '';
        coverPreview.src = '';
        coverPreview.style.display = 'none';
        removeCover.style.display = 'none';
      },
    },
    'Remover'
  );

  const fileInput = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const res = await api.upload(file);
    if (res.ok) {
      cover.value = res.data.url;
      coverPreview.src = res.data.url;
      coverPreview.style.display = 'block';
      removeCover.style.display = 'inline-flex';
    } else {
      toast('Falha no upload da capa: ' + (res.data?.error || res.status), 'error');
    }
  });

  const editor = createEditor({ initialHTML: post?.content || '' });
  const error = h('p', { class: 'error-text' });

  async function save(openPreview) {
    error.textContent = '';
    const payload = {
      title: title.value.trim(),
      author: author.value.trim(),
      excerpt: excerpt.value.trim(),
      cover_image: cover.value.trim() || null,
      status: status.value,
      content: editor.getContent(),
    };
    if (!payload.title) {
      error.textContent = 'O título é obrigatório.';
      return;
    }
    const res = editing ? await api.updatePost(editing, payload) : await api.createPost(payload);
    if (!res.ok) {
      error.textContent = 'Erro ao salvar: ' + (res.data?.error || res.status);
      return;
    }
    toast(editing ? 'Publicação atualizada!' : 'Publicação criada!', 'success');
    if (openPreview) window.open(`#/read/${res.data.slug}`, '_blank');
    navigate('/admin');
  }

  const form = h(
    'form',
    {
      class: 'form',
      onsubmit: (e) => {
        e.preventDefault();
        save(false);
      },
    },
    h('h2', null, editing ? 'Editar publicação' : 'Nova publicação'),
    h('div', { class: 'field' }, h('label', null, 'Título'), title),
    h('div', { class: 'row' },
      h('div', { class: 'field' }, h('label', null, 'Autor'), author),
      h('div', { class: 'field' }, h('label', null, 'Status'), status)
    ),
    h('div', { class: 'field' }, h('label', null, 'Resumo'), excerpt),
    h('div', { class: 'field' },
      h('label', null, 'Imagem de capa (URL ou envio)'),
      cover,
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '6px', alignItems: 'center' } },
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => fileInput.click() }, 'Enviar imagem'),
        removeCover,
        fileInput
      ),
      coverPreview
    ),
    h('div', { class: 'field' }, h('label', null, 'Conteúdo (editor)'), editor.element),
    error,
    h('div', { class: 'row' },
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Salvar'),
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => save(true) }, 'Salvar e pré-visualizar'),
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => navigate('/admin') }, 'Cancelar')
    )
  );

  view.append(h('div', { class: 'container' }, form));
  editor.focus();
}
