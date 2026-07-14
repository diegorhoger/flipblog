import Quill from 'quill';
import 'quill/dist/quill.snow.css';
import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { toast } from '../lib/toast.js';
import { openImageAltModal } from './imageAltModal.js';

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

  // Ask the author for an alt text through an accessible modal. The result has
  // three outcomes:
  //   - canceled: the author dismissed the dialog (insert nothing)
  //   - decorative: { alt: '' }, a deliberate empty alt for no semantic content
  //   - described: { alt: '<text>' }, a real description used verbatim as alt
  // Quill's Image blot drops empty attributes, so decorative images must carry
  // an explicit alt="" (a missing alt attribute has a different meaning and hurts
  // accessibility scanning tools).
  function promptAltText(file) {
    return openImageAltModal(file);
  }

  async function uploadAndInsert(file, index) {
    // Prompt for alt text BEFORE uploading: a canceled or dismissed modal must
    // not upload or insert anything. This also avoids orphaned uploads when the
    // author aborts.
    const altResult = await promptAltText(file);
    if (altResult.canceled) return false;

    const res = await api.upload(file);
    if (!res.ok) {
      toast('Falha ao enviar a imagem: ' + (res.data?.error || res.status), 'error');
      return false;
    }
    // Insert the image first, then apply alt via formatText. Quill normalizes
    // empty attributes out of a Delta insert, so setting alt afterwards is the
    // only way to preserve a deliberately empty alt="" for decorative images.
    const safeIndex = typeof index === 'number' ? index : quill.getLength();
    quill.updateContents(new Delta().retain(safeIndex).insert({ image: res.data.url }), 'user');
    quill.formatText(safeIndex, 1, 'alt', altResult.alt, 'user');
    quill.setSelection(safeIndex + 1, 'user');
    return true;
  }

  // Insert several image files in order, prompting for alt text for each one.
  // Images are uploaded and inserted one at a time, so the insertion point stays
  // correct even if the author cancels or an upload fails partway through:
  // only images that are actually inserted advance the running index.
  async function insertImages(files, startIndex) {
    let index = typeof startIndex === 'number' ? startIndex : quill.getLength();
    for (const file of files) {
      const inserted = await uploadAndInsert(file, index);
      if (inserted) index += 1;
    }
  }

  function insertImage() {
    const input = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    const cleanup = () => input.remove();
    // Remove the hidden input in every case: a file is chosen, the picker is
    // dismissed, or it is never used. `{ once: true }` ensures the handler runs
    // at most once even if both events fire.
    input.addEventListener(
      'change',
      () => {
        const file = input.files && input.files[0];
        if (file) uploadAndInsert(file, quill.getSelection()?.index);
        cleanup();
      },
      { once: true }
    );
    input.addEventListener('cancel', cleanup, { once: true });
    document.body.append(input);
    input.click();
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

  // Drag-and-drop and paste images directly into the editor. Every image file
  // in the payload is inserted in order, each through its own alt-text modal.
  quill.root.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    e.preventDefault();
    insertImages(files, quill.getSelection()?.index);
  });
  quill.root.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    e.preventDefault();
    insertImages(files, quill.getSelection()?.index);
  });

  return {
    element: shell,
    getContent: () => quill.getSemanticHTML(),
    getText: () => quill.getText(),
    focus: () => quill.focus(),
    // Test-only hooks so unit tests can exercise the alt-text flow without
    // depending on jsdom drag-and-drop/paste event quirks. Not used in app code.
    __test_uploadAndInsert: typeof process !== 'undefined' && process.env?.VITEST ? uploadAndInsert : undefined,
    __test_insertImages: typeof process !== 'undefined' && process.env?.VITEST ? insertImages : undefined,
  };
}
