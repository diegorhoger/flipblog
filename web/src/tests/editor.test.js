import { describe, it, expect, vi, beforeEach } from 'vitest';

// Real Quill runs in jsdom, so we assert on actual getSemanticHTML() output —
// the exact HTML that gets persisted and later reloaded.
vi.mock('../lib/api.js', () => ({ api: { upload: vi.fn() } }));
vi.mock('../lib/toast.js', () => ({ toast: vi.fn() }));

import { api } from '../lib/api.js';
import { toast } from '../lib/toast.js';
import { createEditor } from '../components/editor.js';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function getDialog() {
  return document.querySelector('.alt-dialog');
}

function typeAlt(value) {
  const input = document.querySelector('#alt-text');
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function confirmDialog({ alt, decorative = false } = {}) {
  if (decorative) {
    const cb = document.querySelector('#alt-decorative');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (alt !== undefined) {
    typeAlt(alt);
  }
  document.querySelector('.alt-actions .btn-primary').click();
}

function cancelDialog() {
  document.querySelector('.alt-actions .btn-ghost').click();
}

describe('editor image alt modal', () => {
  beforeEach(() => vi.resetAllMocks());

  it('inserts a descriptive alt into the serialized HTML', async () => {
    const editor = createEditor();
    const file = new File(['x'], 'pic.png', { type: 'image/png' });
    api.upload.mockResolvedValue({ ok: true, data: { url: '/uploads/pic.png' } });
    const p = editor.__test_uploadAndInsert(file, 0);
    expect(getDialog()).not.toBeNull();
    await confirmDialog({ alt: 'Capa da revista' });
    await p;
    await flush();
    expect(api.upload).toHaveBeenCalled();
    expect(editor.getContent()).toContain('<img src="/uploads/pic.png" alt="Capa da revista">');
    expect(toast).not.toHaveBeenCalled();
  });

  it('keeps an empty alt="" for decorative images', async () => {
    const editor = createEditor();
    const file = new File(['x'], 'pic.png', { type: 'image/png' });
    api.upload.mockResolvedValue({ ok: true, data: { url: '/uploads/pic.png' } });
    const p = editor.__test_uploadAndInsert(file, 0);
    await confirmDialog({ decorative: true });
    await p;
    await flush();
    expect(editor.getContent()).toContain('<img src="/uploads/pic.png" alt="">');
  });

  it('does not insert the image when canceled', async () => {
    const editor = createEditor();
    const file = new File(['x'], 'pic.png', { type: 'image/png' });
    const p = editor.__test_uploadAndInsert(file, 0);
    expect(getDialog()).not.toBeNull();
    cancelDialog();
    await p;
    await flush();
    expect(api.upload).not.toHaveBeenCalled();
    expect(editor.getContent()).not.toContain('<img');
  });

  it('cancels on Escape keypress', async () => {
    const editor = createEditor();
    const file = new File(['x'], 'pic.png', { type: 'image/png' });
    const p = editor.__test_uploadAndInsert(file, 0);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await p;
    await flush();
    expect(api.upload).not.toHaveBeenCalled();
    expect(editor.getContent()).not.toContain('<img');
  });

  it('shows the filename and a preview element', async () => {
    const editor = createEditor();
    const file = new File(['x'], 'foto.png', { type: 'image/png' });
    const p = editor.__test_uploadAndInsert(file, 0);
    const dialog = getDialog();
    expect(dialog.querySelector('.alt-filename').textContent).toContain('foto.png');
    expect(dialog).not.toBeNull();
    cancelDialog();
    await p;
    await flush();
  });

  it('traps focus and restores focus to the trigger on close', async () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const editor = createEditor();
    const file = new File(['x'], 'pic.png', { type: 'image/png' });
    const p = editor.__test_uploadAndInsert(file, 0);
    const dialog = getDialog();
    const focusable = [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    expect(document.activeElement).toBe(first);

    // Tab from the last focusable wraps back to the first.
    last.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(first);

    // Shift+Tab from the first focusable wraps to the last.
    first.focus();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })
    );
    expect(document.activeElement).toBe(last);

    cancelDialog();
    await p;
    await flush();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('does not upload before the modal is confirmed', async () => {
    const editor = createEditor();
    const file = new File(['x'], 'pic.png', { type: 'image/png' });
    api.upload.mockResolvedValue({ ok: true, data: { url: '/uploads/pic.png' } });
    const p = editor.__test_uploadAndInsert(file, 0);
    expect(getDialog()).not.toBeNull();
    expect(api.upload).not.toHaveBeenCalled();
    cancelDialog();
    await p;
    await flush();
  });

  it('removes the modal from the DOM after completion', async () => {
    const editor = createEditor();
    const file = new File(['x'], 'pic.png', { type: 'image/png' });
    api.upload.mockResolvedValue({ ok: true, data: { url: '/uploads/pic.png' } });
    const p = editor.__test_uploadAndInsert(file, 0);
    await confirmDialog({ alt: 'Capa' });
    await p;
    await flush();
    expect(getDialog()).toBeNull();
  });

  it('preserves alt through a serialize/reload round trip', async () => {
    const editor = createEditor();
    const file = new File(['x'], 'pic.png', { type: 'image/png' });
    api.upload.mockResolvedValue({ ok: true, data: { url: '/uploads/pic.png' } });
    const p = editor.__test_uploadAndInsert(file, 0);
    await confirmDialog({ alt: 'Capa da revista' });
    await p;
    await flush();
    const html = editor.getContent();
    expect(html).toContain('<img src="/uploads/pic.png" alt="Capa da revista">');

    const editor2 = createEditor({ initialHTML: html });
    expect(editor2.getContent()).toContain('alt="Capa da revista"');
  });

  it('inserts multiple pasted/dropped images in order, each with its alt', async () => {
    const editor = createEditor();
    const f0 = new File(['a'], 'a.png', { type: 'image/png' });
    const f1 = new File(['b'], 'b.png', { type: 'image/png' });
    api.upload.mockImplementation((file) =>
      Promise.resolve({ ok: true, data: { url: '/uploads/' + file.name } })
    );
    const p = editor.__test_insertImages([f0, f1], 0);
    await confirmDialog({ alt: 'Primeira' });
    await flush();
    await confirmDialog({ alt: 'Segunda' });
    await p;
    await flush();
    const html = editor.getContent();
    expect(api.upload).toHaveBeenCalledTimes(2);
    expect(html).toContain('<img src="/uploads/a.png" alt="Primeira">');
    expect(html).toContain('<img src="/uploads/b.png" alt="Segunda">');
    expect(html.indexOf('alt="Primeira"')).toBeLessThan(html.indexOf('alt="Segunda"'));
  });

  it('keeps decorative alt for every image in a multi-image batch', async () => {
    const editor = createEditor();
    const f0 = new File(['a'], 'a.png', { type: 'image/png' });
    const f1 = new File(['b'], 'b.png', { type: 'image/png' });
    api.upload.mockImplementation((file) =>
      Promise.resolve({ ok: true, data: { url: '/uploads/' + file.name } })
    );
    const p = editor.__test_insertImages([f0, f1], 0);
    await confirmDialog({ decorative: true });
    await flush();
    await confirmDialog({ decorative: true });
    await p;
    await flush();
    const html = editor.getContent();
    expect(html).toContain('<img src="/uploads/a.png" alt="">');
    expect(html).toContain('<img src="/uploads/b.png" alt="">');
  });

  it('skips a canceled image without shifting later inserts', async () => {
    const editor = createEditor();
    const f0 = new File(['a'], 'a.png', { type: 'image/png' });
    const f1 = new File(['b'], 'b.png', { type: 'image/png' });
    api.upload.mockImplementation((file) =>
      Promise.resolve({ ok: true, data: { url: '/uploads/' + file.name } })
    );
    const p = editor.__test_insertImages([f0, f1], 0);
    // First image canceled -> no upload, no insert.
    cancelDialog();
    await flush();
    // Second image described -> inserted at the original start index.
    await confirmDialog({ alt: 'Mantida' });
    await p;
    await flush();
    expect(api.upload).toHaveBeenCalledTimes(1);
    const html = editor.getContent();
    expect(html).not.toContain('/uploads/a.png');
    expect(html).toContain('<img src="/uploads/b.png" alt="Mantida">');
  });

  it('drop handler only inserts image files, ignoring other payloads', async () => {
    const editor = createEditor();
    const root = editor.element.querySelector('.ql-editor');
    const img = new File(['x'], 'pic.png', { type: 'image/png' });
    const doc = new File(['x'], 'doc.pdf', { type: 'application/pdf' });
    api.upload.mockResolvedValue({ ok: true, data: { url: '/uploads/pic.png' } });
    const dropEvent = new Event('drop', { bubbles: true, cancelable: true });
    dropEvent.dataTransfer = { files: [img, doc] };
    root.dispatchEvent(dropEvent);
    await confirmDialog({ alt: 'So imagem' });
    await flush();
    expect(api.upload).toHaveBeenCalledTimes(1);
    expect(editor.getContent()).toContain('<img src="/uploads/pic.png" alt="So imagem">');
  });
});
