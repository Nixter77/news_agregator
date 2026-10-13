const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'js', 'text.js')).href);
const re = (token) => ({ token, re: new RegExp(`(${token})`, 'gi') });

test('highlighting does not break HTML entities', async () => {
  const { highlightHtml } = await load();
  assert.equal(highlightHtml('Tom & Jerry', [re('amp')]), 'Tom &amp; Jerry');
  assert.equal(highlightHtml('a < b', [re('lt')]), 'a &lt; b');
  assert.equal(highlightHtml('<b>amp</b>', [re('amp')]), '&lt;b&gt;<mark class="news-highlight">amp</mark>&lt;/b&gt;');
});

test('highlighting marks every token and escapes inside marks', async () => {
  const { highlightHtml } = await load();
  assert.equal(
    highlightHtml('Israel & Ukraine news', [re('israel'), re('ukraine')]),
    '<mark class="news-highlight">Israel</mark> &amp; <mark class="news-highlight">Ukraine</mark> news',
  );
  assert.equal(highlightHtml('a&b', [re('a&b')]), '<mark class="news-highlight">a&amp;b</mark>');
  assert.equal(highlightHtml('', [re('x')]), '');
  assert.equal(highlightHtml('<x>', []), '&lt;x&gt;');
});
