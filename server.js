/**
 * News Aggregator Backend
 *
 * Service-based design with SWR caching, bounded concurrency,
 * graceful degradation, and request-level translation budgets.
 */

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const crypto = require('crypto');
const xml2js = require('xml2js');

dotenv.config();

const CONFIG = {
  PORT: process.env.PORT || 3000,
  ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || '*',
  CACHE: {
    RSS_TTL: 5 * 60 * 1000,
    RSS_STALE_WINDOW: 20 * 60 * 1000,
    TRANSLATION_TTL: 24 * 60 * 60 * 1000,
    SEARCH_TTL: 60 * 1000,
    SEARCH_EMPTY_TTL: 10 * 1000,
    RSS_LIMIT: 100,
    TRANSLATION_LIMIT: 2000,
    SEARCH_LIMIT: 200,
  },
  FETCH: {
    TIMEOUT: 8000,
    RETRIES: 2,
    RETRY_BASE_MS: 300,
    MAX_CONCURRENT_TRANSLATIONS: 5,
    MAX_CONCURRENT_FEEDS: 15,
    MAX_ITEMS_PER_FEED: 40,
  },
  RATE_LIMIT: {
    WINDOW_MS: 60 * 1000,
    MAX_REQUESTS: 60,
  },
  SEARCH: {
    MAX_QUERY_LENGTH: 500,
    MAX_RESULTS_VIEW_ALL: 100,
    MAX_RESULTS_DEFAULT: 30,
    MAX_TRANSLATED_RESULTS: 10,
    TRANSLATE_BUDGET_MS: 4000,
  },
  TRANSLATION: {
    QUEUE_LIMIT: 200,
    MAX_TEXT_LENGTH: 10000,
    MAX_BATCH_ITEM_LENGTH: 2000,
  },
};

/** @type {Record<string, { url: string, title: string, categories: string[] }>} */
const SOURCES = {
  bbc: { url: 'https://feeds.bbci.co.uk/news/rss.xml', title: 'BBC News', categories: ['world'] },
  nyt: { url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', title: 'The New York Times', categories: ['world'] },
  guardian: { url: 'https://www.theguardian.com/world/rss', title: 'The Guardian', categories: ['world'] },
  cnn: { url: 'https://rss.cnn.com/rss/cnn_topstories.rss', title: 'CNN', categories: ['world'] },
  aljazeera: { url: 'https://www.aljazeera.com/xml/rss/all.xml', title: 'Al Jazeera', categories: ['world'] },
  npr: { url: 'https://feeds.npr.org/1001/rss.xml', title: 'NPR', categories: ['world'] },
  techcrunch: { url: 'https://techcrunch.com/feed/', title: 'TechCrunch', categories: ['tech'] },
  verge: { url: 'https://www.theverge.com/rss/index.xml', title: 'The Verge', categories: ['tech'] },
  wired: { url: 'https://www.wired.com/feed/rss', title: 'WIRED', categories: ['tech'] },
  engadget: { url: 'https://www.engadget.com/rss.xml', title: 'Engadget', categories: ['tech'] },
  arstechnica: { url: 'https://feeds.arstechnica.com/arstechnica/index', title: 'Ars Technica', categories: ['tech'] },
  atlantic: { url: 'https://www.theatlantic.com/feed/all/', title: 'The Atlantic', categories: ['culture'] },
  newyorker: { url: 'https://www.newyorker.com/feed/everything', title: 'The New Yorker', categories: ['culture'] },
  hackernews: { url: 'https://hnrss.org/frontpage', title: 'Hacker News', categories: ['tech'] },
  reddit_news: { url: 'https://www.reddit.com/r/worldnews/.rss', title: 'Reddit World News', categories: ['world'] },
  bbc_tech: { url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', title: 'BBC Tech', categories: ['tech'] },
  bbc_business: { url: 'https://feeds.bbci.co.uk/news/business/rss.xml', title: 'BBC Business', categories: ['business'] },
  nyt_world: { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', title: 'NYT World', categories: ['world'] },
  nyt_tech: { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml', title: 'NYT Tech', categories: ['tech'] },
  reuters_world: { url: 'https://www.reutersagency.com/feed/?taxonomy=best-topics&post_type=best', title: 'Reuters', categories: ['world'] },
  politico: { url: 'https://rss.politico.com/politics-news.xml', title: 'Politico', categories: ['world'] },
  axios: { url: 'https://api.axios.com/feed/', title: 'Axios', categories: ['business'] },
  bloomberg_tech: { url: 'https://feeds.bloomberg.com/technology/news.rss', title: 'Bloomberg Tech', categories: ['tech'] },
  forbes: { url: 'https://www.forbes.com/innovation/feed2/', title: 'Forbes', categories: ['business'] },
  sciencedaily: { url: 'https://www.sciencedaily.com/rss/all.xml', title: 'Science Daily', categories: ['science'] },
  nature: { url: 'https://www.nature.com/nature.rss', title: 'Nature', categories: ['science'] },
  phys: { url: 'https://phys.org/rss-feed/', title: 'Phys.org', categories: ['science'] },
  space: { url: 'https://www.space.com/feeds/all', title: 'Space.com', categories: ['science'] },
  espn: { url: 'https://www.espn.com/espn/rss/news', title: 'ESPN', categories: ['sports'] },
};

const TOP_SOURCES = ['bbc', 'nyt', 'guardian', 'cnn', 'npr', 'techcrunch', 'verge', 'reuters_world', 'forbes', 'aljazeera'];

const CATEGORY_SOURCES = {
  tech: ['techcrunch', 'verge', 'wired', 'engadget', 'arstechnica', 'hackernews', 'bbc_tech', 'nyt_tech', 'bloomberg_tech'],
  business: ['forbes', 'bbc_business', 'axios'],
  world: ['nyt_world', 'reddit_news', 'politico', 'bbc', 'nyt', 'guardian', 'cnn', 'aljazeera', 'npr', 'reuters_world'],
  science: ['sciencedaily', 'nature', 'phys', 'space'],
  culture: ['atlantic', 'newyorker'],
  sports: ['espn'],
};

const CSP_HEADER =
  "default-src 'self'; " +
  "script-src 'self' https://cdn.jsdelivr.net; " +
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; " +
  "img-src 'self' data: https:; " +
  "connect-src 'self';";

/**
 * Resolve which feed keys to query for a search.
 * category 'all' / empty must NOT force full fan-out (TOP_SOURCES path).
 */
function resolveSources({ sourceKey, normQuery, viewAll, category }) {
  if (sourceKey && SOURCES[sourceKey]) return [sourceKey];

  const cat = category && category !== 'all' ? category : null;
  if (cat && CATEGORY_SOURCES[cat]) {
    return CATEGORY_SOURCES[cat].filter((id) => SOURCES[id]);
  }

  if (normQuery || viewAll) return Object.keys(SOURCES);
  return TOP_SOURCES;
}

function normalizeLink(link) {
  return String(link || '')
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/\/$/, '');
}

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[\s,.;:!?"'()\[\]{}<>/@#%^&*+=|~`]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function scoreArticle(article, tokens) {
  let score = 0;
  const title = String(article?.title || '').toLowerCase();
  const snippet = String(article?.snippet || '').toLowerCase();

  for (const token of tokens) {
    if (title.includes(token)) score += 5;
    else if (snippet.includes(token)) score += 2;
  }
  return score;
}

function dedupeArticles(articles) {
  const deduplicated = [];
  const seenLinks = new Set();
  const seenTitles = new Set();

  for (const article of articles) {
    const cleanLink = article.cleanLink || normalizeLink(article.link);
    const normTitle = article.normTitle || normalizeTitle(article.title);

    if ((cleanLink && seenLinks.has(cleanLink)) || (normTitle && seenTitles.has(normTitle))) {
      continue;
    }

    deduplicated.push(article);
    if (cleanLink) seenLinks.add(cleanLink);
    if (normTitle) seenTitles.add(normTitle);
  }
  return deduplicated;
}

async function withTimeout(promise, ms, fallback) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('budget exceeded')), ms);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url, { attempts = CONFIG.FETCH.RETRIES, timeoutMs = CONFIG.FETCH.TIMEOUT } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.ok) return response;

      const retryable = response.status === 429 || response.status >= 500;
      lastError = new Error(`Status ${response.status}`);
      if (!retryable) throw lastError;
    } catch (error) {
      lastError = error;
      const msg = String(error?.message || '');
      const nonRetryableHttp = /^Status (4\d\d)$/.test(msg) && !msg.includes('Status 429');
      if (nonRetryableHttp) throw error;
      if (i < attempts - 1) {
        const delay = CONFIG.FETCH.RETRY_BASE_MS * 2 ** i + Math.random() * 100;
        await new Promise((r) => setTimeout(r, delay));
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw lastError;
}

class LRUCache {
  constructor(limit, ttlFn = null) {
    this.limit = limit;
    this.ttlFn = ttlFn;
    this.cache = new Map();
    this._pruneInterval = setInterval(() => this.pruneExpired(), 5 * 60 * 1000).unref();
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    const item = this.cache.get(key);
    const now = Date.now();

    const cutoff = item.staleUntil || item.expires;
    if (cutoff && cutoff < now) {
      this.cache.delete(key);
      return null;
    }

    this.cache.delete(key);
    this.cache.set(key, item);
    return item.value;
  }

  /**
   * @returns {{ status: 'fresh'|'stale'|'miss', value: any }}
   */
  getSWR(key) {
    if (!this.cache.has(key)) return { status: 'miss', value: null };
    const item = this.cache.get(key);
    const now = Date.now();

    if (item.expires && item.expires > now) {
      this.cache.delete(key);
      this.cache.set(key, item);
      return { status: 'fresh', value: item.value };
    }

    if (item.staleUntil && item.staleUntil > now) {
      this.cache.delete(key);
      this.cache.set(key, item);
      return { status: 'stale', value: item.value };
    }

    this.cache.delete(key);
    return { status: 'miss', value: null };
  }

  /** Peek without promoting or expiring (for last-known-good after failed refresh). */
  peek(key) {
    const item = this.cache.get(key);
    return item ? item.value : null;
  }

  set(key, value, ttl = 0, staleWindowMs = 0) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.limit) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    const now = Date.now();
    const expires = ttl > 0 ? now + ttl : this.ttlFn ? now + this.ttlFn() : 0;
    const staleUntil = expires > 0 && staleWindowMs > 0 ? expires + staleWindowMs : 0;
    this.cache.set(key, { value, expires, staleUntil });
  }

  delete(key) {
    this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }

  pruneExpired() {
    const now = Date.now();
    for (const [key, item] of this.cache.entries()) {
      const cutoff = item.staleUntil || item.expires;
      if (cutoff && cutoff < now) {
        this.cache.delete(key);
      }
    }
  }

  destroy() {
    clearInterval(this._pruneInterval);
  }
}

class RateLimiter {
  constructor(windowMs, max) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
    this._pruneInterval = setInterval(() => this._prune(), this.windowMs).unref();
  }

  _prune() {
    const now = Date.now();
    for (const [ip, record] of this.hits.entries()) {
      if (now - record.windowStart > this.windowMs) {
        this.hits.delete(ip);
      }
    }
  }

  destroy() {
    clearInterval(this._pruneInterval);
  }

  middleware() {
    return (req, res, next) => {
      const ip = req.ip || 'unknown';
      const record = this.hits.get(ip) || { count: 0, windowStart: Date.now() };

      if (Date.now() - record.windowStart > this.windowMs) {
        record.count = 1;
        record.windowStart = Date.now();
      } else {
        record.count++;
      }

      this.hits.set(ip, record);

      if (record.count > this.max) {
        res.setHeader('Retry-After', String(Math.ceil(this.windowMs / 1000)));
        return res.status(429).json({
          ok: false,
          error: 'Too many requests. Please try again later.',
        });
      }
      next();
    };
  }
}

/**
 * Translation with bounded queue. Failures resolve to null (never pretend original is translated).
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
    if (!text || typeof text !== 'string') return null;
    const cacheKey = `${targetLang}|${text}`;

    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    if (this.pendingTranslations.has(cacheKey)) {
      return this.pendingTranslations.get(cacheKey);
    }

    if (this.queue.length >= this.queueLimit) {
      console.warn('[translation] queue full, dropping request');
      return null;
    }

    const promise = new Promise((resolve) => {
      this.queue.push({ text, targetLang, resolve, cacheKey });
      this.processQueue();
    }).finally(() => {
      this.pendingTranslations.delete(cacheKey);
    });

    this.pendingTranslations.set(cacheKey, promise);
    return promise;
  }

  getCached(text, targetLang = 'ru') {
    if (!text) return null;
    return this.cache.get(`${targetLang}|${text}`);
  }

  async processQueue() {
    if (this.queue.length === 0 || this.activeWorkers >= this.maxWorkers) return;

    const task = this.queue.shift();
    this.activeWorkers++;

    try {
      const result = await this._performTranslation(task.text, task.targetLang);
      this.cache.set(task.cacheKey, result, CONFIG.CACHE.TRANSLATION_TTL);
      task.resolve(result);
    } catch (error) {
      console.warn('[translation] failed:', error.message);
      task.resolve(null);
    } finally {
      this.activeWorkers--;
      this.processQueue();
    }
  }

  async _performTranslation(text, targetLang) {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
    const response = await fetchWithRetry(url, { attempts: 2, timeoutMs: CONFIG.FETCH.TIMEOUT });
    const data = await response.json();
    if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('Invalid format');
    return data[0].map((item) => (Array.isArray(item) ? item[0] : '')).join('');
  }
}

const getText = (val) => {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return getText(val[0]);
  if (typeof val === 'object') {
    if (val._) return getText(val._);
    if (val.$?.href) return val.$.href;
  }
  return '';
};

const stripHtml = (str) => {
  if (typeof str !== 'string' || !str) return '';
  return str.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
};

class RSSService {
  constructor(cache) {
    this.cache = cache;
    this.pendingRequests = new Map();
    this.articleStore = new LRUCache(2000);
    this.xmlParser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true, trim: true });
  }

  async fetchFeed(sourceKey, url, options = {}) {
    if (!url) return [];
    const { forceRefresh = false } = options;

    if (!forceRefresh) {
      const swr = this.cache.getSWR(url);
      if (swr.status === 'fresh') return swr.value;
      if (swr.status === 'stale') {
        this._revalidateFeed(sourceKey, url, { forceRefresh: false }).catch((err) => {
          console.warn(`[SWR] revalidate failed ${sourceKey}:`, err.message);
        });
        return swr.value;
      }
    }

    return this._revalidateFeed(sourceKey, url, { forceRefresh });
  }

  async _revalidateFeed(sourceKey, url, options = {}) {
    const { forceRefresh = false } = options;

    if (this.pendingRequests.has(url)) {
      const pending = this.pendingRequests.get(url);
      if (!forceRefresh) return pending;
      // Wait for in-flight work, then re-fetch so refresh is not a no-op
      try {
        await pending;
      } catch {
        /* ignore */
      }
      if (this.pendingRequests.has(url)) {
        return this.pendingRequests.get(url);
      }
    }

    const fetchPromise = (async () => {
      try {
        const response = await fetchWithRetry(url);
        const xml = await response.text();
        const parsed = await this.xmlParser.parseStringPromise(xml);
        const articles = this._normalizeFeed(sourceKey, parsed);

        this.cache.set(url, articles, CONFIG.CACHE.RSS_TTL, CONFIG.CACHE.RSS_STALE_WINDOW);
        return articles;
      } catch (error) {
        console.warn(`Error fetching feed ${sourceKey}: ${error.message}`);
        // Preserve last-known-good (including expired stale entry via peek)
        return this.cache.peek(url) || this.cache.get(url) || [];
      } finally {
        this.pendingRequests.delete(url);
      }
    })();

    this.pendingRequests.set(url, fetchPromise);
    return fetchPromise;
  }

  _normalizeFeed(sourceKey, parsedData) {
    let items = [];
    if (parsedData?.rss?.channel?.item) {
      items = [].concat(parsedData.rss.channel.item);
    } else if (parsedData?.feed?.entry) {
      items = [].concat(parsedData.feed.entry);
    }

    const limit = CONFIG.FETCH.MAX_ITEMS_PER_FEED;
    return items
      .slice(0, limit)
      .map((item, idx) => {
        try {
          if (!item || typeof item !== 'object') return null;
          return this._normalizeItem(sourceKey, item, idx);
        } catch (e) {
          console.warn(`Skip bad item ${sourceKey}#${idx}:`, e.message);
          return null;
        }
      })
      .filter(Boolean);
  }

  _normalizeItem(sourceKey, item, index) {
    const title = stripHtml(getText(item.title));
    const description = stripHtml(
      getText(item.description) ||
        getText(item.summary) ||
        getText(item['media:description']) ||
        getText(item['content:encoded'])
    );

    let link = '';
    if (typeof item.link === 'string') link = item.link;
    else if (item.link?.href) link = item.link.href;
    else if (Array.isArray(item.link)) {
      link = item.link.find((l) => l.type === 'text/html' || !l.type)?.href || item.link[0]?.href || '';
    }

    let imageUrl = null;
    const media = item['media:content'] || item['media:thumbnail'] || item['media:group']?.['media:content'];
    const enclosure = item.enclosure;
    const findUrl = (obj) => obj?.url || obj?.$?.url;

    if (Array.isArray(media)) imageUrl = findUrl(media[0]);
    else if (media) imageUrl = findUrl(media);
    else if (enclosure) imageUrl = findUrl(Array.isArray(enclosure) ? enclosure[0] : enclosure);

    const pubDateStr = item.pubDate || item.published || item.updated || item.date;
    const pubDate = pubDateStr ? new Date(pubDateStr) : null;
    const validDate = pubDate && !Number.isNaN(pubDate.getTime());
    const publishedAt = validDate ? pubDate.toISOString() : null;
    const publishedAtMs = validDate ? pubDate.getTime() : 0;

    const id = getText(item.guid) || getText(item.id) || link || `${sourceKey}-${publishedAtMs}-${index}`;

    const rawFull = getText(item['content:encoded']) || description || '';
    const fullText = stripHtml(rawFull).substring(0, 4000);

    const articleKey = `${sourceKey}:${id}`;
    this.articleStore.set(articleKey, fullText.length > 3 ? fullText : description);

    const safeTitle = title || '(No Title)';
    const safeSnippet = description || '(No Description)';

    return {
      id,
      source: sourceKey,
      sourceTitle: SOURCES[sourceKey]?.title || sourceKey,
      title: safeTitle,
      snippet: safeSnippet,
      link,
      imageUrl,
      publishedAt,
      publishedAtMs,
      cleanLink: normalizeLink(link),
      normTitle: normalizeTitle(safeTitle),
    };
  }

  getFullText(sourceKey, id) {
    return this.articleStore.get(`${sourceKey}:${id}`) || null;
  }
}

class SearchService {
  constructor(rssService, translationService) {
    this.rssService = rssService;
    this.translationService = translationService;
    this.searchCache = new LRUCache(CONFIG.CACHE.SEARCH_LIMIT);
  }

  /**
   * @returns {Promise<{ results: object[], upstreamFailed: boolean, degraded: boolean }>}
   */
  async search(query, sourceKey, options = {}) {
    const { viewAll, refresh, category } = options;
    const normQuery = (query || '').trim().toLowerCase();
    const cat = category && category !== 'all' ? category : 'all';

    const cacheKey = `search:${sourceKey || 'all'}:${normQuery}:${Boolean(viewAll)}:${cat}`;
    if (!refresh) {
      const cached = this.searchCache.get(cacheKey);
      if (cached) {
        return { results: cached, upstreamFailed: false, degraded: false };
      }
    }

    const sources = resolveSources({
      sourceKey,
      normQuery,
      viewAll,
      category: cat,
    });

    // Do NOT delete cache before refresh — forceRefresh revalidates; last-known-good kept on failure
    const allArticles = [];
    let feedsWithData = 0;
    const concurrencyLimit = CONFIG.FETCH.MAX_CONCURRENT_FEEDS;

    for (let i = 0; i < sources.length; i += concurrencyLimit) {
      const chunk = sources.slice(i, i + concurrencyLimit);
      const results = await Promise.all(
        chunk.map((key) =>
          this.rssService.fetchFeed(key, SOURCES[key].url, { forceRefresh: Boolean(refresh) })
        )
      );
      for (const articles of results) {
        if (Array.isArray(articles) && articles.length > 0) feedsWithData++;
        allArticles.push(...(articles || []));
      }
    }

    const upstreamFailed = sources.length > 0 && feedsWithData === 0;

    allArticles.sort((a, b) => (b.publishedAtMs || 0) - (a.publishedAtMs || 0));
    const deduplicatedArticles = dedupeArticles(allArticles);

    let results = deduplicatedArticles;
    if (normQuery) {
      let translatedQuery = '';
      try {
        translatedQuery = (await this.translationService.translate(normQuery, 'en')) || '';
      } catch (err) {
        console.warn('[search] query translate failed:', err.message);
      }

      const uniqueTokens = [...new Set(tokenize(normQuery).concat(tokenize(translatedQuery)))];

      if (uniqueTokens.length > 0) {
        results = deduplicatedArticles
          .map((article) => ({ article, score: scoreArticle(article, uniqueTokens) }))
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score || (b.article.publishedAtMs || 0) - (a.article.publishedAtMs || 0))
          .map((item) => item.article);
      } else {
        // Short query fallback: literal substring match
        results = deduplicatedArticles.filter(
          (a) =>
            String(a.title || '').toLowerCase().includes(normQuery) ||
            String(a.snippet || '').toLowerCase().includes(normQuery)
        );
      }
    }

    const limit = viewAll ? CONFIG.SEARCH.MAX_RESULTS_VIEW_ALL : CONFIG.SEARCH.MAX_RESULTS_DEFAULT;
    const finalResults = results.slice(0, limit).map((article) => {
      // Strip internal dedupe keys from API payload
      const { cleanLink, normTitle, ...publicArticle } = article;
      return publicArticle;
    });

    if (upstreamFailed && finalResults.length === 0) {
      const err = new Error('All upstream feeds failed');
      err.code = 'UPSTREAM_DOWN';
      throw err;
    }

    if (finalResults.length > 0) {
      this.searchCache.set(cacheKey, finalResults, CONFIG.CACHE.SEARCH_TTL);
    } else if (!upstreamFailed) {
      // Short negative cache for legitimate empty queries
      this.searchCache.set(cacheKey, finalResults, CONFIG.CACHE.SEARCH_EMPTY_TTL);
    }

    return {
      results: finalResults,
      upstreamFailed,
      degraded: upstreamFailed || feedsWithData < sources.length,
    };
  }
}

const rssCache = new LRUCache(CONFIG.CACHE.RSS_LIMIT);
const translationCache = new LRUCache(CONFIG.CACHE.TRANSLATION_LIMIT);

const translationService = new TranslationService(translationCache);
const rssService = new RSSService(rssCache);
const searchService = new SearchService(rssService, translationService);
const rateLimiter = new RateLimiter(CONFIG.RATE_LIMIT.WINDOW_MS, CONFIG.RATE_LIMIT.MAX_REQUESTS);

async function startBackgroundJobs() {
  const fetchAndCacheAll = async () => {
    console.log('[Background Job] Starting RSS pre-fetch and pre-translation...');
    const start = Date.now();
    const keys = Object.keys(SOURCES);
    const concurrencyLimit = CONFIG.FETCH.MAX_CONCURRENT_FEEDS;
    const allArticles = [];

    for (let i = 0; i < keys.length; i += concurrencyLimit) {
      const chunk = keys.slice(i, i + concurrencyLimit);
      const results = await Promise.all(chunk.map((key) => rssService.fetchFeed(key, SOURCES[key].url)));
      allArticles.push(...results.flat());
    }

    allArticles.sort((a, b) => (b.publishedAtMs || 0) - (a.publishedAtMs || 0));
    const topArticlesToTranslate = allArticles.slice(0, 30);

    let translatedCount = 0;
    await Promise.all(
      topArticlesToTranslate.map(async (item) => {
        try {
          const [t, s] = await Promise.all([
            translationService.translate(item.title, 'ru'),
            translationService.translate(item.snippet, 'ru'),
          ]);
          if (t || s) translatedCount++;
        } catch (err) {
          console.warn('[Background Job] translate error:', err.message);
        }
      })
    );

    console.log(
      `[Background Job] Completed in ${Date.now() - start}ms. Pre-translated: ${translatedCount} articles. Cached feeds: ${rssCache.size}.`
    );
  };

  const scheduleNext = () => {
    setTimeout(async () => {
      try {
        await fetchAndCacheAll();
      } catch (err) {
        console.error('[Background Job] Scheduled run error:', err);
      } finally {
        scheduleNext();
      }
    }, 5 * 60 * 1000).unref();
  };

  fetchAndCacheAll()
    .catch((err) => console.error('[Background Job] Initial run error:', err))
    .finally(() => scheduleNext());
}

async function enrichWithTranslations(results, shouldTranslate) {
  if (!shouldTranslate) {
    return results.map((item) => ({
      ...item,
      title_ru: translationService.getCached(item.title, 'ru') || null,
      snippet_ru: translationService.getCached(item.snippet, 'ru') || null,
    }));
  }

  const maxInline = CONFIG.SEARCH.MAX_TRANSLATED_RESULTS;
  const budget = CONFIG.SEARCH.TRANSLATE_BUDGET_MS;
  const started = Date.now();

  return Promise.all(
    results.map(async (item, idx) => {
      let titleRu = translationService.getCached(item.title, 'ru') || null;
      let snippetRu = translationService.getCached(item.snippet, 'ru') || null;

      const remaining = budget - (Date.now() - started);
      const canFetch = idx < maxInline && remaining > 200;

      if (canFetch && !titleRu && item.title) {
        titleRu = await withTimeout(
          translationService.translate(item.title, 'ru'),
          Math.min(2500, remaining),
          null
        );
      }
      if (canFetch && !snippetRu && item.snippet) {
        const rem = budget - (Date.now() - started);
        if (rem > 200) {
          snippetRu = await withTimeout(
            translationService.translate(item.snippet, 'ru'),
            Math.min(2500, rem),
            null
          );
        }
      }

      return {
        ...item,
        title_ru: titleRu || null,
        snippet_ru: snippetRu || null,
      };
    })
  );
}

const app = express();
app.set('trust proxy', 1);
app.config = CONFIG;
app.services = {
  rssCache,
  translationCache,
  translationService,
  rssService,
  searchService,
  rateLimiter,
};

app.use(cors({
  origin: CONFIG.ALLOWED_ORIGIN,
  methods: ['GET', 'POST'],
  maxAge: 86400,
}));
app.use(express.json({ limit: '10kb' }));

app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', CSP_HEADER);
  next();
});

app.use('/api/', rateLimiter.middleware());

const staticOptions = { maxAge: '7d', immutable: true, fallthrough: true };
app.use('/css', express.static(path.join(__dirname, 'css'), staticOptions));
app.use('/js', express.static(path.join(__dirname, 'js'), staticOptions));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    cache: {
      rss: rssCache.size,
      translation: translationCache.size,
      search: searchService.searchCache.size,
    },
  });
});

app.get('/api/sources', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.json({
    ok: true,
    topSources: TOP_SOURCES,
    categories: CATEGORY_SOURCES,
    sources: Object.entries(SOURCES).map(([id, { title, categories }]) => ({
      id,
      title,
      categories: categories || [],
    })),
  });
});

app.get('/api/search', async (req, res) => {
  try {
    const { q, source, view_all, refresh, category, translate } = req.query;
    const query = typeof q === 'string' ? q.trim() : '';
    const sourceKey = typeof source === 'string' ? source.trim() : '';
    const shouldTranslate = translate !== 'false';

    if (query.length > CONFIG.SEARCH.MAX_QUERY_LENGTH) {
      return res.status(400).json({
        ok: false,
        error: `Query too long. Maximum length is ${CONFIG.SEARCH.MAX_QUERY_LENGTH} characters.`,
      });
    }

    if (sourceKey && !SOURCES[sourceKey]) {
      return res.status(400).json({
        ok: false,
        error: 'Unknown source',
      });
    }

    const { results, degraded } = await searchService.search(query, sourceKey, {
      viewAll: view_all === 'true',
      refresh: refresh === 'true',
      category: typeof category === 'string' ? category.trim() : 'all',
    });

    const enrichedResults = await enrichWithTranslations(results, shouldTranslate);

    res.setHeader('Cache-Control', refresh === 'true' ? 'no-store' : 'private, max-age=30');
    res.json({
      ok: true,
      results: enrichedResults,
      count: enrichedResults.length,
      degraded: Boolean(degraded),
    });
  } catch (error) {
    if (error.code === 'UPSTREAM_DOWN') {
      console.error(`[${req.requestId}] Search upstream down`);
      return res.status(503).json({
        ok: false,
        error: 'News sources temporarily unavailable. Please try again later.',
        degraded: true,
      });
    }
    console.error(`[${req.requestId}] Search API Error:`, error);
    res.status(500).json({ ok: false, error: 'Internal Server Error' });
  }
});

app.get('/api/article', async (req, res) => {
  try {
    const { source, id, translate } = req.query;
    if (!source || !id) {
      return res.status(400).json({ ok: false, error: 'Source and id required' });
    }

    const sourceKey = String(source);
    const articleId = String(id);

    if (!SOURCES[sourceKey]) {
      return res.status(400).json({ ok: false, error: 'Unknown source' });
    }
    if (articleId.length > 512) {
      return res.status(400).json({ ok: false, error: 'Invalid id' });
    }

    const fullText = rssService.getFullText(sourceKey, articleId);
    let fullTextRu = null;

    if (fullText && translate === 'true') {
      try {
        fullTextRu = await translationService.translate(fullText, 'ru');
      } catch (err) {
        console.warn(`[${req.requestId}] article translate failed:`, err.message);
      }
    }

    res.json({
      ok: true,
      article: {
        source: sourceKey,
        id: articleId,
        fullText: fullText || null,
        fullText_ru: fullTextRu,
      },
    });
  } catch (error) {
    console.error(`[${req.requestId}] Article API Error:`, error);
    res.status(500).json({ ok: false, error: 'Failed to fetch article details' });
  }
});

const ALLOWED_TARGET_LANGS = new Set(['ru', 'en', 'de', 'fr', 'es', 'zh', 'ar', 'pt', 'it', 'ja', 'ko']);

app.post('/api/translate', async (req, res) => {
  try {
    const { text, to } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ ok: false, error: 'Text required' });
    }

    if (text.length > CONFIG.TRANSLATION.MAX_TEXT_LENGTH) {
      return res.status(400).json({ ok: false, error: 'Text too long' });
    }

    const targetLang =
      typeof to === 'string' && ALLOWED_TARGET_LANGS.has(to.toLowerCase()) ? to.toLowerCase() : 'ru';

    const translated = await translationService.translate(text, targetLang);
    if (translated == null) {
      return res.status(503).json({
        ok: false,
        error: 'Translation temporarily unavailable',
        translated: text,
        failed: true,
      });
    }

    res.json({ ok: true, translated });
  } catch (error) {
    console.error(`[${req.requestId}] Translation API Error:`, error);
    res.status(500).json({ ok: false, error: 'Translation failed' });
  }
});

app.post('/api/translate/batch', async (req, res) => {
  try {
    const { texts, to } = req.body || {};
    if (!Array.isArray(texts) || texts.length === 0) {
      return res.status(400).json({ ok: false, error: 'Array of texts required' });
    }

    const targetLang =
      typeof to === 'string' && ALLOWED_TARGET_LANGS.has(to.toLowerCase()) ? to.toLowerCase() : 'ru';

    const limitedTexts = texts.slice(0, 20);
    const translations = await Promise.all(
      limitedTexts.map(async (text) => {
        if (typeof text !== 'string' || !text.trim()) {
          return { original: text, translated: text, failed: false };
        }
        if (text.length > CONFIG.TRANSLATION.MAX_BATCH_ITEM_LENGTH) {
          return { original: text, translated: null, failed: true, error: 'invalid' };
        }
        try {
          const translated = await translationService.translate(text, targetLang);
          if (translated == null) {
            return { original: text, translated: text, failed: true };
          }
          return { original: text, translated, failed: false };
        } catch (err) {
          console.warn('[batch translate] item failed:', err.message);
          return { original: text, translated: text, failed: true };
        }
      })
    );

    res.json({ ok: true, translations });
  } catch (error) {
    console.error(`[${req.requestId}] Batch Translation API Error:`, error);
    res.status(500).json({ ok: false, error: 'Batch translation failed' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'), (err) => {
    if (err) {
      console.error('[sendFile] failed:', err.message);
      if (!res.headersSent) res.status(500).send('App shell unavailable');
    }
  });
});

// Unified error handler (invalid JSON, etc.)
app.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
  }
  console.error(`[${req.requestId || '-'}] express error:`, err);
  if (!res.headersSent) {
    res.status(500).json({ ok: false, error: 'Internal Server Error' });
  }
});

module.exports = app;

function shutdown(server, signal) {
  console.error(`[shutdown] ${signal}`);
  server.close(() => {
    try {
      rssCache.destroy();
      translationCache.destroy();
      searchService.searchCache.destroy();
      rateLimiter.destroy();
      rssService.articleStore.destroy();
    } catch (e) {
      console.error('[shutdown] cleanup error:', e.message);
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

if (require.main === module) {
  startBackgroundJobs();
  const server = app.listen(CONFIG.PORT, () => {
    console.log(`Server running on http://localhost:${CONFIG.PORT}`);
  });

  process.on('SIGTERM', () => shutdown(server, 'SIGTERM'));
  process.on('SIGINT', () => shutdown(server, 'SIGINT'));
  process.on('unhandledRejection', (err) => {
    console.error('[unhandledRejection]', err);
  });
}
