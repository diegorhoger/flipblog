import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the API client and router so the page can be rendered in isolation.
vi.mock('../lib/api.js', () => ({
  api: { me: vi.fn(), auditAltText: vi.fn() },
}));
vi.mock('../lib/router.js', () => ({ navigate: vi.fn() }));

import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';
import { render } from '../pages/altAudit.js';

const LEGEND = {
  missing_alt: { label: 'Sem atributo alt', detail: 'Adicione uma descrição.' },
  empty_alt: {
    label: 'alt vazio (pode ser decorativa)',
    detail: 'Correto para imagens decorativas. Confirme que a imagem não transmite informação.',
  },
  placeholder_alt: { label: 'alt genérico', detail: 'Placeholder pouco descritivo.' },
};

// Mirror the api client's `{ ok, status, data }` envelope around an audit body.
function auditResult(overrides = {}) {
  return {
    ok: true,
    status: 200,
    data: {
      items: [],
      page: 1,
      limit: 20,
      pages: 1,
      totalPosts: 0,
      totalFindings: 0,
      legend: LEGEND,
      ...overrides,
    },
  };
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function makeView() {
  const view = document.createElement('main');
  document.body.append(view);
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  api.me.mockResolvedValue({ ok: true, data: { user: { username: 'admin', role: 'admin' } } });
});

describe('alt audit page', () => {
  it('redirects to login when not authenticated', async () => {
    api.me.mockResolvedValue({ ok: false });
    const view = makeView();
    await render({ view });
    await flush();
    expect(navigate).toHaveBeenCalledWith('/login');
    expect(api.auditAltText).not.toHaveBeenCalled();
  });

  it('shows an empty state when there are no findings', async () => {
    api.auditAltText.mockResolvedValue(auditResult());
    const view = makeView();
    await render({ view });
    await flush();
    const empty = view.querySelector('.empty-state');
    expect(empty).not.toBeNull();
    expect(empty.textContent).toContain('Nenhuma imagem');
  });

  it('renders the decorative-empty explanation from the legend', async () => {
    api.auditAltText.mockResolvedValue(auditResult());
    const view = makeView();
    await render({ view });
    await flush();
    const legend = view.querySelector('.alt-audit-legend');
    expect(legend).not.toBeNull();
    expect(legend.textContent.toLowerCase()).toContain('decorativ');
  });

  it('renders a populated state with per-finding labels', async () => {
    api.auditAltText.mockResolvedValue(
      auditResult({
        totalPosts: 1,
        totalFindings: 3,
        items: [
          {
            postId: 42,
            title: 'Meu Post',
            slug: 'meu-post',
            findings: [
              { src: '/uploads/a.png', alt: null, type: 'missing_alt' },
              { src: 'https://cdn.example.com/b.png', alt: '', type: 'empty_alt' },
              { src: '/uploads/c.png', alt: 'image', type: 'placeholder_alt' },
            ],
          },
        ],
      })
    );
    const view = makeView();
    await render({ view });
    await flush();

    // Post title and finding count.
    expect(view.textContent).toContain('Meu Post');
    const findings = view.querySelectorAll('.alt-audit-finding');
    expect(findings).toHaveLength(3);

    // Distinct badge labels for each finding type.
    const badges = [...view.querySelectorAll('.alt-audit-finding .badge')].map((b) => b.textContent);
    expect(badges).toContain('Sem atributo alt');
    expect(badges).toContain('alt vazio (pode ser decorativa)');
    expect(badges).toContain('alt genérico');

    // Both local and external sources are shown safely as text.
    expect(view.textContent).toContain('/uploads/a.png');
    expect(view.textContent).toContain('https://cdn.example.com/b.png');
  });

  it('links each affected post to its editor', async () => {
    api.auditAltText.mockResolvedValue(
      auditResult({
        totalPosts: 1,
        totalFindings: 1,
        items: [
          {
            postId: 7,
            title: 'Editável',
            slug: 'editavel',
            findings: [{ src: '/uploads/a.png', alt: null, type: 'missing_alt' }],
          },
        ],
      })
    );
    const view = makeView();
    await render({ view });
    await flush();

    const link = view.querySelector('a[href="#/admin/edit/7"]');
    expect(link).not.toBeNull();
    link.click();
    expect(navigate).toHaveBeenCalledWith('/admin/edit/7');
  });

  it('renders alt/src values as inert text (never as HTML)', async () => {
    api.auditAltText.mockResolvedValue(
      auditResult({
        totalPosts: 1,
        totalFindings: 1,
        items: [
          {
            postId: 1,
            title: 'XSS attempt',
            slug: 'xss',
            findings: [
              {
                src: '/uploads/x.png',
                alt: '<script>window.__pwned=1</script>',
                type: 'placeholder_alt',
              },
            ],
          },
        ],
      })
    );
    const view = makeView();
    await render({ view });
    await flush();

    // The malicious alt is displayed literally and no <script> node is injected.
    expect(view.querySelector('script')).toBeNull();
    expect(window.__pwned).toBeUndefined();
    const altValue = view.querySelector('.alt-value');
    expect(altValue).not.toBeNull();
    expect(altValue.textContent).toContain('<script>window.__pwned=1</script>');
  });

  it('shows pagination controls and requests the next page', async () => {
    api.auditAltText.mockResolvedValue(
      auditResult({
        page: 1,
        pages: 2,
        totalPosts: 3,
        totalFindings: 3,
        items: [
          {
            postId: 1,
            title: 'A',
            slug: 'a',
            findings: [{ src: '/1.png', alt: null, type: 'missing_alt' }],
          },
        ],
      })
    );
    const view = makeView();
    await render({ view });
    await flush();

    expect(api.auditAltText).toHaveBeenCalledWith({ page: 1, limit: 20 });
    const nav = view.querySelector('.alt-audit-pagination');
    expect(nav).not.toBeNull();

    const buttons = [...view.querySelectorAll('.alt-audit-pagination button')];
    const prev = buttons.find((b) => b.textContent === 'Anterior');
    const next = buttons.find((b) => b.textContent === 'Próxima');
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);

    next.click();
    await flush();
    expect(api.auditAltText).toHaveBeenCalledWith({ page: 2, limit: 20 });
  });

  it('does not show pagination for a single page', async () => {
    api.auditAltText.mockResolvedValue(
      auditResult({
        pages: 1,
        totalPosts: 1,
        totalFindings: 1,
        items: [
          {
            postId: 1,
            title: 'Solo',
            slug: 'solo',
            findings: [{ src: '/1.png', alt: null, type: 'missing_alt' }],
          },
        ],
      })
    );
    const view = makeView();
    await render({ view });
    await flush();
    expect(view.querySelector('.alt-audit-pagination')).toBeNull();
  });

  it('shows an error message when the audit request fails', async () => {
    api.auditAltText.mockResolvedValue({ ok: false, status: 403, data: null });
    const view = makeView();
    await render({ view });
    await flush();
    expect(view.querySelector('.error-text')).not.toBeNull();
    expect(view.textContent).toContain('permissão');
  });
});
