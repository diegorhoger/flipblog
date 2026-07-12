import { PageFlip } from 'page-flip';
import { h } from '../lib/dom.js';

function toggleFullscreen(stage) {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else stage.requestFullscreen?.().catch(() => {});
}

export function createFlipbook(post) {
  const book = h('div', { class: 'flipbook' });

  const pageEls = (post.pages && post.pages.length ? post.pages : [{ html: '', title: '' }]).map((p) => {
    const content = (p.html || '').trim() || '<p class="text-suave">Sem conteúdo nesta página.</p>';
    return h('div', { class: 'fb-page', html: content });
  });
  pageEls.forEach((el) => book.append(el));

  const stage = h('div', { class: 'flipbook-stage' }, book);

  const flip = new PageFlip(book, {
    width: 460,
    height: 600,
    size: 'stretch',
    minWidth: 300,
    maxWidth: 900,
    drawShadow: true,
    maxShadowOpacity: 0.5,
    showCover: false,
    mobileScrollSupport: false,
    usePortrait: true,
    autoSize: true,
  });
  flip.loadFromHTML(pageEls);

  const indicator = h('span', { class: 'page-indicator' }, '');
  const updateIndicator = () => {
    const total = flip.getPageCount();
    const current = total ? flip.getCurrentPageIndex() + 1 : 0;
    indicator.textContent = `${current} / ${total}`;
  };
  flip.on('flip', updateIndicator);
  flip.on('loaded', updateIndicator);
  setTimeout(updateIndicator, 0);

  const btnPrev = h('button', { class: 'btn btn-ghost', onclick: () => flip.flipPrev() }, '← Anterior');
  const btnNext = h('button', { class: 'btn btn-primary', onclick: () => flip.flipNext() }, 'Próximo →');
  const btnFull = h('button', { class: 'btn btn-ghost', onclick: () => toggleFullscreen(stage) }, '⛶ Tela cheia');
  const btnShare = h('button', { class: 'btn btn-ghost', onclick: share }, '🔗 Compartilhar');

  const controls = [btnPrev, indicator, btnNext];
  if (typeof flip.zoomIn === 'function') {
    controls.push(
      h('button', { class: 'btn btn-ghost', onclick: () => safe(flip.zoomOut) }, '🔍−'),
      h('button', { class: 'btn btn-ghost', onclick: () => safe(flip.zoomIn) }, '🔍+')
    );
  }
  controls.push(btnFull, btnShare);

  function safe(fn) {
    try {
      fn.call(flip);
    } catch {
      /* ignore unsupported zoom */
    }
  }

  function share() {
    const url = location.href;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(
        () => flash(btnShare, 'Copiado!'),
        () => flash(btnShare, 'Copie: ' + url)
      );
    } else {
      flash(btnShare, 'Copie: ' + url);
    }
  }

  function flash(btn, text) {
    const original = btn.textContent;
    btn.textContent = text;
    setTimeout(() => (btn.textContent = original), 1500);
  }

  const onKey = (e) => {
    if (e.key === 'ArrowRight') flip.flipNext();
    else if (e.key === 'ArrowLeft') flip.flipPrev();
  };
  window.addEventListener('keydown', onKey);

  const element = h('div', { class: 'reader' }, stage, h('div', { class: 'flip-controls' }, ...controls));

  const destroy = () => {
    window.removeEventListener('keydown', onKey);
    try {
      flip.destroy();
    } catch {
      /* noop */
    }
  };

  return { element, destroy };
}
