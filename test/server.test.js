const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../server');

let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  await new Promise(resolve => {
    server.once('listening', resolve);
  });

  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (!server) return;
  await new Promise(resolve => server.close(resolve));
});

test('health endpoint reports ok', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(typeof body.uptime, 'number');
  assert.equal(typeof body.cache.rss, 'number');
  assert.equal(typeof body.cache.translation, 'number');
});

test('sources endpoint exposes feed metadata', async () => {
  const response = await fetch(`${baseUrl}/api/sources`);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.sources));
  assert.ok(body.sources.some(source => source.id === 'bbc'));
});

test('serves the local css asset on the canonical path', async () => {
  const response = await fetch(`${baseUrl}/css/style.css`);
  assert.equal(response.status, 200);

  const css = await response.text();
  assert.match(css, /\.news-card/);
});

test('homepage renders the quick-topic UX affordances', async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/html/);

  const html = await response.text();
  assert.match(html, /data-quick-topic="Украина"/);
  assert.match(html, /hero-meta/);
  assert.match(html, /search-feedback/);
  assert.match(html, /save-search-button/);
  assert.match(html, /saved-searches-list/);
  assert.match(html, /favorites-title/);
  assert.match(html, /favorites-list/);
});

test('rejects unknown sources before performing a search', async () => {
  const params = new URLSearchParams({ source: 'does-not-exist' });
  const response = await fetch(`${baseUrl}/api/search?${params.toString()}`);

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'Unknown source');
});

test('rejects overly long search queries', async () => {
  const params = new URLSearchParams({
    q: 'x'.repeat(app.config.SEARCH.MAX_QUERY_LENGTH + 1)
  });
  const response = await fetch(`${baseUrl}/api/search?${params.toString()}`);

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /Query too long/);
});

test('translate endpoint validates empty text input', async () => {
  const response = await fetch(`${baseUrl}/api/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '   ' })
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'Text required');
});
