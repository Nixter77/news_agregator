const crypto = require('crypto');
const { CONFIG } = require('./config');
const { fetchWithRetry } = require('./net');
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
      if (result) this.cache.set(task.cacheKey, result, CONFIG.CACHE.TRANSLATION_TTL);
      task.resolve(result || null);
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
      const response = await fetchWithRetry(
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
        }
      );
      const data = await response.json();
      const translated = data?.data?.translations?.[0]?.translatedText;
      if (typeof translated !== 'string' || !translated) throw new Error('Invalid format');
      return translated;
    }

    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
    const response = await fetchWithRetry(url, { attempts: 2, timeoutMs: CONFIG.FETCH.TIMEOUT });
    const data = await response.json();
    if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('Invalid format');
    return data[0].map((item) => (Array.isArray(item) ? item[0] : '')).join('');
  }
}

module.exports = { TranslationService, translationCacheKey };
