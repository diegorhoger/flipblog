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

  // ---- Serial image-insertion queue ---------------------------------------
  //
  // Toolbar file selection, paste, and drag-and-drop all funnel through ONE
  // FIFO queue. Only a single alt-text modal and a single insertion may be
  // active at a time, so overlapping pastes/drops can never open two dialogs or
  // interleave their inserts. Operations run in submission order; files within a
  // batch keep their order because they are enqueued together, front to back.
  //
  // INSERTION POSITION RULE (deterministic, documented, and tested):
  //   * Each operation captures the editor caret index at *submission* time as
  //     its `anchor`. Anchors are treated as fixed submission points; we do NOT
  //     rebase them to chase a cursor that moves while the queue drains.
  //   * Insertion is monotonic within a continuous drain: an operation inserts
  //     at `max(anchor, endOfPreviousInsert)`. This guarantees a later image can
  //     never overwrite or reverse an earlier one, and that a batch lands as a
  //     consecutive, correctly ordered run.
  //   * The high-water mark resets when the queue goes idle, so a subsequent,
  //     independent action honors its own anchor. In normal use each insert also
  //     advances the live caret (setSelection), so separate sequential actions
  //     already anchor after prior inserts.
  const imageQueue = [];
  let draining = false;
  // End index (exclusive) of the last insert in the current drain, or null when
  // the queue is idle.
  let lastInsertEnd = null;

  // Enqueue a single image operation. Returns a promise resolving to the
  // operation outcome ('inserted' | 'canceled' | 'failed' | 'error') once the
  // operation has fully finished, so callers/tests can await a specific submit.
  function enqueueImageOp(file, anchor) {
    let resolve;
    const done = new Promise((r) => {
      resolve = r;
    });
    // Normalize the anchor at SUBMISSION time. A null/undefined selection means
    // "append at the end of the document right now"; resolving getLength() here
    // (not later during the drain) makes it a true captured submission anchor,
    // so the rule stays: anchors are fixed points, not values recomputed after
    // earlier queued operations may have already changed the document.
    const capturedAnchor = typeof anchor === 'number' ? anchor : quill.getLength();
    imageQueue.push({ file, anchor: capturedAnchor, resolve });
    drainImageQueue();
    return done;
  }

  // Enqueue a batch (paste/drop) in order under a single shared anchor. Monotonic
  // insertion keeps the batch consecutive and ordered.
  function enqueueImages(files, anchor) {
    return Promise.all(files.map((file) => enqueueImageOp(file, anchor)));
  }

  async function drainImageQueue() {
    if (draining) return;
    draining = true;
    try {
      while (imageQueue.length) {
        const op = imageQueue.shift();
        let result = 'error';
        try {
          result = await runImageOp(op);
        } catch (err) {
          // Queue-boundary safety net: an unexpected error in one operation must
          // never stall the queue. Log a fixed, non-sensitive message and move
          // on so later queued operations still run. We deliberately do NOT log
          // err.message, which can leak request URLs, server responses, filenames,
          // or other unexpected details.
          // eslint-disable-next-line no-console
          console.error('[editor] unexpected image insertion error');
          result = 'error';
        } finally {
          op.resolve(result);
        }
      }
    } finally {
      draining = false;
      lastInsertEnd = null;
    }
  }

  // Run one image operation: prompt (exactly one modal) -> upload -> insert.
  // Prompting happens BEFORE uploading, so a canceled/dismissed modal uploads
  // nothing. Returns the outcome; may throw, which the drainer tolerates.
  async function runImageOp(op) {
    const altResult = await promptAltText(op.file);
    if (altResult.canceled) return 'canceled';

    const res = await api.upload(op.file);
    if (!res.ok) {
      toast('Falha ao enviar a imagem: ' + (res.data?.error || res.status), 'error');
      return 'failed';
    }

    // Insert the image, then apply alt via formatText. Quill normalizes empty
    // attributes out of a Delta insert, so setting alt afterwards is the only
    // way to preserve a deliberately empty alt="" for decorative images. The
    // anchor was normalized to a number at enqueue time (see enqueueImageOp),
    // so op.anchor is always a number here.
    const insertIndex = lastInsertEnd == null ? op.anchor : Math.max(op.anchor, lastInsertEnd);
    quill.updateContents(new Delta().retain(insertIndex).insert({ image: res.data.url }), 'user');
    quill.formatText(insertIndex, 1, 'alt', altResult.alt, 'user');
    quill.setSelection(insertIndex + 1, 'user');
    lastInsertEnd = insertIndex + 1;
    return 'inserted';
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
        // Route through the shared queue so a toolbar pick serializes with any
        // in-flight paste/drop instead of opening a second modal.
        if (file) enqueueImageOp(file, quill.getSelection()?.index);
        // Reset the value before removing so that, even if the element were
        // reused, picking the same file again would still fire `change`. A fresh
        // input is created on every toolbar click regardless.
        input.value = '';
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
  // in the payload is enqueued in order; the shared queue guarantees a single
  // modal/insertion at a time even across overlapping paste/drop events.
  quill.root.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    e.preventDefault();
    enqueueImages(files, quill.getSelection()?.index);
  });
  quill.root.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    e.preventDefault();
    enqueueImages(files, quill.getSelection()?.index);
  });

  const VITEST = typeof process !== 'undefined' && process.env?.VITEST;
  return {
    element: shell,
    getContent: () => quill.getSemanticHTML(),
    getText: () => quill.getText(),
    focus: () => quill.focus(),
    // Test-only hooks so unit tests can exercise the alt-text flow without
    // depending on jsdom drag-and-drop/paste event quirks. Both submit through
    // the same serial queue used by the real handlers. Not used in app code.
    __test_uploadAndInsert: VITEST
      ? (file, index) => enqueueImageOp(file, index).then((r) => r === 'inserted')
      : undefined,
    __test_insertImages: VITEST ? (files, index) => enqueueImages(files, index) : undefined,
  };
}
