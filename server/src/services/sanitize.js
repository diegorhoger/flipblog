import sanitizeHtml from 'sanitize-html';

const CONTENT_OPTIONS = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'p', 'br', 'strong', 'em', 'u', 's',
    'a', 'ul', 'ol', 'li', 'blockquote', 'img', 'hr', 'span', 'div',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
    hr: ['data-page-break'],
    '*': ['class'],
  },
  allowedStyles: {
    '*': {
      color: [/^.+$/],
      'background-color': [/^.+$/],
      'text-align': [/^(left|center|right|justify)$/],
      'font-size': [/^.+$/],
      'font-weight': [/^.+$/],
    },
  },
  allowedSchemes: ['http', 'https', 'mailto', 'data'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
  },
};

export function sanitizeContent(html) {
  if (typeof html !== 'string') return '';
  return sanitizeHtml(html, CONTENT_OPTIONS);
}

export function sanitizeText(value, max = 500) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}
