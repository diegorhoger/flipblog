import Quill from 'quill';
import 'quill/dist/quill.snow.css';
import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { toast } from '../lib/toast.js';

const Delta = Quill.import('delta');
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

// Quill's built-in Image blot drops empty attribute values (it removes them in
// format()/formats()), so a decorative image (alt="") would lose its alt
// entirely — which is semantically different from a deliberately empty alt for
// accessibility scanners. This override keeps alt="" both in the model and when
// serializing through getSemanticHTML().
const Image = Quill.import('formats/image');
class AccessibleImage extends Image {
  format(name, value) {
    if (name === 'alt') {
      if (value === undefined) this.domNode.removeAttribute('alt');
      else this.domNode.setAttribute('alt', value);
      return;
    }
    super.format(name, value);
  }
  static formats(node) {
    const formats = super.formats(node);
    formats.alt = node.getAttribute('alt') ?? '';
    return formats;
  }
}
AccessibleImage.blotName = 'image';
AccessibleImage.tagName = 'IMG';
Quill.register(AccessibleImage, true);

const TOOLBAR = [
  [{ header: [1, 2, 3, false] }],
  ['bold', 'italic', 'underline', 'strike'],
  ['blockquote'],
  [{ list: 'ordered' }, { list: 'bullet' }],
  [{ align: [] }],
  ['link', 'image'],
  ['clean'],
];

export function createEditor({ initialHTML = '' } = {}) {
  const toolbar = h('div', { id: 'editor-toolbar' });
  const editor = h('div', { id: 'editor' });
  const shell = h('div', { class: 'editor-shell' }, toolbar, editor);

  const quill = new Quill(editor, {
    theme: 'snow',
    placeholder: 'Escreva seu artigo… use "Quebra de página" para separar as páginas da revista.',
    modules: {
      toolbar: {
        container: TOOLBAR,
        handlers: {
          image: insertImage,
          pageBreak: insertPageBreak,
        },
      },
    },
  });

  if (initialHTML) quill.clipboard.dangerouslyPasteHTML(initialHTML);

  // Ask the author for an alt text. The result has three outcomes:
  //   - canceled: the author dismissed the dialog (insert nothing)
  //   - decorative: an empty value, meaning "no semantic content" -> alt=""
  //   - described: a real description, used verbatim as alt text
  // Quill's Image blot drops empty attributes, so decorative images must carry
  // an explicit alt="" (a missing alt attribute has a different meaning and hurts
  // accessibility scanning tools).
  function promptAltText() {
    const value = window.prompt(
      'Texto alternativo (alt) da imagem.\n' +
        'Descreva brevemente o que a imagem mostra e sua função no conteúdo. ' +
        'Não use palavras-chave para SEO — escreva para pessoas que não veem a imagem. ' +
        'Deixe em branco apenas se a imagem for puramente decorativa. Cancelar aborta a inserção.',
      ''
    );
    if (value == null) return { canceled: true };
    const trimmed = value.trim();
    return trimmed ? { alt: trimmed } : { alt: '' };
  }

  async function uploadAndInsert(file, index) {
    // Prompt for alt text BEFORE uploading: a canceled prompt must not upload or
    // insert anything. This also avoids uploading when the author aborts.
    const altResult = promptAltText();
    if (altResult.canceled) return;

    const res = await api.upload(file);
    if (!res.ok) {
      toast('Falha ao enviar a imagem: ' + (res.data?.error || res.status), 'error');
      return;
    }
    // Insert the image first, then apply alt via formatText. Quill normalizes
    // empty attributes out of a Delta insert, so setting alt afterwards is the
    // only way to preserve a deliberately empty alt="" for decorative images.
    const safeIndex = typeof index === 'number' ? index : quill.getLength();
    quill.updateContents(new Delta().retain(safeIndex).insert({ image: res.data.url }), 'user');
    quill.formatText(safeIndex, 1, 'alt', altResult.alt, 'user');
    quill.setSelection(safeIndex + 1, 'user');
  }

  function insertImage() {
    const input = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (file) uploadAndInsert(file, quill.getSelection()?.index);
    });
    document.body.append(input);
    input.click();
    input.addEventListener('remove', () => input.remove());
  }

  function insertPageBreak() {
    const range = quill.getSelection(true);
    quill.insertText(range.index, '\n', 'user');
    quill.formatLine(range.index + 1, 1, 'pageBreak', true, 'user');
    quill.setSelection(quill.getLength(), 'user');
  }

  // Append the discoverable text button for page breaks (keeps the documented label).
  const qlToolbar = shell.querySelector('.ql-toolbar') || editor.previousElementSibling;
  if (qlToolbar) {
    const pbButton = h(
      'button',
      { class: 'ql-page-break', type: 'button', title: 'Inserir quebra de página' },
      '⤓ Quebra de página'
    );
    pbButton.addEventListener('mousedown', (e) => e.preventDefault());
    pbButton.addEventListener('click', insertPageBreak);
    qlToolbar.append(pbButton);
  }

  // Drag-and-drop and paste images directly into the editor.
  quill.root.addEventListener('drop', (e) => {
    const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    uploadAndInsert(file, quill.getSelection()?.index);
  });
  quill.root.addEventListener('paste', (e) => {
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    uploadAndInsert(file, quill.getSelection()?.index);
  });

  return {
    element: shell,
    getContent: () => quill.getSemanticHTML(),
    getText: () => quill.getText(),
    focus: () => quill.focus(),
    // Test-only hook so unit tests can exercise the alt-text flow without
    // depending on jsdom drag-and-drop/paste event quirks. Not used in app code.
    __test_uploadAndInsert: typeof process !== 'undefined' && process.env?.VITEST ? uploadAndInsert : undefined,
  };
}
