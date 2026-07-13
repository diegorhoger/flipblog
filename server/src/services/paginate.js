import { parseHTML } from 'linkedom';

const BREAK_ATTR = 'data-page-break';
const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4']);
const DEFAULT_MAX_CHARS = 1400;

function isBreak(node) {
  return node.nodeType === 1 && node.nodeName === 'HR' && node.hasAttribute(BREAK_ATTR);
}

function isHeading(node) {
  return node.nodeType === 1 && HEADING_TAGS.has(node.nodeName);
}

function textLength(node) {
  return (node.textContent || '').replace(/\s+/g, ' ').trim().length;
}

function titleOf(nodes) {
  for (const n of nodes) {
    if (isHeading(n)) {
      const t = (n.textContent || '').trim();
      if (t) return t;
    }
  }
  return '';
}

function pageFromNodes(nodes, index) {
  const html = nodes.map((n) => (n.outerHTML ? n.outerHTML : '')).join('');
  return { index, html, title: titleOf(nodes) };
}

/**
 * Split a single rich-text HTML document into an ordered list of "pages"
 * suitable for a flipbook reader. Resolution precedence:
 *   1. Explicit <hr data-page-break> markers
 *   2. Top-level heading boundaries (<h2>/<h3>)
 *   3. Paragraph/block chunking by character budget
 * Always returns at least one page.
 *
 * @param {string} html
 * @param {{ maxChars?: number }} [options]
 * @returns {{ index: number, html: string, title: string }[]}
 */
export function splitIntoPages(html, options = {}) {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const source = (html || '').trim();
  if (!source) return [{ index: 0, html: '', title: '' }];

  const { document } = parseHTML(`<html><body>${source}</body></html>`);
  const body = document.body;

  const nodes = [];
  for (const child of Array.from(body.childNodes)) {
    if (child.nodeType === 3) {
      const text = child.textContent.replace(/\s+/g, ' ').trim();
      if (text) {
        const p = document.createElement('p');
        p.textContent = text;
        nodes.push(p);
      }
    } else if (child.nodeType === 1) {
      if (isBreak(child)) nodes.push({ __break: true });
      else nodes.push(child);
    }
  }

  if (nodes.length === 0) return [{ index: 0, html: '', title: '' }];

  let groups = [];
  const hasBreak = nodes.some((n) => n.__break);
  const hasHeading = nodes.some((n) => isHeading(n));

  if (hasBreak) {
    let current = [];
    for (const n of nodes) {
      if (n.__break) {
        if (current.length) groups.push(current);
        current = [];
      } else {
        current.push(n);
      }
    }
    if (current.length) groups.push(current);
  } else if (hasHeading) {
    let current = [];
    for (const n of nodes) {
      if (isHeading(n) && current.length) {
        groups.push(current);
        current = [];
      }
      current.push(n);
    }
    if (current.length) groups.push(current);
  } else {
    let current = [];
    let len = 0;
    for (const n of nodes) {
      const l = textLength(n);
      if (current.length && len + l > maxChars) {
        groups.push(current);
        current = [];
        len = 0;
      }
      current.push(n);
      len += l;
    }
    if (current.length) groups.push(current);
  }

  const pages = groups
    .map(pageFromNodes)
    .filter((p) => {
      const text = p.html.replace(/<[^>]*>/g, '').trim();
      const hasMedia = /<(img|iframe|video|audio|embed|object|svg)/i.test(p.html);
      return text.length > 0 || hasMedia;
    });

  if (pages.length === 0) return [{ index: 0, html: '', title: '' }];
  return pages.map((p, i) => ({ ...p, index: i }));
}

export function countPages(html, options) {
  return splitIntoPages(html, options).length;
}
