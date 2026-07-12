import { describe, it, expect, vi } from 'vitest';
import { h, clear } from '../lib/dom.js';

describe('h() DOM helper', () => {
  it('creates elements with attributes', () => {
    const el = h('div', { class: 'box', id: 'x' }, 'hello');
    expect(el.tagName).toBe('DIV');
    expect(el.className).toBe('box');
    expect(el.id).toBe('x');
    expect(el.textContent).toBe('hello');
  });

  it('binds event listeners', () => {
    const fn = vi.fn();
    const btn = h('button', { onclick: fn });
    btn.click();
    expect(fn).toHaveBeenCalledOnce();
  });

  it('sets innerHTML via html prop', () => {
    const el = h('div', { html: '<b>bold</b>' });
    expect(el.querySelector('b')).not.toBeNull();
  });

  it('flattens nested children', () => {
    const el = h('ul', null, [h('li', null, 'a'), h('li', null, 'b')]);
    expect(el.children.length).toBe(2);
  });

  it('clear() empties children', () => {
    const el = h('div', null, h('span', null, 'x'));
    clear(el);
    expect(el.children.length).toBe(0);
  });
});
