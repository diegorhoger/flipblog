import Quill from 'quill';
import 'quill/dist/quill.snow.css';
import { h } from '../lib/dom.js';

const BlockEmbed = Quill.import('blots/block/embed');
class PageBreak extends BlockEmbed {
  static create() {
    const node = super.create();
    node.setAttribute('data-page-break', '');
    node.classList.add('ql-page-break');
    return node;
  }
  static formats() {
    return true;
  }
}
PageBreak.blotName = 'pageBreak';
PageBreak.tagName = 'HR';
Quill.register(PageBreak);

export function createEditor({ initialHTML = '' } = {}) {
  const toolbar = h('div', { id: 'editor-toolbar' });
  const editor = h('div', { id: 'editor' });
  const shell = h('div', { class: 'editor-shell' }, toolbar, editor);

  const quill = new Quill(editor, {
    theme: 'snow',
    placeholder: 'Escreva seu artigo… use "Quebra de página" para separar as páginas da revista.',
    modules: {
      toolbar: {
        container: toolbar,
        handlers: {}, // page break button added manually below
      },
    },
  });

  if (initialHTML) quill.clipboard.dangerouslyPasteHTML(initialHTML);

  function insertPageBreak() {
    const range = quill.getSelection(true);
    quill.insertText(range.index, '\n', 'user');
    quill.formatLine(range.index + 1, 1, 'pageBreak', true, 'user');
    quill.setSelection(quill.getLength(), 'user');
  }

  const pbButton = h(
    'button',
    { class: 'ql-page-break', type: 'button', title: 'Inserir quebra de página' },
    '⤓ Quebra de página'
  );
  pbButton.addEventListener('mousedown', (e) => e.preventDefault());
  pbButton.addEventListener('click', insertPageBreak);
  toolbar.append(pbButton);

  return {
    element: shell,
    getContent: () => quill.getSemanticHTML(),
    focus: () => quill.focus(),
  };
}
