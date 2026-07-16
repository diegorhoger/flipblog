import { parseHTML } from 'linkedom';
import { getDb } from '../db.js';

// Legacy image alt-text auditing.
//
// This module is strictly READ-ONLY. It parses the *already sanitized* HTML that
// FlipBlog stores in `posts.content` and reports `<img>` elements whose alt text
// is missing, empty, or a trivial placeholder. It never rewrites content,
// generates alt text, touches image files, or mutates the database.
//
// Parsing uses `linkedom` (the same DOM parser `services/paginate.js` already
// depends on) rather than fragile regex, so quoting styles, attribute order, and
// nested markup are handled robustly.

// Finding types. Kept as constants so the route, service, and tests share one
// vocabulary and typos surface immediately.
export const FINDING_TYPES = Object.freeze({
  MISSING: 'missing_alt',
  EMPTY: 'empty_alt',
  PLACEHOLDER: 'placeholder_alt',
});

// Human-facing legend returned alongside findings. Deliberately explains that an
// empty alt is NOT automatically a defect: a genuinely decorative image is
// *supposed* to use alt="" so assistive technology skips it. The audit surfaces
// empty alts for review, not as unquestionable errors. Wording is in Portuguese
// to match the rest of the UI.
export const AUDIT_LEGEND = Object.freeze({
  [FINDING_TYPES.MISSING]: {
    label: 'Sem atributo alt',
    detail:
      'A imagem não possui atributo alt. Leitores de tela podem anunciar o nome do arquivo ou ignorar a imagem. Adicione uma descrição ou marque-a como decorativa (alt vazio).',
  },
  [FINDING_TYPES.EMPTY]: {
    label: 'alt vazio (pode ser decorativa)',
    detail:
      'A imagem usa alt="". Isso é correto e intencional para imagens puramente decorativas, que devem ser ignoradas por leitores de tela. Confirme apenas que a imagem não transmite informação; se transmitir, adicione uma descrição.',
  },
  [FINDING_TYPES.PLACEHOLDER]: {
    label: 'alt genérico',
    detail:
      'O texto alternativo parece um placeholder pouco descritivo (por exemplo "imagem", "foto" ou o nome do arquivo). Descreva o que a imagem mostra e sua função no conteúdo.',
  },
});

// Trivial, non-descriptive placeholder words. Accent-stripped and lower-cased for
// comparison. A value equal to one of these (optionally followed by a number,
// e.g. "image1" / "foto 2" / "img_3") is treated as a placeholder.
const PLACEHOLDER_WORDS = new Set([
  'image',
  'images',
  'img',
  'imgs',
  'photo',
  'photos',
  'picture',
  'pictures',
  'pic',
  'pics',
  'foto',
  'fotos',
  'imagem',
  'imagens',
  'figure',
  'figura',
  'graphic',
  'graphics',
  'grafico',
  'screenshot',
  'screen shot',
  'captura de tela',
  'untitled',
  'sem titulo',
  'placeholder',
  'thumbnail',
  'thumb',
  'alt',
  'alt text',
  'texto alternativo',
]);

// Image file extensions used to recognise filename-only alt text.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|tiff?|ico|heic)$/i;

// Cap the reported source length so a pathological (e.g. huge data: URI) value
// can never bloat the response.
const MAX_SRC_LEN = 500;

function normalize(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Last path segment of a URL/path, without query string or fragment. Used to
// compare alt text against the image's own filename. Returns '' when nothing
// meaningful can be derived.
function fileNameFromSrc(src) {
  if (typeof src !== 'string' || src.length === 0) return '';
  let s = src.split('#')[0].split('?')[0];
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (slash > -1) s = s.slice(slash + 1);
  try {
    s = decodeURIComponent(s);
  } catch {
    /* leave as-is when decoding fails */
  }
  return s.trim();
}

// Whether the given (non-empty) alt string is a trivial placeholder for an image
// with the given src.
export function isPlaceholderAlt(altValue, src = '') {
  const raw = String(altValue).trim();
  if (raw === '') return false; // empty is handled as its own finding type
  const norm = normalize(raw);

  // Filename-only alt (e.g. "IMG_1234.JPG", "my photo.png").
  if (IMAGE_EXT.test(raw)) return true;

  // Alt equal to the image's filename (with or without extension).
  const fileName = fileNameFromSrc(src);
  if (fileName) {
    const fn = normalize(fileName);
    const fnNoExt = normalize(fileName.replace(IMAGE_EXT, ''));
    if (norm === fn || (fnNoExt && norm === fnNoExt)) return true;
  }

  // Exact trivial word, or a trivial word with a trailing number/index
  // ("image1", "foto 2", "img_3", "picture-4").
  if (PLACEHOLDER_WORDS.has(norm)) return true;
  const wordBase = norm.replace(/[\s._-]*\d+$/, '').trim();
  if (wordBase && wordBase !== norm && PLACEHOLDER_WORDS.has(wordBase)) return true;

  return false;
}

// Classify a single image. `hasAlt` distinguishes a missing attribute from an
// explicit empty one. Returns a finding type or null when the alt is meaningful.
export function classifyImage(hasAlt, altValue, src = '') {
  if (!hasAlt) return FINDING_TYPES.MISSING;
  if (String(altValue).trim() === '') return FINDING_TYPES.EMPTY;
  if (isPlaceholderAlt(altValue, src)) return FINDING_TYPES.PLACEHOLDER;
  return null;
}

/**
 * Parse a single post's sanitized HTML and return image alt findings.
 * Each finding contains only safe, public metadata:
 *   { src, alt, type }
 * where `alt` is null for a missing attribute and the (string) value otherwise.
 *
 * @param {string} html
 * @returns {{ src: string, alt: string|null, type: string }[]}
 */
export function auditPostContent(html) {
  if (typeof html !== 'string' || html.trim() === '') return [];
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const findings = [];
  for (const img of document.querySelectorAll('img')) {
    const rawSrc = img.getAttribute('src') || '';
    const src = rawSrc.slice(0, MAX_SRC_LEN);
    const hasAlt = img.hasAttribute('alt');
    const altValue = hasAlt ? img.getAttribute('alt') : null;
    const type = classifyImage(hasAlt, altValue, src);
    if (!type) continue;
    findings.push({
      src,
      alt: hasAlt ? String(altValue) : null,
      type,
    });
  }
  return findings;
}

function forbidden() {
  const err = new Error('forbidden');
  err.status = 403;
  return err;
}

/**
 * Audit alt text across the posts an actor is allowed to manage.
 *   - Admins see findings for every post.
 *   - Non-admin authors see findings only for posts they own (author_id).
 * Results are grouped per affected post and paginated over the set of posts that
 * actually have findings. Only safe public metadata is returned; filesystem
 * paths, database internals, and raw content are never exposed.
 *
 * @param {{ actor: object, page?: number, limit?: number }} params
 */
export function auditAltText({ actor, page = 1, limit = 20 } = {}) {
  if (!actor) throw forbidden();
  const role = actor.role;
  if (role !== 'admin' && role !== 'author') throw forbidden();

  const db = getDb();
  const rows =
    role === 'admin'
      ? db
          .prepare('SELECT id, title, slug, content FROM posts ORDER BY updated_at DESC')
          .all()
      : db
          .prepare(
            'SELECT id, title, slug, content FROM posts WHERE author_id = ? ORDER BY updated_at DESC'
          )
          .all(Number(actor.sub));

  const affected = [];
  let totalFindings = 0;
  for (const row of rows) {
    const findings = auditPostContent(row.content);
    if (findings.length === 0) continue;
    totalFindings += findings.length;
    affected.push({
      postId: row.id,
      title: row.title,
      slug: row.slug,
      findings,
    });
  }

  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 20));
  const safePage = Math.max(1, Number(page) || 1);
  const totalPosts = affected.length;
  const pages = Math.max(1, Math.ceil(totalPosts / safeLimit));
  const start = (safePage - 1) * safeLimit;
  const items = affected.slice(start, start + safeLimit);

  return {
    items,
    page: safePage,
    limit: safeLimit,
    pages,
    totalPosts,
    totalFindings,
    legend: AUDIT_LEGEND,
  };
}
