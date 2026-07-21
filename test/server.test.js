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
  if (app.services) {
    if (app.services.rssCache?.destroy) app.services.rssCache.destroy();
    if (app.services.translationCache?.destroy) app.services.translationCache.destroy();
    if (app.services.searchService?.searchCache?.destroy) app.services.searchService.searchCache.destroy();
  }
  if (server) {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise(resolve => server.close(resolve));
  }
  process.exit(0);
});

test('health endpoint reports ok', async () => {
  const response = await fetch(`${baseUrl}/health`, { headers: { connection: 'close' } });
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(typeof body.uptime, 'number');
  assert.equal(typeof body.cache.rss, 'number');
  assert.equal(typeof body.cache.translation, 'number');
  assert.equal(typeof body.cache.search, 'number');
});

test('sources endpoint exposes feed metadata and caching headers', async () => {
  const response = await fetch(`${baseUrl}/api/sources`, { headers: { connection: 'close' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') || '', /max-age=86400/);

  const body = await response.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.sources));
  assert.ok(body.sources.some(source => source.id === 'bbc'));
});

test('serves local css asset with 7-day cache-control header', async () => {
  const response = await fetch(`${baseUrl}/css/style.css`, { headers: { connection: 'close' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') || '', /max-age=/);

  const css = await response.text();
  assert.match(css, /\.news-card/);
});

test('homepage renders basic layout', async () => {
  const response = await fetch(`${baseUrl}/`, { headers: { connection: 'close' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/html/);
});

test('rejects unknown sources before performing a search', async () => {
  const params = new URLSearchParams({ source: 'does-not-exist' });
  const response = await fetch(`${baseUrl}/api/search?${params.toString()}`, { headers: { connection: 'close' } });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'Unknown source');
});

test('rejects overly long search queries', async () => {
  const params = new URLSearchParams({
    q: 'x'.repeat(app.config.SEARCH.MAX_QUERY_LENGTH + 1)
  });
  const response = await fetch(`${baseUrl}/api/search?${params.toString()}`, { headers: { connection: 'close' } });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /Query too long/);
});

test('translate endpoint validates empty text input', async () => {
  const response = await fetch(`${baseUrl}/api/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', connection: 'close' },
    body: JSON.stringify({ text: '   ' })
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'Text required');
});

test('batch translate endpoint validates empty input array', async () => {
  const response = await fetch(`${baseUrl}/api/translate/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', connection: 'close' },
    body: JSON.stringify({ texts: [] })
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'Array of texts required');
});

test('article endpoint requires source and id', async () => {
  const response = await fetch(`${baseUrl}/api/article`, { headers: { connection: 'close' } });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'Source and id required');
});
