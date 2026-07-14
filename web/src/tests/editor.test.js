import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Real Quill runs in jsdom, so we assert on actual getSemanticHTML() output —
// the exact HTML that gets persisted and later reloaded.
vi.mock('../lib/api.js', () => ({ api: { upload: vi.fn() } }));
vi.mock('../lib/toast.js', () => ({ toast: vi.fn() }));

import { api } from '../lib/api.js';
import { toast } from '../lib/toast.js';
import { createEditor } from '../components/editor.js';

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('editor image alt text', () => {
  let originalPrompt;
  beforeEach(() => {
    vi.resetAllMocks();
    originalPrompt = window.prompt;
  });
  afterEach(() => {
    // Restore (window.prompt is a read-only accessor in jsdom; defineProperty
    // lets us override it for the duration of each test).
    Object.defineProperty(window, 'prompt', { value: originalPrompt, configurable: true });
  });

  async function upload(promptValue) {
    const editor = createEditor();
    const file = new File(['x'], 'pic.png', { type: 'image/png' });
    api.upload.mockResolvedValue({ ok: true, data: { url: '/uploads/pic.png' } });
    // uploadAndInsert awaits the upload before calling promptAltText(), so the
    // stub must stay in place for the whole async flow.
    Object.defineProperty(window, 'prompt', { value: () => promptValue, configurable: true });
    await editor.__test_uploadAndInsert(file, 0);
    await flush();
    return editor;
  }

  it('inserts a descriptive alt into the serialized HTML', async () => {
    const editor = await upload('Capa da revista');
    expect(api.upload).toHaveBeenCalled();
    expect(editor.getContent()).toContain('<img src="/uploads/pic.png" alt="Capa da revista">');
    expect(toast).not.toHaveBeenCalled();
  });

  it('keeps an empty alt="" for decorative images', async () => {
    const editor = await upload('');
    expect(editor.getContent()).toContain('<img src="/uploads/pic.png" alt="">');
  });

  it('does not insert the image when the prompt is canceled', async () => {
    const editor = await upload(null);
    expect(api.upload).not.toHaveBeenCalled();
    expect(editor.getContent()).not.toContain('<img');
  });
});
