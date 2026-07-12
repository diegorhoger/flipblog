import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('page-flip', () => {
  class PageFlip {
    constructor() {}
    loadFromHTML() {}
    getPageCount() {
      return 2;
    }
    getCurrentPageIndex() {
      return 0;
    }
    on() {}
    flipNext() {}
    flipPrev() {}
    destroy() {}
  }
  return { PageFlip };
});

import { createFlipbook } from '../components/flipbook.js';

describe('createFlipbook', () => {
  let addSpy;
  let removeSpy;
  beforeEach(() => {
    addSpy = vi.spyOn(window, 'addEventListener');
    removeSpy = vi.spyOn(window, 'removeEventListener');
  });

  it('renders one .fb-page per page with controls', () => {
    const post = { title: 'T', pages: [{ html: '<p>a</p>' }, { html: '<p>b</p>' }] };
    const { element } = createFlipbook(post);
    expect(element.className).toBe('reader');
    expect(element.querySelectorAll('.fb-page').length).toBe(2);
    expect(element.querySelector('.flip-controls')).not.toBeNull();
    expect(element.querySelector('.page-indicator')).not.toBeNull();
  });

  it('registers a keydown listener and removes it on destroy', () => {
    const post = { title: 'T', pages: [{ html: '<p>a</p>' }] };
    const { destroy } = createFlipbook(post);
    expect(addSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
    destroy();
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
  });

  it('falls back to a single empty page when pages missing', () => {
    const { element } = createFlipbook({ title: 'T', pages: [] });
    expect(element.querySelectorAll('.fb-page').length).toBe(1);
  });
});
