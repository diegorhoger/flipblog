import { h } from '../lib/dom.js';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Open an accessible dialog to collect alt text for an image before it is
// uploaded. Resolves to one of:
//   - { canceled: true }            -> the author dismissed the dialog
//   - { alt: '' }                   -> decorative image (deliberate empty alt)
//   - { alt: '<description>' }      -> descriptive alt text
// The dialog shows the image filename (and a preview when available) and
// explains what alt text is for. It traps focus, cancels on Escape, and
// restores focus to the previously focused element on close.
export function openImageAltModal(file) {
  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement;
    let closed = false;

    const preview = h('div', { class: 'alt-preview' });
    const fileName = file && file.name ? file.name : null;
    let objectUrl = null;
    if (file && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      try {
        objectUrl = URL.createObjectURL(file);
        preview.append(h('img', { src: objectUrl, alt: '' }));
      } catch {
        objectUrl = null;
      }
    }
    if (fileName) {
      preview.append(h('p', { class: 'alt-filename muted' }, fileName));
    }

    const altInput = h('input', {
      type: 'text',
      id: 'alt-text',
      class: 'alt-input',
      autocomplete: 'off',
      'aria-describedby': 'alt-guidance',
    });
    const altLabel = h('label', { for: 'alt-text' }, 'Texto alternativo (alt)');
    const guidance = h(
      'p',
      { id: 'alt-guidance', class: 'alt-guidance muted' },
      'Descreva brevemente o que a imagem mostra e qual é a sua função no conteúdo, para pessoas que não conseguem vê-la. Não use palavras-chave para SEO — escreva para quem não vê a imagem.'
    );

    const decorativeInput = h('input', { type: 'checkbox', id: 'alt-decorative' });
    const decorativeLabel = h(
      'label',
      { for: 'alt-decorative' },
      'Imagem puramente decorativa (sem texto alternativo)'
    );

    const errorEl = h('p', { class: 'alt-error error-text', role: 'alert', id: 'alt-error' });
    errorEl.style.display = 'none';

    const cancelBtn = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Cancelar');
    const insertBtn = h('button', { type: 'button', class: 'btn btn-primary' }, 'Inserir imagem');

    const form = h(
      'form',
      { class: 'alt-form' },
      altLabel,
      altInput,
      guidance,
      h('div', { class: 'alt-decorative' }, decorativeInput, decorativeLabel),
      errorEl
    );

    const dialog = h(
      'div',
      {
        class: 'alt-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'alt-title',
        'aria-describedby': 'alt-guidance',
      },
      h('h2', { id: 'alt-title', class: 'alt-title' }, 'Adicionar imagem'),
      preview,
      form,
      h('div', { class: 'alt-actions' }, cancelBtn, insertBtn)
    );

    const overlay = h('div', { class: 'alt-overlay' }, dialog);

    function close(result) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
      if (objectUrl) {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch {
          /* ignore */
        }
      }
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
      resolve(result);
    }

    function getFocusable() {
      return [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)];
    }

    function onKeydown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close({ canceled: true });
        return;
      }
      if (e.key === 'Tab') {
        const items = getFocusable();
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    function onDecorativeChange() {
      if (decorativeInput.checked) {
        altInput.value = '';
        altInput.disabled = true;
        altInput.setAttribute('aria-disabled', 'true');
      } else {
        altInput.disabled = false;
        altInput.removeAttribute('aria-disabled');
        altInput.focus();
      }
    }

    function submit() {
      if (decorativeInput.checked) {
        close({ alt: '' });
        return;
      }
      const value = altInput.value.trim();
      if (!value) {
        errorEl.textContent =
          'Informe um texto alternativo ou marque a imagem como decorativa.';
        errorEl.style.display = '';
        altInput.focus();
        return;
      }
      errorEl.style.display = 'none';
      close({ alt: value });
    }

    decorativeInput.addEventListener('change', onDecorativeChange);
    cancelBtn.addEventListener('click', () => close({ canceled: true }));
    insertBtn.addEventListener('click', submit);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submit();
    });
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close({ canceled: true });
    });
    document.addEventListener('keydown', onKeydown, true);

    document.body.append(overlay);
    altInput.focus();
  });
}
