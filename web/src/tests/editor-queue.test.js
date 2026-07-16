import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Real Quill runs in jsdom; we assert on getSemanticHTML() and on the live DOM
// (dialogs, focus). Only the network/toast are mocked.
vi.mock('../lib/api.js', () => ({ api: { upload: vi.fn() } }));
vi.mock('../lib/toast.js', () => ({ toast: vi.fn() }));

import { api } from '../lib/api.js';
import { toast } from '../lib/toast.js';
import { createEditor } from '../components/editor.js';

async function flush() {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

function dialogs() {
  return document.querySelectorAll('[role="dialog"]');
}

function file(name) {
  return new File([name], name, { type: 'image/png' });
}

function editorRoot(editor) {
  return editor.element.querySelector('.ql-editor');
}

function dropFiles(editor, files) {
  const e = new Event('drop', { bubbles: true, cancelable: true });
  e.dataTransfer = { files };
  editorRoot(editor).dispatchEvent(e);
}

function pasteFiles(editor, files) {
  const e = new Event('paste', { bubbles: true, cancelable: true });
  e.clipboardData = { files };
  editorRoot(editor).dispatchEvent(e);
}

// Simulate the toolbar image picker: click the real .ql-image button (which runs
// the editor's `insertImage` handler and appends a hidden <input type=file>),
// then set the chosen file and fire `change` like the browser would.
function toolbarPick(editor, f) {
  const btn = editor.element.querySelector('.ql-image');
  btn.click();
  const inputs = document.querySelectorAll('body > input[type="file"]');
  const input = inputs[inputs.length - 1];
  Object.defineProperty(input, 'files', { value: [f], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return input;
}

function typeAlt(value) {
  const input = document.querySelector('#alt-text');
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function confirmActive({ alt, decorative = false } = {}) {
  if (decorative) {
    const cb = document.querySelector('#alt-decorative');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (alt !== undefined) {
    typeAlt(alt);
  }
  document.querySelector('.alt-actions .btn-primary').click();
}

function cancelActive() {
  document.querySelector('.alt-actions .btn-ghost').click();
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  // Clean up any leftover modal overlays or hidden file inputs between tests.
  document.querySelectorAll('.alt-overlay').forEach((el) => el.remove());
  document.querySelectorAll('body > input[type="file"]').forEach((el) => el.remove());
});

describe('editor image operation queue', () => {
  it('serializes two drop operations submitted while the first modal is open', async () => {
    const editor = createEditor();
    api.upload.mockImplementation((f) => Promise.resolve({ ok: true, data: { url: '/uploads/' + f.name } }));

    dropFiles(editor, [file('a.png')]);
    await flush();
    expect(dialogs()).toHaveLength(1); // A's modal

    // Submit a second drop while A's modal is still open.
    dropFiles(editor, [file('b.png')]);
    await flush();
    expect(dialogs()).toHaveLength(1); // still only one — B is queued
    expect(api.upload).not.toHaveBeenCalled(); // nothing uploads before confirmation

    await confirmActive({ alt: 'Alpha' });
    await flush();
    expect(dialogs()).toHaveLength(1); // now B's modal

    await confirmActive({ alt: 'Beta' });
    await flush();
    expect(dialogs()).toHaveLength(0);

    const html = editor.getContent();
    expect(api.upload).toHaveBeenCalledTimes(2);
    expect(html).toContain('<img src="/uploads/a.png" alt="Alpha">');
    expect(html).toContain('<img src="/uploads/b.png" alt="Beta">');
    // Submission order preserved, earlier insert not reversed by the later one.
    expect(html.indexOf('alt="Alpha"')).toBeLessThan(html.indexOf('alt="Beta"'));
  });

  it('paste and drop share the same queue (never two dialogs)', async () => {
    const editor = createEditor();
    api.upload.mockImplementation((f) => Promise.resolve({ ok: true, data: { url: '/uploads/' + f.name } }));

    pasteFiles(editor, [file('p.png')]);
    await flush();
    expect(dialogs()).toHaveLength(1);

    dropFiles(editor, [file('d.png')]);
    await flush();
    expect(dialogs()).toHaveLength(1); // shared queue: drop waits

    await confirmActive({ alt: 'Pasted' });
    await flush();
    expect(dialogs()).toHaveLength(1);

    await confirmActive({ alt: 'Dropped' });
    await flush();
    expect(dialogs()).toHaveLength(0);

    const html = editor.getContent();
    expect(html).toContain('alt="Pasted"');
    expect(html).toContain('alt="Dropped"');
    expect(html.indexOf('alt="Pasted"')).toBeLessThan(html.indexOf('alt="Dropped"'));
  });

  it('toolbar file selection shares the queue with paste', async () => {
    const editor = createEditor();
    api.upload.mockImplementation((f) => Promise.resolve({ ok: true, data: { url: '/uploads/' + f.name } }));

    toolbarPick(editor, file('toolbar.png'));
    await flush();
    expect(dialogs()).toHaveLength(1); // toolbar modal

    pasteFiles(editor, [file('paste.png')]);
    await flush();
    expect(dialogs()).toHaveLength(1); // paste queued behind toolbar

    await confirmActive({ alt: 'FromToolbar' });
    await flush();
    await confirmActive({ alt: 'FromPaste' });
    await flush();

    const html = editor.getContent();
    expect(html).toContain('<img src="/uploads/toolbar.png" alt="FromToolbar">');
    expect(html).toContain('<img src="/uploads/paste.png" alt="FromPaste">');
    expect(html.indexOf('FromToolbar')).toBeLessThan(html.indexOf('FromPaste'));
  });

  it('never renders two image-alt dialogs at any step of a busy queue', async () => {
    const editor = createEditor();
    api.upload.mockImplementation((f) => Promise.resolve({ ok: true, data: { url: '/uploads/' + f.name } }));

    // Three overlapping submissions from mixed sources.
    dropFiles(editor, [file('1.png')]);
    await flush();
    pasteFiles(editor, [file('2.png')]);
    await flush();
    dropFiles(editor, [file('3.png')]);
    await flush();
    expect(dialogs().length).toBeLessThanOrEqual(1);

    for (const alt of ['one', 'two', 'three']) {
      expect(dialogs().length).toBeLessThanOrEqual(1);
      await confirmActive({ alt });
      await flush();
    }
    expect(dialogs()).toHaveLength(0);
    const html = editor.getContent();
    expect(html.indexOf('alt="one"')).toBeLessThan(html.indexOf('alt="two"'));
    expect(html.indexOf('alt="two"')).toBeLessThan(html.indexOf('alt="three"'));
  });

  it('preserves file order within a single dropped batch', async () => {
    const editor = createEditor();
    api.upload.mockImplementation((f) => Promise.resolve({ ok: true, data: { url: '/uploads/' + f.name } }));

    dropFiles(editor, [file('first.png'), file('second.png'), file('third.png')]);
    await flush();
    await confirmActive({ alt: 'A1' });
    await flush();
    await confirmActive({ alt: 'A2' });
    await flush();
    await confirmActive({ alt: 'A3' });
    await flush();

    const html = editor.getContent();
    expect(html.indexOf('first.png')).toBeLessThan(html.indexOf('second.png'));
    expect(html.indexOf('second.png')).toBeLessThan(html.indexOf('third.png'));
  });

  it('canceling the active image lets the next queued image proceed', async () => {
    const editor = createEditor();
    api.upload.mockImplementation((f) => Promise.resolve({ ok: true, data: { url: '/uploads/' + f.name } }));

    dropFiles(editor, [file('skip.png')]);
    await flush();
    dropFiles(editor, [file('keep.png')]);
    await flush();

    cancelActive(); // cancel the first (skip.png)
    await flush();
    expect(dialogs()).toHaveLength(1); // keep.png modal proceeds

    await confirmActive({ alt: 'Kept' });
    await flush();

    const html = editor.getContent();
    expect(api.upload).toHaveBeenCalledTimes(1); // only keep.png uploaded
    expect(html).not.toContain('skip.png');
    expect(html).toContain('<img src="/uploads/keep.png" alt="Kept">');
  });

  it('an upload failure lets the next queued image proceed', async () => {
    const editor = createEditor();
    api.upload
      .mockResolvedValueOnce({ ok: false, status: 500, data: { error: 'boom' } })
      .mockResolvedValue({ ok: true, data: { url: '/uploads/ok.png' } });

    dropFiles(editor, [file('bad.png')]);
    await flush();
    dropFiles(editor, [file('ok.png')]);
    await flush();

    await confirmActive({ alt: 'WillFail' }); // triggers the failing upload
    await flush();
    expect(toast).toHaveBeenCalled(); // user-facing error retained
    expect(dialogs()).toHaveLength(1); // next image proceeds

    await confirmActive({ alt: 'Succeeds' });
    await flush();

    const html = editor.getContent();
    expect(html).not.toContain('bad.png');
    expect(html).toContain('<img src="/uploads/ok.png" alt="Succeeds">');
  });

  it('an unexpected thrown error does not deadlock the queue', async () => {
    const editor = createEditor();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    api.upload
      .mockImplementationOnce(() => {
        throw new Error('unexpected');
      })
      .mockResolvedValue({ ok: true, data: { url: '/uploads/after.png' } });

    dropFiles(editor, [file('throws.png')]);
    await flush();
    dropFiles(editor, [file('after.png')]);
    await flush();

    await confirmActive({ alt: 'Boom' }); // upload throws synchronously
    await flush();
    expect(errorSpy).toHaveBeenCalled(); // logged at the queue boundary
    expect(dialogs()).toHaveLength(1); // queue kept going

    await confirmActive({ alt: 'Recovered' });
    await flush();

    const html = editor.getContent();
    expect(html).not.toContain('throws.png');
    expect(html).toContain('<img src="/uploads/after.png" alt="Recovered">');
    errorSpy.mockRestore();
  });

  it('does not upload any queued file before its own modal is confirmed', async () => {
    const editor = createEditor();
    api.upload.mockImplementation((f) => Promise.resolve({ ok: true, data: { url: '/uploads/' + f.name } }));

    dropFiles(editor, [file('x.png')]);
    await flush();
    dropFiles(editor, [file('y.png')]);
    await flush();
    expect(api.upload).not.toHaveBeenCalled();

    await confirmActive({ alt: 'X' });
    await flush();
    expect(api.upload).toHaveBeenCalledTimes(1); // only the confirmed one

    // Y's modal is now open but Y has not uploaded yet.
    expect(dialogs()).toHaveLength(1);
    expect(api.upload).toHaveBeenCalledTimes(1);

    await confirmActive({ alt: 'Y' });
    await flush();
    expect(api.upload).toHaveBeenCalledTimes(2);
  });

  it('canceled queued images produce no uploads', async () => {
    const editor = createEditor();
    api.upload.mockImplementation((f) => Promise.resolve({ ok: true, data: { url: '/uploads/' + f.name } }));

    dropFiles(editor, [file('c1.png')]);
    await flush();
    dropFiles(editor, [file('c2.png')]);
    await flush();

    cancelActive();
    await flush();
    cancelActive();
    await flush();

    expect(api.upload).not.toHaveBeenCalled();
    expect(dialogs()).toHaveLength(0);
    expect(editor.getContent()).not.toContain('<img');
  });

  it('restores focus to the triggering element after a canceled operation', async () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const editor = createEditor();
    dropFiles(editor, [file('f.png')]);
    await flush();
    expect(dialogs()).toHaveLength(1);

    cancelActive();
    await flush();
    expect(dialogs()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('allows selecting the same toolbar file twice (input reset)', async () => {
    const editor = createEditor();
    api.upload.mockImplementation((f) => Promise.resolve({ ok: true, data: { url: '/uploads/' + f.name } }));
    const sameFile = file('same.png');

    toolbarPick(editor, sameFile);
    await flush();
    expect(dialogs()).toHaveLength(1);
    await confirmActive({ alt: 'First' });
    await flush();

    // Pick the very same file again; a fresh, reset input must still enqueue it.
    toolbarPick(editor, sameFile);
    await flush();
    expect(dialogs()).toHaveLength(1);
    await confirmActive({ alt: 'Second' });
    await flush();

    expect(api.upload).toHaveBeenCalledTimes(2);
    const html = editor.getContent();
    expect(html.match(/same\.png/g) || []).toHaveLength(2);
    expect(html).toContain('alt="First"');
    expect(html).toContain('alt="Second"');
  });
});
