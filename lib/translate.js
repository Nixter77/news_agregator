const crypto = require('crypto');
const { CONFIG } = require('./config');
const { fetchWithRetry, readLimitedText } = require('./net');

const TRANSLATE_MAX_BODY_BYTES = 512 * 1024;
const CHUNK_MAX_CHARS = 1500;

/**
 * Split text into pieces of at most `max` chars, preferring sentence
 * boundaries, then whitespace. Joining the pieces gives back the input.
 */
function splitIntoChunks(text, max = CHUNK_MAX_CHARS) {
  const src = String(text);
  if (src.length <= max) return [src];
  const sentences = src.match(/[^.!?\u3002\n]*(?:[.!?\u3002\n]+|$)\s*/g).filter(Boolean);
  const chunks = [];
  let current = '';
  const pushPiece = (piece) => {
    while (piece.length > max) {
      let cut = piece.lastIndexOf(' ', max);
      if (cut <= 0) cut = max;
      chunks.push(piece.slice(0, cut));
      piece = piece.slice(cut);
    }
    return piece;
  };
  for (const sentence of sentences) {
    if (current.length + sentence.length <= max) {
      current += sentence;
      continue;
    }
    if (current) chunks.push(current);
    current = pushPiece(sentence);
  }
  if (current) chunks.push(current);
  return chunks;
}

const DEFAULT_BACKOFF_MS = 60 * 1000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;

/** Shared across all requests: endpoint client -> epoch ms until which it is paused after a 429. */
const rateLimitedUntil = new Map();

function parseRetryAfterMs(value, now = Date.now()) {
  if (value == null || value === '') return DEFAULT_BACKOFF_MS;
  const secs = Number(value);
  let ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(value) - now;
  if (!Number.isFinite(ms) || ms <= 0) ms = DEFAULT_BACKOFF_MS;
  return Math.min(ms, MAX_BACKOFF_MS);
}

/**
 * Strictly validate the translate_a/single shape: [[[translated, source, ...], ...], ..., detectedLang].
 * Anything else (HTML captcha decoded as junk, objects, numbers) is rejected.
 */
function parseFreeResponse(data) {
  if (!Array.isArray(data) || !Array.isArray(data[0]) || data[0].length === 0) {
    throw new Error('Invalid format');
  }
  let out = '';
  for (const segment of data[0]) {
    if (!Array.isArray(segment)) throw new Error('Invalid format');
    if (segment[0] == null) continue;
    if (typeof segment[0] !== 'string') throw new Error('Invalid format');
    out += segment[0];
  }
  return out;
}

function sameLang(detected, target) {
  const base = (v) => String(v || '').toLowerCase().split(/[-_]/)[0];
  return Boolean(detected) && base(detected) === base(target);
}

const readJson = async (response) => JSON.parse(await readLimitedText(response, TRANSLATE_MAX_BODY_BYTES));
const { isTranslatableText } = require('./text');
const { recordMetric } = require('./metrics');

function translationCacheKey(targetLang, text) {
  const hash = crypto.createHash('sha1').update(String(text)).digest('hex');
  return `${String(targetLang || 'ru').toLowerCase()}|${hash}`;
}

/**
 * Translation with a bounded queue. Failures resolve to null
 * (never pretend the original text is a translation).
 */
class TranslationService {
  constructor(cache) {
    this.cache = cache;
    this.queue = [];
    this.pendingTranslations = new Map();
    this.activeWorkers = 0;
    this.maxWorkers = CONFIG.FETCH.MAX_CONCURRENT_TRANSLATIONS;
    this.queueLimit = CONFIG.TRANSLATION.QUEUE_LIMIT;
  }

  /**
   * @returns {Promise<string|null>} translated text, or null on failure / overload
   */
  async translate(text, targetLang = 'ru') {
    if (!isTranslatableText(text)) return null;
    const cacheKey = translationCacheKey(targetLang, text);

    const cached = this.cache.get(cacheKey);
    if (cached != null) return cached;

    if (typeof this.cache.getAsync === 'function') {
      const remote = await this.cache.getAsync(cacheKey);
      if (remote != null) return remote;
    }

    if (this.pendingTranslations.has(cacheKey)) {
      return this.pendingTranslations.get(cacheKey);
    }

    if (this.queue.length >= this.queueLimit) {
      console.warn('[translation] queue full, dropping request');
      recordMetric('translateFail');
      return null;
    }

    let resolveFn;
    const promise = new Promise((resolve) => {
      resolveFn = resolve;
    }).finally(() => {
      if (this.pendingTranslations.get(cacheKey) === promise) {
        this.pendingTranslations.delete(cacheKey);
      }
    });

    this.pendingTranslations.set(cacheKey, promise);
    this.queue.push({ text, targetLang, resolve: resolveFn, cacheKey });
    this.processQueue();
    return promise;
  }

  getCached(text, targetLang = 'ru') {
    if (!isTranslatableText(text)) return null;
    return this.cache.get(translationCacheKey(targetLang, text));
  }

  async processQueue() {
    if (this.queue.length === 0 || this.activeWorkers >= this.maxWorkers) return;

    const task = this.queue.shift();
    this.activeWorkers++;

    try {
      const result = await this._performTranslation(task.text, task.targetLang);
      const text = result?.text || null;
      // Never cache the source text as if it were a translation: when the
      // source already is in the target language (or the engine echoed the
      // input), return it for display but keep it out of the cache.
      const echoed = text != null && text.trim() === String(task.text).trim();
      if (text && !result.sameLanguage && !echoed) {
        this.cache.set(task.cacheKey, text, CONFIG.CACHE.TRANSLATION_TTL);
      }
      task.resolve(text);
    } catch (error) {
      console.warn('[translation] failed:', error.message);
      recordMetric('translateFail');
      task.resolve(null);
    } finally {
      this.activeWorkers--;
      this.processQueue();
    }
  }

  async _performTranslation(text, targetLang) {
    const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY || '';
    if (apiKey) {
      const data = await fetchWithRetry(
        `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(apiKey)}`,
        {
          attempts: 2,
          timeoutMs: CONFIG.FETCH.TIMEOUT,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ q: text, target: targetLang, format: 'text' }),
          read: readJson,
        }
      );
      const entry = data?.data?.translations?.[0];
      const translated = entry?.translatedText;
      if (typeof translated !== 'string' || !translated) throw new Error('Invalid format');
      return { text: translated, sameLanguage: sameLang(entry.detectedSourceLanguage, targetLang) };
    }

    // Free endpoints take the text in the GET query string; long texts are
    // split by sentences so URLs stay well below server limits.
    const chunks = splitIntoChunks(text, CHUNK_MAX_CHARS);
    const parts = [];
    let allSame = true;
    for (const chunk of chunks) {
      const { text: out, detected } = await this._translateChunk(chunk, targetLang);
      parts.push(out);
      if (!sameLang(detected, targetLang)) allSame = false;
    }
    if (allSame) return { text: String(text), sameLanguage: true };
    return { text: parts.join(''), sameLanguage: false };
  }

  async _translateChunk(text, targetLang) {
    // Google started answering client=gtx with an HTML "Sorry..." captcha page,
    // so try several free clients in order and use the first valid JSON answer.
    const q = encodeURIComponent(text);
    const tl = encodeURIComponent(targetLang);
    const clients = ['dict-chrome-ex', 'gtx'];
    let lastError = null;
    for (const client of clients) {
      if ((rateLimitedUntil.get(client) || 0) > Date.now()) {
        lastError = Object.assign(new Error(`client ${client} backing off after 429`), { status: 429 });
        continue;
      }
      const url = `https://translate.googleapis.com/translate_a/single?client=${client}&sl=auto&tl=${tl}&dt=t&q=${q}`;
      try {
        let data;
        try {
          data = await fetchWithRetry(url, {
            attempts: 2,
            timeoutMs: CONFIG.FETCH.TIMEOUT,
            headers: { Accept: 'application/json' },
            read: readJson,
            retryOn429: false,
          });
        } catch (err) {
          if (err?.status === 429) {
            rateLimitedUntil.set(client, Date.now() + parseRetryAfterMs(err.retryAfter));
            recordMetric('translateRateLimited');
          }
          throw err;
        }
        const out = parseFreeResponse(data);
        if (!out) throw new Error('Empty translation');
        return { text: out, detected: typeof data[2] === 'string' ? data[2] : '' };
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('Translation failed');
  }
}

module.exports = { TranslationService, parseFreeResponse, rateLimitedUntil, parseRetryAfterMs, translationCacheKey, splitIntoChunks, TRANSLATE_MAX_BODY_BYTES, CHUNK_MAX_CHARS };
