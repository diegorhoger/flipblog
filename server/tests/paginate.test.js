import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitIntoPages, countPages } from '../src/services/paginate.js';

test('empty content yields a single empty page', () => {
  assert.deepEqual(splitIntoPages(''), [{ index: 0, html: '', title: '' }]);
  assert.deepEqual(splitIntoPages('   <p></p>   '), [{ index: 0, html: '', title: '' }]);
  assert.equal(countPages('<p>   </p>'), 1);
});

test('explicit page-break markers split content', () => {
  const html = '<h2>One</h2><p>a</p><hr data-page-break><h2>Two</h2><p>b</p>';
  const pages = splitIntoPages(html);
  assert.equal(pages.length, 2);
  assert.match(pages[0].html, /One/);
  assert.doesNotMatch(pages[0].html, /data-page-break/); // break removed from output
  assert.doesNotMatch(pages[0].html, /Two/);
  assert.match(pages[1].html, /Two/);
  assert.equal(pages[0].title, 'One');
  assert.equal(pages[1].title, 'Two');
});

test('headings split content when no explicit break', () => {
  const html = '<h2>Alpha</h2><p>first</p><h3>Beta</h3><p>second</p>';
  const pages = splitIntoPages(html);
  assert.equal(pages.length, 2);
  assert.match(pages[0].html, /Alpha/);
  assert.match(pages[0].html, /first/);
  assert.doesNotMatch(pages[0].html, /Beta/);
  assert.match(pages[1].html, /Beta/);
});

test('plain paragraphs are chunked by character budget', () => {
  const para = '<p>' + 'x'.repeat(600) + '</p>';
  const html = para.repeat(5);
  const pages = splitIntoPages(html, { maxChars: 1000 });
  assert.ok(pages.length >= 2);
  for (const p of pages) assert.ok(p.html.length > 0);
});

test('loose text nodes are wrapped into paragraphs', () => {
  const pages = splitIntoPages('just text');
  assert.equal(pages.length, 1);
  assert.match(pages[0].html, /<p>just text<\/p>/);
});

test('page indices are sequential starting at 0', () => {
  const pages = splitIntoPages('<h2>A</h2><p>1</p><hr data-page-break><h2>B</h2><p>2</p>');
  assert.deepEqual(pages.map((p) => p.index), [0, 1]);
});
