const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../server');

let server;
let baseUrl;

before(async () => {
  server = app.listen(0, '127.0.0.1');
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
    if (app.services.rateLimiter?.destroy) app.services.rateLimiter.destroy();
    if (app.services.rssService?.articleStore?.destroy) app.services.rssService.articleStore.destroy();
  }
  if (server) {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise(resolve => server.close(resolve));
  }
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
  assert.ok(body.categories && Array.isArray(body.categories.tech));
  assert.ok(Array.isArray(body.topSources));
  const bbc = body.sources.find(source => source.id === 'bbc');
  assert.ok(Array.isArray(bbc.categories));
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
  const html = await response.text();
  assert.match(html, /js\/theme-boot\.js\?v=/);
});

test('dark theme tokens are valid standalone CSS rules', async () => {
  const response = await fetch(`${baseUrl}/css/style.css`, { headers: { connection: 'close' } });
  assert.equal(response.status, 200);
  const css = await response.text();
  assert.match(css, /\[data-theme="dark"\]\s*\{/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.doesNotMatch(css, /\[data-theme="dark"\],\s*@media/);
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

test('article endpoint rejects unknown source', async () => {
  const params = new URLSearchParams({ source: 'nope', id: '123' });
  const response = await fetch(`${baseUrl}/api/article?${params}`, { headers: { connection: 'close' } });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'Unknown source');
});

test('rejects invalid JSON body on translate', async () => {
  const response = await fetch(`${baseUrl}/api/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', connection: 'close' },
    body: '{not-json'
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
});

test('batch translate endpoint translates array of texts', async () => {
  const response = await fetch(`${baseUrl}/api/translate/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', connection: 'close' },
    body: JSON.stringify({ texts: ['Hello world', 'Breaking news'], to: 'ru' })
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(Array.isArray(body.translations), true);
  assert.equal(body.translations.length, 2);
  assert.equal(body.translations[0].original, 'Hello world');
  assert.equal(typeof body.translations[0].translated, 'string');
});

test('search endpoint includes title_ru and snippet_ru fields', async () => {
  const response = await fetch(`${baseUrl}/api/search?translate=false`, {
    headers: { connection: 'close' }
  });
  // 200 with results, or 503 if all upstream feeds are down
  assert.ok(response.status === 200 || response.status === 503);
  const body = await response.json();
  if (response.status === 503) {
    assert.equal(body.ok, false);
    assert.equal(body.degraded, true);
    return;
  }
  assert.equal(body.ok, true);
  assert.equal(Array.isArray(body.results), true);
  assert.ok('degraded' in body);
  assert.ok(Array.isArray(body.sourcesFailed));
  assert.ok(Array.isArray(body.sourcesUsed));
  assert.ok('generatedAt' in body);
  if (body.results.length > 0) {
    assert.ok('title_ru' in body.results[0]);
    assert.ok('snippet_ru' in body.results[0]);
  }
});

test('unknown api path returns json 404', async () => {
  const response = await fetch(`${baseUrl}/api/nope`, { headers: { connection: 'close' } });
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'Not found');
});

test('rejects repeated query params instead of silently defaulting', async () => {
  const response = await fetch(`${baseUrl}/api/search?q=a&q=b`, { headers: { connection: 'close' } });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /single value/);
});

test('rejects unknown search category', async () => {
  const response = await fetch(`${baseUrl}/api/search?category=TECH`, { headers: { connection: 'close' } });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'Unknown category');
});

test('article endpoint returns 404 when body is not in store', async () => {
  const params = new URLSearchParams({ source: 'bbc', id: 'missing-article-id' });
  const response = await fetch(`${baseUrl}/api/article?${params}`, { headers: { connection: 'close' } });
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'Article not found');
});

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Example</title>
<item>
  <title>Hello world</title>
  <link>https://example.com/hello</link>
  <description>Snippet</description>
  <pubDate>Wed, 12 Aug 2026 12:00:00 GMT</pubDate>
  <guid>hello-1</guid>
</item>
</channel></rss>`;

function xmlResponse(body = SAMPLE_RSS, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/rss+xml' },
  });
}

test('resolveSources uses top tier and honors skip keys', () => {
  const { resolveSources, TOP_SOURCES } = app.helpers;
  const top = resolveSources({});
  assert.deepEqual(top, TOP_SOURCES);
  assert.equal(top.includes('reuters_world'), false);
  assert.deepEqual(resolveSources({ sourceKey: 'bbc', category: 'tech' }), ['bbc']);
  assert.ok(resolveSources({ category: 'tech' }).includes('techcrunch'));
  const skipped = resolveSources({ skipKeys: new Set(['bbc']) });
  assert.equal(skipped.includes('bbc'), false);
  assert.ok(skipped.length > 0);
});

test('parallel fetchFeed shares one origin GET', async () => {
  let calls = 0;
  app.services.setFetchImpl(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 40));
    return xmlResponse();
  });
  try {
    const url = `https://example.test/parallel-${Date.now()}.xml`;
    const [first, second] = await Promise.all([
      app.services.rssService.fetchFeed('bbc', url),
      app.services.rssService.fetchFeed('bbc', url),
    ]);
    assert.equal(calls, 1);
    assert.equal(first.failed, false);
    assert.equal(second.articles.length, 1);
    assert.equal(second.articles[0].title, 'Hello world');
  } finally {
    app.services.setFetchImpl(null);
  }
});

test('forceRefresh issues a new origin GET', async () => {
  let calls = 0;
  app.services.setFetchImpl(async () => {
    calls += 1;
    return xmlResponse();
  });
  try {
    const url = `https://example.test/refresh-${Date.now()}.xml`;
    await app.services.rssService.fetchFeed('bbc', url);
    await app.services.rssService.fetchFeed('bbc', url, { forceRefresh: true });
    assert.equal(calls, 2);
  } finally {
    app.services.setFetchImpl(null);
  }
});

test('forceRefresh does not reuse a non-force in-flight fetch', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  app.services.setFetchImpl(async () => {
    const n = ++calls;
    if (n === 1) await gate;
    return xmlResponse();
  });
  try {
    const url = `https://example.test/force-inflight-${Date.now()}.xml`;
    const first = app.services.rssService.fetchFeed('bbc', url);
    const second = app.services.rssService.fetchFeed('bbc', url, { forceRefresh: true });
    release();
    await first;
    await second;
    assert.equal(calls, 2);
  } finally {
    app.services.setFetchImpl(null);
  }
});

test('HTML upstream is treated as a failed feed', async () => {
  app.services.setFetchImpl(async () => new Response('<!DOCTYPE html><html><body>nope</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  }));
  try {
    const result = await app.services.rssService.fetchFeed('bbc', `https://example.test/html-${Date.now()}`);
    assert.equal(result.failed, true);
    assert.equal(result.articles.length, 0);
  } finally {
    app.services.setFetchImpl(null);
  }
});

test('search cache hit preserves degraded metadata', async () => {
  const payload = {
    results: [{ id: '1', title: 'Cached', snippet: 'x', source: 'bbc' }],
    degraded: true,
    generatedAt: '2026-08-12T00:00:00.000Z',
    sourcesFailed: ['cnn'],
    sourcesUsed: ['bbc'],
  };
  app.services.searchService.searchCache.set('search:all::false:all', payload, 60_000);

  const result = await app.services.searchService.search('', '', {
    viewAll: false,
    refresh: false,
    category: 'all',
  });
  assert.equal(result.cached, true);
  assert.equal(result.degraded, true);
  assert.deepEqual(result.sourcesFailed, ['cnn']);
  assert.equal(result.generatedAt, '2026-08-12T00:00:00.000Z');
});

