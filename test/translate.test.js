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

afterEach(() => setFetchImpl(null));

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
