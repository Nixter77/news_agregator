const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
delete process.env.GOOGLE_TRANSLATE_API_KEY;

const { setFetchImpl } = require('../lib/net');
const { TranslationService, TRANSLATE_MAX_BODY_BYTES } = require('../lib/translate');

function memCache() {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v), size: () => m.size, map: m };
}

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

afterEach(() => {
  setFetchImpl(null);
  require('../lib/translate').rateLimitedUntil.clear();
});

test('translation body read is bounded in size', async () => {
  const urls = [];
  setFetchImpl(async (url) => {
    urls.push(String(url));
    return new Response('x'.repeat(TRANSLATE_MAX_BODY_BYTES + 10), { status: 200 });
  });
  const svc = new TranslationService(memCache());
  assert.equal(await svc.translate('Hello big world'), null);
});

test('translation body read is covered by the timeout', async () => {
  setFetchImpl(async (url, { signal }) => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('[[["При'));
        signal.addEventListener('abort', () => controller.error(new Error('aborted')));
      },
    });
    return new Response(body, { status: 200 });
  });
  const svc = new TranslationService(memCache());
  const { CONFIG } = require('../lib/config');
  const saved = CONFIG.FETCH.TIMEOUT;
  CONFIG.FETCH.TIMEOUT = 150;
  try {
    const started = Date.now();
    assert.equal(await svc.translate('Hello slow world'), null);
    assert.ok(Date.now() - started < 5000, 'must not hang on a stalled body');
  } finally {
    CONFIG.FETCH.TIMEOUT = saved;
  }
});

test('dict-chrome-ex is tried before gtx', async () => {
  const urls = [];
  setFetchImpl(async (url) => {
    urls.push(String(url));
    return jsonResponse([[['Привет мир', 'Hello world', null, null]], null, 'en']);
  });
  const svc = new TranslationService(memCache());
  assert.equal(await svc.translate('Hello world'), 'Привет мир');
  assert.match(urls[0], /client=dict-chrome-ex/);
});

test('long texts are split into sentence chunks that rebuild the input', () => {
  const { splitIntoChunks, CHUNK_MAX_CHARS } = require('../lib/translate');
  const sentence = 'This is a reasonably long sentence about the news of the day. ';
  const text = sentence.repeat(80) + 'x'.repeat(CHUNK_MAX_CHARS + 100);
  const chunks = splitIntoChunks(text);
  assert.ok(chunks.length > 2);
  assert.equal(chunks.join(''), text);
  for (const c of chunks) assert.ok(c.length <= CHUNK_MAX_CHARS, `chunk too long: ${c.length}`);
  assert.deepEqual(splitIntoChunks('short'), ['short']);
});

test('long texts are translated chunk by chunk with short URLs', async () => {
  const { CHUNK_MAX_CHARS } = require('../lib/translate');
  const urls = [];
  setFetchImpl(async (url) => {
    urls.push(String(url));
    return jsonResponse([[['Часть. ', 'Part. ', null, null]], null, 'en']);
  });
  const svc = new TranslationService(memCache());
  const text = 'Part of a long article body sentence. '.repeat(100);
  const out = await svc.translate(text);
  assert.ok(urls.length >= Math.ceil(text.length / CHUNK_MAX_CHARS));
  assert.equal(out, 'Часть. '.repeat(urls.length));
  for (const u of urls) assert.ok(u.length < 6000, `url too long: ${u.length}`);
});

test('429 pauses the client for Retry-After and falls through to the next one', async () => {
  const { rateLimitedUntil, parseRetryAfterMs } = require('../lib/translate');
  const urls = [];
  setFetchImpl(async (url) => {
    urls.push(String(url));
    if (String(url).includes('client=dict-chrome-ex')) {
      return new Response('slow down', { status: 429, headers: { 'retry-after': '120' } });
    }
    return jsonResponse([[['Привет', 'Hello', null, null]], null, 'en']);
  });
  const svc = new TranslationService(memCache());
  assert.equal(await svc.translate('Hello there'), 'Привет');
  assert.equal(urls.filter((u) => u.includes('dict-chrome-ex')).length, 1, 'no retry storm on 429');
  const until = rateLimitedUntil.get('dict-chrome-ex');
  assert.ok(until - Date.now() > 100 * 1000 && until - Date.now() <= 120 * 1000);

  urls.length = 0;
  assert.equal(await svc.translate('Hello again'), 'Привет');
  assert.ok(urls.every((u) => u.includes('client=gtx')), 'paused client is skipped');

  assert.equal(parseRetryAfterMs(undefined), 60 * 1000);
  assert.equal(parseRetryAfterMs('999999'), 15 * 60 * 1000);
});

test('when every client is rate limited translation fails fast without fetching', async () => {
  const { rateLimitedUntil } = require('../lib/translate');
  rateLimitedUntil.set('dict-chrome-ex', Date.now() + 60000);
  rateLimitedUntil.set('gtx', Date.now() + 60000);
  let calls = 0;
  setFetchImpl(async () => { calls += 1; return jsonResponse([]); });
  const svc = new TranslationService(memCache());
  assert.equal(await svc.translate('Hello paused'), null);
  assert.equal(calls, 0);
});

test('free translate response shape is validated strictly', async () => {
  const { parseFreeResponse } = require('../lib/translate');
  assert.equal(parseFreeResponse([[['Привет ', 'Hello '], ['мир', 'world']], null, 'en']), 'Привет мир');
  for (const bad of [{}, [], [[]], [['oops']], [[[42, 'Hello']]], [[[{ a: 1 }, 'x']]], 'str']) {
    assert.throws(() => parseFreeResponse(bad), /Invalid format/, JSON.stringify(bad));
  }

  const urls = [];
  setFetchImpl(async (url) => {
    urls.push(String(url));
    if (String(url).includes('dict-chrome-ex')) return jsonResponse([[[{ x: 1 }, 'Hello']]]);
    return jsonResponse([[['Привет', 'Hello']], null, 'en']);
  });
  const svc = new TranslationService(memCache());
  assert.equal(await svc.translate('Hello shape'), 'Привет');
  assert.equal(urls.length, 2, 'malformed answer falls through to the next client');
});

test('text already in the target language is returned but never cached', async () => {
  setFetchImpl(async () => jsonResponse([[['Привет мир', 'Привет мир']], null, 'ru']));
  const cache = memCache();
  const svc = new TranslationService(cache);
  assert.equal(await svc.translate('Привет мир', 'ru'), 'Привет мир');
  assert.equal(cache.map.size, 0);
});

test('echoed source text is not cached as a translation', async () => {
  setFetchImpl(async () => jsonResponse([[['Hello echo', 'Hello echo']], null, 'en']));
  const cache = memCache();
  const svc = new TranslationService(cache);
  assert.equal(await svc.translate('Hello echo', 'ru'), 'Hello echo');
  assert.equal(cache.map.size, 0);
});

test('real translations are cached', async () => {
  setFetchImpl(async () => jsonResponse([[['Привет кэш', 'Hello cache']], null, 'en']));
  const cache = memCache();
  const svc = new TranslationService(cache);
  assert.equal(await svc.translate('Hello cache', 'ru'), 'Привет кэш');
  assert.equal(cache.map.size, 1);
});
