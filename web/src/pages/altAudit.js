import { h, clear } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';

// Finding-type badge classes reuse the existing badge palette so the audit view
// matches the rest of the dashboard visually.
const BADGE_CLASS = {
  missing_alt: 'badge-alt-missing',
  empty_alt: 'badge-alt-empty',
  placeholder_alt: 'badge-alt-placeholder',
};

// Fallback labels in case the API omits a legend entry (it never should, but the
// UI must not render "undefined").
const FALLBACK_LABEL = {
  missing_alt: 'Sem atributo alt',
  empty_alt: 'alt vazio (pode ser decorativa)',
  placeholder_alt: 'alt genérico',
};

const PAGE_SIZE = 20;

async function currentUser() {
  const me = await api.me().catch(() => ({ ok: false }));
  if (!me.ok || !me.data?.user) return null;
  return me.data.user;
}

// Render the "current alt state" for a finding using only safe DOM text nodes —
// never innerHTML — so any alt/src value from stored content is shown as inert
// text and can never execute or inject markup.
function altStateNode(finding) {
  if (finding.type === 'missing_alt' || finding.alt === null) {
    return h('span', { class: 'alt-state alt-state-missing' }, 'alt ausente');
  }
  if (finding.alt.trim() === '') {
    return h('span', { class: 'alt-state alt-state-empty' }, 'alt = "" (vazio)');
  }
  return h(
    'span',
    { class: 'alt-state' },
    'alt = ',
    h('span', { class: 'alt-value' }, `"${finding.alt}"`)
  );
}

function findingRow(finding, legend) {
  const meta = legend?.[finding.type] || { label: FALLBACK_LABEL[finding.type], detail: '' };
  const badgeClass = BADGE_CLASS[finding.type] || 'badge-draft';

  // A small, decorative preview of the image. Its own alt is intentionally empty
  // (it is redundant next to the source URL and finding metadata). Broken/remote
  // images simply hide themselves; no layout break.
  const preview = h('img', {
    class: 'alt-audit-thumb',
    src: finding.src,
    alt: '',
    loading: 'lazy',
    onerror: (e) => {
      e.target.style.visibility = 'hidden';
    },
  });

  return h(
    'li',
    { class: 'alt-audit-finding' },
    preview,
    h(
      'div',
      { class: 'alt-audit-finding-body' },
      h(
        'div',
        { class: 'alt-audit-finding-head' },
        h('span', { class: `badge ${badgeClass}` }, meta.label),
        altStateNode(finding)
      ),
      h(
        'div',
        { class: 'alt-audit-src' },
        h('span', { class: 'muted' }, 'Origem: '),
        // Source shown as inert text (code element), not a live link, to avoid
        // navigating to arbitrary stored URLs from the audit list.
        h('code', { class: 'alt-audit-src-value' }, finding.src || '(sem src)')
      ),
      meta.detail ? h('p', { class: 'alt-audit-detail muted' }, meta.detail) : null
    )
  );
}

function postSection(item, legend) {
  const editorPath = `/admin/edit/${item.postId}`;
  const heading = h(
    'div',
    { class: 'alt-audit-post-head' },
    h('h3', { class: 'alt-audit-post-title' }, item.title || '(sem título)'),
    h(
      'a',
      {
        class: 'btn btn-ghost',
        href: `#${editorPath}`,
        onclick: (e) => {
          e.preventDefault();
          navigate(editorPath);
        },
      },
      'Abrir no editor'
    )
  );

  const count = item.findings.length;
  const summary = h(
    'p',
    { class: 'muted alt-audit-post-summary' },
    `${count} ${count === 1 ? 'imagem sinalizada' : 'imagens sinalizadas'}`
  );

  return h(
    'section',
    { class: 'alt-audit-post', 'aria-label': `Imagens sinalizadas em ${item.title || 'publicação'}` },
    heading,
    summary,
    h('ul', { class: 'alt-audit-findings' }, ...item.findings.map((f) => findingRow(f, legend)))
  );
}

function legendCard(legend) {
  if (!legend) return null;
  const entries = Object.entries(legend);
  if (entries.length === 0) return null;
  return h(
    'section',
    { class: 'alt-audit-legend', 'aria-label': 'Legenda dos tipos de achado' },
    h('h2', { class: 'alt-audit-legend-title' }, 'Como interpretar os achados'),
    h(
      'dl',
      { class: 'alt-audit-legend-list' },
      ...entries.flatMap(([type, meta]) => [
        h('dt', { class: `alt-audit-legend-term ${BADGE_CLASS[type] || ''}` }, meta.label),
        h('dd', { class: 'muted' }, meta.detail),
      ])
    )
  );
}

function pagination(result, onGo) {
  if (!result.pages || result.pages <= 1) return null;
  const prev = h(
    'button',
    {
      class: 'btn btn-ghost',
      type: 'button',
      disabled: result.page <= 1,
      onclick: () => onGo(result.page - 1),
    },
    'Anterior'
  );
  const next = h(
    'button',
    {
      class: 'btn btn-ghost',
      type: 'button',
      disabled: result.page >= result.pages,
      onclick: () => onGo(result.page + 1),
    },
    'Próxima'
  );
  return h(
    'nav',
    { class: 'alt-audit-pagination', 'aria-label': 'Paginação dos resultados' },
    prev,
    h('span', { class: 'muted', 'aria-live': 'polite' }, `Página ${result.page} de ${result.pages}`),
    next
  );
}

export async function render({ view }) {
  clear(view);
  view.append(h('div', { class: 'container' }, h('div', { class: 'loader' }, h('div', { class: 'spinner' }))));

  const user = await currentUser();
  if (!user) {
    navigate('/login');
    return;
  }

  let page = 1;

  async function load() {
    clear(view);
    view.append(h('div', { class: 'container' }, h('div', { class: 'loader' }, h('div', { class: 'spinner' }))));

    const { ok, status, data } = await api.auditAltText({ page, limit: PAGE_SIZE });
    clear(view);

    if (!ok) {
      view.append(
        h(
          'div',
          { class: 'container' },
          h('h1', null, 'Auditoria de texto alternativo'),
          h(
            'p',
            { class: 'error-text' },
            status === 403
              ? 'Você não tem permissão para executar esta auditoria.'
              : 'Não foi possível carregar a auditoria.'
          )
        )
      );
      return;
    }

    const intro = h(
      'div',
      { class: 'alt-audit-intro' },
      h('h1', null, 'Auditoria de texto alternativo'),
      h(
        'p',
        { class: 'muted' },
        'Esta é uma ferramenta somente de leitura. Ela identifica imagens em publicações existentes cujo texto alternativo (alt) está ausente, vazio ou genérico. Nada é reescrito automaticamente — abra a publicação no editor para corrigir.'
      ),
      h(
        'p',
        { class: 'muted' },
        'Importante: um alt vazio (alt="") nem sempre é um erro. Imagens puramente decorativas devem mesmo usar alt vazio para que leitores de tela as ignorem. Revise cada caso com esse contexto.'
      )
    );

    const totals = h(
      'p',
      { class: 'alt-audit-totals', role: 'status' },
      data.totalFindings > 0
        ? `${data.totalFindings} ${data.totalFindings === 1 ? 'imagem sinalizada' : 'imagens sinalizadas'} em ${data.totalPosts} ${data.totalPosts === 1 ? 'publicação' : 'publicações'}.`
        : 'Nenhuma imagem sinalizada.'
    );

    let body;
    if (!data.items || data.items.length === 0) {
      body = h(
        'div',
        { class: 'empty-state' },
        h('p', null, 'Nenhuma imagem com problema de texto alternativo foi encontrada.'),
        h('p', { class: 'muted' }, 'Todas as imagens auditadas têm descrição adequada ou estão marcadas como decorativas.'),
        h(
          'button',
          { class: 'btn btn-ghost', type: 'button', onclick: () => navigate('/admin') },
          'Voltar ao painel'
        )
      );
    } else {
      body = h(
        'div',
        { class: 'alt-audit-posts' },
        ...data.items.map((item) => postSection(item, data.legend))
      );
    }

    view.append(
      h(
        'div',
        { class: 'container' },
        intro,
        legendCard(data.legend),
        totals,
        body,
        pagination(data, (p) => {
          page = p;
          load();
        })
      )
    );
  }

  await load();
}
