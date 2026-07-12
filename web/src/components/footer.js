import { h } from '../lib/dom.js';

export function createFooter() {
  return h(
    'footer',
    null,
    'FlipBlog — publique como uma revista. Feito com ', h('span', null, '📖')
  );
}
