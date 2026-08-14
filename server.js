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
  ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || '',
  CACHE: {
    RSS_TTL: 5 * 60 * 1000,
    RSS_STALE_WINDOW: 20 * 60 * 1000,
    TRANSLATION_TTL: 24 * 60 * 60 * 1000,
    SEARCH_TTL: 60 * 1000,
    SEARCH_EMPTY_TTL: 10 * 1000,
    RSS_LIMIT: 100,
    TRANSLATION_LIMIT: 2000,
    SEARCH_LIMIT: 200,
    L2_GET_MS: 250,
  },
  FETCH: {
    TIMEOUT: 8000,
    RETRIES: 2,
    RETRY_BASE_MS: 300,
    MAX_CONCURRENT_TRANSLATIONS: 5,
    MAX_CONCURRENT_FEEDS: 15,
    MAX_ITEMS_PER_FEED: 40,
    MAX_BODY_BYTES: 2 * 1024 * 1024,
    MAX_REDIRECTS: 5,
    USER_AGENT: 'NewsAggregator/2.0 (RSS reader)',
    CIRCUIT_FAILS: 3,
    CIRCUIT_COOLDOWN_MS: 30 * 60 * 1000,
  },
  RATE_LIMIT: {
    WINDOW_MS: 60 * 1000,
    MAX_REQUESTS: 60,
    REFRESH_MAX: 6,
    TRANSLATE_MAX: 20,
  },
  SEARCH: {
    MAX_QUERY_LENGTH: 500,
    MAX_RESULTS_VIEW_ALL: 100,
    MAX_RESULTS_DEFAULT: 30,
    MAX_TRANSLATED_RESULTS: 10,
    TRANSLATE_BUDGET_MS: 0,
    QUERY_TRANSLATE_MS: 400,
    DEADLINE_MS: Math.max(0, Number(process.env.SEARCH_DEADLINE_MS) || 8000),
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
  cnn: { url: 'https://rss.cnn.com/rss/edition.rss', title: 'CNN', categories: ['world'] },
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

const TOP_SOURCES = ['bbc', 'nyt', 'guardian', 'cnn', 'npr', 'techcrunch', 'verge', 'politico', 'forbes', 'aljazeera'];

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
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; " +
  "img-src 'self' data: https:; " +
  "connect-src 'self'; " +
  "base-uri 'self'; " +
  "form-action 'self'; " +
  "frame-ancestors 'self';";

/**
 * Resolve which feed keys to query for a search.
 * - explicit source wins
 * - category subset wins over scope toggles
 * - allSources = full catalog (explicit «Все источники»)
 * - a free-text query without category still fans out (chips / search)
 * - viewAll is a result LIMIT only and must not expand the feed set
 */
function resolveSources({ sourceKey, normQuery, viewAll, allSources, category, skipKeys } = {}) {
  void viewAll;
  if (sourceKey && SOURCES[sourceKey]) return [sourceKey];

  const cat = category && category !== 'all' ? category : null;
  let keys;
  if (cat && CATEGORY_SOURCES[cat]) {
    keys = CATEGORY_SOURCES[cat].filter((id) => SOURCES[id]);
  } else if (allSources || (normQuery && String(normQuery).trim().length >= 2)) {
    keys = Object.keys(SOURCES);
  } else {
    keys = TOP_SOURCES.filter((id) => SOURCES[id]);
  }

  if (skipKeys && skipKeys.size) {
    const filtered = keys.filter((id) => !skipKeys.has(id));
    if (filtered.length) return filtered;
  }
  return keys;
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

const CYRILLIC_TO_LATIN = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function transliterateCyrillic(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[а-яё]/g, (ch) => (CYRILLIC_TO_LATIN[ch] != null ? CYRILLIC_TO_LATIN[ch] : ch));
}

function hasCyrillic(text) {
  return /[а-яё]/i.test(String(text || ''));
}

const QUERY_ALIASES = {
  израиль: ['israel', 'israeli'],
  украина: ['ukraine', 'ukrainian'],
  экономика: ['economy', 'economic'],
  технологии: ['technology', 'technologies', 'tech'],
  ии: ['ai', 'artificial'],
  наука: ['science', 'scientific'],
  спорт: ['sport', 'sports'],
  трамп: ['trump'],
};

function expandQueryTerms(normQuery, translatedQuery = '') {
  const translitQuery = hasCyrillic(normQuery) ? transliterateCyrillic(normQuery) : '';
  const aliases = QUERY_ALIASES[normQuery] || [];
  const uniqueTokens = [...new Set(
    tokenize(normQuery)
      .concat(tokenize(translatedQuery), tokenize(translitQuery), aliases.flatMap((alias) => tokenize(alias)))
  )];
  const needles = [...new Set(
    [normQuery, translitQuery, String(translatedQuery || '').toLowerCase(), ...aliases].filter(Boolean)
  )];
  return { translitQuery, uniqueTokens, needles };
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

let fetchImpl = globalThis.fetch.bind(globalThis);

function setFetchImpl(fn) {
  fetchImpl = typeof fn === 'function' ? fn : globalThis.fetch.bind(globalThis);
}

const DEFAULT_FETCH_HEADERS = {
  'User-Agent': CONFIG.FETCH.USER_AGENT,
  Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
};

function statusFromError(error) {
  if (Number.isInteger(error?.status)) return error.status;
  const match = String(error?.message || '').match(/Status (\d{3})/);
  return match ? Number(match[1]) : 0;
}

function httpError(message, status = 0) {
  return Object.assign(new Error(message), { status });
}

function assertXmlLike(contentType, body) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('text/html') && !ct.includes('xml')) {
    throw httpError('Non-XML response', 415);
  }
  const raw = String(body || '');
  const head = raw.slice(0, 240).trim();
  if (/^<!doctype html/i.test(head) || /^<html[\s>]/i.test(head)) {
    throw httpError('Non-XML response', 415);
  }
  if (/<!ENTITY/i.test(raw.slice(0, 8000))) {
    throw httpError('XML entities not allowed', 415);
  }
}

function isPrivateOrLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  const bare = host.replace(/^\[|\]$/g, '');
  if (bare === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  if (
    bare === 'metadata.google.internal' ||
    bare === '127.0.0.1' ||
    bare === '0.0.0.0' ||
    bare === '::1' ||
    bare === '0:0:0:0:0:0:0:1' ||
    bare === '::'
  ) {
    return true;
  }
  if (bare === '169.254.169.254' || bare.startsWith('169.254.')) return true;
  if (bare.includes(':')) {
    if (bare.startsWith('fe80:') || bare.startsWith('fc') || bare.startsWith('fd')) return true;
    const mapped = bare.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    if (mapped) return isPrivateOrLocalHost(mapped[1]);
  }
  const ipv4 = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return true;
  }
  return false;
}

function assertSafeDestination(finalUrl) {
  let dest;
  try {
    dest = new URL(finalUrl);
  } catch {
    throw httpError('Invalid fetch destination', 403);
  }
  if (dest.protocol !== 'http:' && dest.protocol !== 'https:') {
    throw httpError('Invalid fetch destination', 403);
  }
  if (isPrivateOrLocalHost(dest.hostname)) {
    throw httpError('Blocked fetch destination', 403);
  }
}

function translationCacheKey(targetLang, text) {
  const hash = crypto.createHash('sha1').update(String(text)).digest('hex');
  return `${String(targetLang || 'ru').toLowerCase()}|${hash}`;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function resolveCacheMacSecret() {
  return process.env.CACHE_HMAC_SECRET || process.env.CRON_SECRET || '';
}

let ephemeralCacheMacSecret = '';
function cacheMacSecret() {
  const fromEnv = resolveCacheMacSecret();
  if (fromEnv) return fromEnv;
  if (!ephemeralCacheMacSecret) {
    ephemeralCacheMacSecret = crypto.randomBytes(32).toString('hex');
  }
  return ephemeralCacheMacSecret;
}

function envelopeMac(prefix, key, envelope) {
  const payload = JSON.stringify({
    v: envelope.v,
    expires: envelope.expires,
    staleUntil: envelope.staleUntil,
    value: envelope.value,
  });
  return crypto
    .createHmac('sha256', cacheMacSecret())
    .update(String(prefix))
    .update('\n')
    .update(String(key))
    .update('\n')
    .update(payload)
    .digest('hex');
}

function signCacheEnvelope(prefix, key, envelope) {
  return { ...envelope, mac: envelopeMac(prefix, key, envelope) };
}

function isSignedCacheEnvelope(prefix, key, envelope) {
  if (!envelope || envelope.v !== 1 || typeof envelope.mac !== 'string') return false;
  return safeEqual(envelope.mac, envelopeMac(prefix, key, envelope));
}

const metrics = {
  rateLimited: 0,
  upstreamFail: 0,
  translateFail: 0,
};

function recordMetric(name) {
  if (Object.prototype.hasOwnProperty.call(metrics, name)) {
    metrics[name] += 1;
  }
}

function hostFromAbsoluteUrl(value) {
  try {
    return value ? new URL(value).host : '';
  } catch {
    return '';
  }
}

function isTrustedBrowserOrigin(req) {
  const origin = String(req.headers.origin || '');
  const referer = String(req.headers.referer || '');
  const allowed = CONFIG.ALLOWED_ORIGIN;
  const host = String(req.headers.host || '');

  if (allowed && allowed !== '*' && allowed !== 'same-origin') {
    if (origin) return origin === allowed;
    const allowedHost = hostFromAbsoluteUrl(allowed);
    if (referer && allowedHost) return hostFromAbsoluteUrl(referer) === allowedHost;
    return process.env.NODE_ENV === 'test';
  }

  if (origin) {
    return hostFromAbsoluteUrl(origin) === host;
  }
  if (referer) {
    return hostFromAbsoluteUrl(referer) === host;
  }
  return process.env.NODE_ENV === 'test';
}

async function readLimitedText(response, maxBytes = CONFIG.FETCH.MAX_BODY_BYTES) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw httpError('Response too large', 413);

  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw httpError('Response too large', 413);
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw httpError('Response too large', 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

async function fetchFollowingRedirects(url, { signal, headers, method, body } = {}) {
  let current = String(url);
  assertSafeDestination(current);
  const maxHops = CONFIG.FETCH.MAX_REDIRECTS || 5;
  const verb = String(method || 'GET').toUpperCase();
  const followBody = verb === 'GET' || verb === 'HEAD';

  for (let hop = 0; hop < maxHops; hop += 1) {
    const response = await fetchImpl(current, {
      signal,
      headers,
      method: verb,
      body: hop === 0 ? body : undefined,
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      if (!followBody) throw httpError(`Status ${response.status}`, response.status);
      const loc = response.headers.get('location');
      if (!loc) throw httpError(`Status ${response.status}`, response.status);
      let next;
      try {
        next = new URL(loc, current).href;
      } catch {
        throw httpError('Invalid redirect', 403);
      }
      assertSafeDestination(next);
      current = next;
      continue;
    }
    if (response.url) assertSafeDestination(response.url);
    return response;
  }
  throw httpError('Too many redirects', 403);
}

async function fetchWithRetry(url, { attempts = CONFIG.FETCH.RETRIES, timeoutMs = CONFIG.FETCH.TIMEOUT, headers, method, body } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFollowingRedirects(url, {
        signal: controller.signal,
        headers: { ...DEFAULT_FETCH_HEADERS, ...(headers || {}) },
        method,
        body,
      });
      if (response.ok) return response;

      const retryable = response.status === 429 || response.status >= 500;
      lastError = httpError(`Status ${response.status}`, response.status);
      if (!retryable) throw lastError;
    } catch (error) {
      lastError = error;
      const status = statusFromError(error);
      const nonRetryableHttp = status >= 400 && status < 500 && status !== 429;
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

class SourceHealth {
  constructor({ failThreshold = CONFIG.FETCH.CIRCUIT_FAILS, cooldownMs = CONFIG.FETCH.CIRCUIT_COOLDOWN_MS } = {}) {
    this.failThreshold = failThreshold;
    this.cooldownMs = cooldownMs;
    this.records = new Map();
  }

  recordSuccess(key) {
    this.records.delete(key);
  }

  recordFailure(key, status = 0) {
    const rec = this.records.get(key) || { count: 0, lastStatus: 0, openUntil: 0 };
    rec.count += 1;
    rec.lastStatus = status;
    const hardFail = status === 403 || status === 404 || status === 410 || status === 415;
    const flaky = status === 0 || status === 429 || status >= 500;
    if ((hardFail && rec.count >= this.failThreshold) ||
        (flaky && rec.count >= this.failThreshold + 2)) {
      rec.openUntil = Date.now() + this.cooldownMs;
    }
    this.records.set(key, rec);
  }

  isOpen(key) {
    const rec = this.records.get(key);
    if (!rec?.openUntil) return false;
    if (rec.openUntil <= Date.now()) {
      rec.openUntil = 0;
      return false;
    }
    return true;
  }

  openKeys() {
    return new Set([...this.records.keys()].filter((key) => this.isOpen(key)));
  }
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

  setEntry(key, { value, expires = 0, staleUntil = 0 }) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.limit) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
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

const storeFetch = globalThis.fetch.bind(globalThis);

class MemorySharedStore {
  constructor() {
    this.name = 'memory';
    this.map = new Map();
  }

  async get(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  async set(key, value) {
    this.map.set(key, value);
  }
}

class UpstashRestStore {
  constructor({ url, token }) {
    this.name = 'upstash';
    this.url = String(url || '').replace(/\/$/, '');
    this.token = token;
  }

  async _command(args, timeoutMs) {
    const response = await storeFetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`upstash ${response.status}`);
    return response.json();
  }

  async get(key) {
    const data = await this._command(['GET', key], CONFIG.CACHE.L2_GET_MS);
    if (data?.result == null) return null;
    try {
      return typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
    } catch {
      return null;
    }
  }

  async set(key, value, ttlSeconds = 0) {
    const args = ['SET', key, JSON.stringify(value)];
    if (ttlSeconds > 0) args.push('EX', String(Math.ceil(ttlSeconds)));
    await this._command(args, 1500);
  }
}

class VercelRuntimeStore {
  constructor(cache) {
    this.name = 'vercel-runtime';
    this.cache = cache;
  }

  async get(key) {
    const value = await this.cache.get(key);
    return value == null ? null : value;
  }

  async set(key, value, ttlSeconds = 60) {
    await this.cache.set(key, value, {
      ttl: Math.max(1, Math.ceil(ttlSeconds)),
      tags: ['news-agg'],
    });
  }
}

function createSharedStore() {
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (upstashUrl && upstashToken) {
    return new UpstashRestStore({ url: upstashUrl, token: upstashToken });
  }
  if (process.env.VERCEL) {
    try {
      const { getCache } = require('@vercel/functions');
      return new VercelRuntimeStore(getCache({ namespace: 'news-agg' }));
    } catch (err) {
      console.warn('[store] vercel runtime cache unavailable:', err.message);
    }
  }
  return null;
}

class LayeredCache {
  constructor(l1, l2, { prefix = 'c' } = {}) {
    this.l1 = l1;
    this.l2 = l2 || null;
    this.prefix = prefix;
  }

  _k(key) {
    const raw = `${this.prefix}:${key}`;
    if (raw.length <= 180) return raw;
    return `${this.prefix}:h:${crypto.createHash('sha1').update(String(key)).digest('hex')}`;
  }

  get(key) {
    return this.l1.get(key);
  }

  peek(key) {
    return this.l1.peek(key);
  }

  getSWR(key) {
    return this.l1.getSWR(key);
  }

  async _readL2(key) {
    if (!this.l2) return null;
    try {
      return await withTimeout(this.l2.get(this._k(key)), CONFIG.CACHE.L2_GET_MS, null);
    } catch (err) {
      console.warn('[store] l2 get failed:', err.message);
      return null;
    }
  }

  async _writeL2(key, envelope, ttlSeconds) {
    if (!this.l2) return;
    try {
      await this.l2.set(this._k(key), envelope, ttlSeconds);
    } catch (err) {
      console.warn('[store] l2 set failed:', err.message);
    }
  }

  _hydrate(key, envelope) {
    if (!isSignedCacheEnvelope(this.prefix, key, envelope)) {
      return false;
    }
    if (!Object.prototype.hasOwnProperty.call(envelope, 'value')) {
      return false;
    }
    const now = Date.now();
    const staleUntil = Number(envelope.staleUntil) || 0;
    const expires = Number(envelope.expires) || 0;
    if (staleUntil && staleUntil <= now && (!expires || expires <= now)) return false;
    this.l1.setEntry(key, { value: envelope.value, expires, staleUntil });
    return true;
  }

  async getAsync(key) {
    const local = this.l1.get(key);
    if (local != null) return local;
    const remote = await this._readL2(key);
    if (!this._hydrate(key, remote)) return null;
    return this.l1.get(key);
  }

  async getSWRAsync(key) {
    const local = this.l1.getSWR(key);
    if (local.status !== 'miss') return local;
    const remote = await this._readL2(key);
    if (!this._hydrate(key, remote)) return { status: 'miss', value: null };
    return this.l1.getSWR(key);
  }

  async peekAsync(key) {
    const local = this.l1.peek(key);
    if (local != null) return local;
    const remote = await this._readL2(key);
    if (!this._hydrate(key, remote)) return null;
    return this.l1.peek(key);
  }

  set(key, value, ttl = 0, staleWindowMs = 0) {
    this.l1.set(key, value, ttl, staleWindowMs);
    const item = this.l1.cache.get(key);
    if (!item || !this.l2) return Promise.resolve();
    const until = item.staleUntil || item.expires;
    const ttlSeconds = until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : 1;
    return this._writeL2(key, signCacheEnvelope(this.prefix, key, {
      v: 1,
      value,
      expires: item.expires,
      staleUntil: item.staleUntil,
    }), ttlSeconds);
  }

  delete(key) {
    this.l1.delete(key);
  }

  clear() {
    this.l1.clear();
  }

  get size() {
    return this.l1.size;
  }

  pruneExpired() {
    this.l1.pruneExpired();
  }

  destroy() {
    this.l1.destroy();
  }
}

/**
 * Run mapper over items with a concurrency cap. Stop waiting at deadlineAt
 * and return whatever finished; in-flight work keeps running (fills cache).
 */
function mapPoolWithDeadline(items, mapper, { concurrency, deadlineAt } = {}) {
  const results = Array.from({ length: items.length });
  const limit = Math.max(1, concurrency || 1);
  const timed = Number.isFinite(deadlineAt);

  return new Promise((resolve) => {
    let next = 0;
    let active = 0;
    let settled = false;

    const finish = (deadlineHit) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ results, deadlineHit });
    };

    const timer = timed
      ? setTimeout(() => finish(true), Math.max(0, deadlineAt - Date.now()))
      : null;

    const launch = () => {
      if (settled) return;
      while (active < limit && next < items.length) {
        const index = next;
        next += 1;
        active += 1;
        Promise.resolve()
          .then(() => mapper(items[index], index))
          .then((value) => {
            if (!settled) results[index] = { ok: true, value };
          })
          .catch((error) => {
            if (!settled) results[index] = { ok: false, error };
          })
          .finally(() => {
            active -= 1;
            if (settled) return;
            if (next >= items.length && active === 0) finish(false);
            else launch();
          });
      }
    };

    if (items.length === 0) finish(false);
    else launch();
  });
}

function authorizeCron(req) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) {
    return process.env.NODE_ENV === 'test';
  }
  const auth = String(req.headers.authorization || '');
  const header = String(req.headers['x-cron-secret'] || '');
  return safeEqual(auth, `Bearer ${secret}`) || safeEqual(header, secret);
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

  consume(ip = 'unknown') {
    const record = this.hits.get(ip) || { count: 0, windowStart: Date.now() };
    if (Date.now() - record.windowStart > this.windowMs) {
      record.count = 1;
      record.windowStart = Date.now();
    } else {
      record.count += 1;
    }
    this.hits.set(ip, record);
    return {
      limited: record.count > this.max,
      retryAfterSec: Math.ceil(this.windowMs / 1000),
    };
  }

  middleware() {
    return (req, res, next) => {
      const { limited, retryAfterSec } = this.consume(req.ip || 'unknown');
      if (limited) {
        recordMetric('rateLimited');
        res.setHeader('Retry-After', String(retryAfterSec));
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

const PLACEHOLDER_TEXT_RE = /^\(\s*(no title|no description|нет описания|нет заголовка)\s*\)$/i;
const META_TITLE_RE =
  /(\blive\s+threads?\b|\bmegathread\b|\blooking for (new )?moderators?\b|\b(daily|weekly|monthly)\s+(discussion|thread|round.?up)\b|^\s*\[?\s*(meta|mod\s*posts?|announcement)\s*\]?)/i;

function collapseWs(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function isPlaceholderText(text) {
  const t = collapseWs(text);
  return !t || PLACEHOLDER_TEXT_RE.test(t);
}

function isJunkSnippet(text) {
  const t = collapseWs(text);
  if (!t || isPlaceholderText(t)) return true;
  if (/^submitted by\b/i.test(t)) return true;
  if (/^\/u\/\S+/i.test(t)) return true;
  if (/^\[(link|comments)\]/i.test(t)) return true;
  if (/^(comments?|view comments?)$/i.test(t)) return true;
  if (/submitted by/i.test(t) && /\[(link|comments)\]/i.test(t)) return true;
  return false;
}

function isMetaFeedItem(title) {
  const t = collapseWs(title);
  if (!t || isPlaceholderText(t)) return true;
  if (META_TITLE_RE.test(t)) return true;
  if (/^\/?r\/\S+/i.test(t) && /\b(live|thread|megathread|moderators?)\b/i.test(t)) return true;
  return false;
}

function isTranslatableText(text) {
  const t = collapseWs(text);
  if (t.length < 2) return false;
  if (isPlaceholderText(t) || isJunkSnippet(t)) return false;
  return true;
}

function extractImagesFromHtml(html) {
  const urls = [];
  const re = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
  let match;
  while ((match = re.exec(String(html || '')))) {
    const url = String(match[1] || '').replace(/&amp;/g, '&').trim();
    if (/^https?:\/\//i.test(url)) urls.push(url);
  }
  return urls;
}

function extractOutboundLink(html) {
  const labeled = String(html || '').match(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>\s*\[link\]\s*<\/a>/i);
  const href = labeled ? String(labeled[1] || '').replace(/&amp;/g, '&').trim() : '';
  if (!/^https?:\/\//i.test(href)) return '';
  if (/reddit\.com\/r\//i.test(href) && /\/comments\//i.test(href)) return '';
  return href;
}

function pickMediaUrl(node) {
  if (!node) return '';
  if (typeof node === 'string' && /^https?:\/\//i.test(node)) return node;
  if (Array.isArray(node)) return pickMediaUrl(node[0]);
  if (typeof node === 'object') {
    const url = node.url || node.href || node.$?.url || node.$?.href;
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url;
  }
  return '';
}

class RSSService {
  constructor(cache) {
    this.cache = cache;
    this.pendingRequests = new Map();
    this.articleStore = new LRUCache(2000);
    this.health = new SourceHealth();
    this.xmlParser = new xml2js.Parser({
      explicitArray: false,
      mergeAttrs: true,
      trim: true,
      strict: true,
      xmlns: false,
    });
  }

  _hydrateArticleStore(articles) {
    if (!Array.isArray(articles)) return;
    for (const article of articles) {
      if (article?.id && article.source && article.fullText) {
        this.articleStore.set(`${article.source}:${article.id}`, article.fullText);
      }
    }
  }

  _wrapCachedArticles(articles, { stale = false } = {}) {
    const list = Array.isArray(articles) ? articles : [];
    this._hydrateArticleStore(list);
    return {
      articles: list,
      failed: false,
      fromCache: true,
      stale,
    };
  }

  async fetchFeed(sourceKey, url, options = {}) {
    if (!url) return { articles: [], failed: true, fromCache: false, stale: false };
    const { forceRefresh = false } = options;

    if (!forceRefresh) {
      const local = this.cache.getSWR(url);
      if (local.status === 'fresh') return this._wrapCachedArticles(local.value, { stale: false });
      if (local.status === 'stale') {
        this._revalidateFeed(sourceKey, url, { forceRefresh: false }).catch((err) => {
          console.warn(`[SWR] revalidate failed ${sourceKey}:`, err.message);
        });
        return this._wrapCachedArticles(local.value, { stale: true });
      }
    }

    return this._revalidateFeed(sourceKey, url, { forceRefresh });
  }

  async _revalidateFeed(sourceKey, url, options = {}) {
    const { forceRefresh = false } = options;
    const pending = this.pendingRequests.get(url);

    if (pending) {
      if (!forceRefresh || pending.forceRefresh) return pending.promise;
      try {
        await pending.promise;
      } catch {
        /* ignore */
      }
    }

    let resolveFn;
    let rejectFn;
    const promise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    const entry = { promise, forceRefresh };
    this.pendingRequests.set(url, entry);

    this._loadFeed(sourceKey, url, { forceRefresh })
      .then(resolveFn, rejectFn)
      .finally(() => {
        if (this.pendingRequests.get(url) === entry) {
          this.pendingRequests.delete(url);
        }
      });

    return promise;
  }

  async _loadFeed(sourceKey, url, { forceRefresh = false } = {}) {
    if (!forceRefresh && typeof this.cache.getSWRAsync === 'function') {
      try {
        const remote = await this.cache.getSWRAsync(url);
        if (remote.status === 'fresh') {
          this.health.recordSuccess(sourceKey);
          return this._wrapCachedArticles(remote.value, { stale: false });
        }
      } catch (err) {
        console.warn(`[store] l2 hydrate failed ${sourceKey}:`, err.message);
      }
    }

    try {
      const response = await fetchWithRetry(url);
      if (response.url) assertSafeDestination(response.url);
      const xml = await readLimitedText(response);
      assertXmlLike(response.headers.get('content-type'), xml);
      const parsed = await this.xmlParser.parseStringPromise(xml);
      const articles = this._normalizeFeed(sourceKey, parsed);

      this.cache.set(url, articles, CONFIG.CACHE.RSS_TTL, CONFIG.CACHE.RSS_STALE_WINDOW);
      this.health.recordSuccess(sourceKey);
      return { articles, failed: false, fromCache: false, stale: false };
    } catch (error) {
      console.warn(`Error fetching feed ${sourceKey}: ${error.message}`);
      recordMetric('upstreamFail');
      this.health.recordFailure(sourceKey, statusFromError(error));
      const fallback = (
        typeof this.cache.peekAsync === 'function'
          ? await this.cache.peekAsync(url)
          : this.cache.peek(url)
      ) || [];
      return {
        articles: Array.isArray(fallback) ? fallback : [],
        failed: true,
        fromCache: Array.isArray(fallback) && fallback.length > 0,
        stale: Array.isArray(fallback) && fallback.length > 0,
      };
    }
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
    const title = collapseWs(stripHtml(getText(item.title)));
    if (isMetaFeedItem(title)) return null;

    const rawHtml =
      getText(item['content:encoded']) ||
      getText(item.content) ||
      getText(item.description) ||
      getText(item.summary) ||
      getText(item['media:description']) ||
      '';

    let snippet = collapseWs(
      stripHtml(
        getText(item.description) ||
          getText(item.summary) ||
          getText(item['media:description']) ||
          rawHtml
      )
    );
    if (isJunkSnippet(snippet) || collapseWs(snippet).toLowerCase() === title.toLowerCase()) {
      snippet = '';
    }

    let link = '';
    if (typeof item.link === 'string') link = item.link;
    else if (item.link?.href) link = item.link.href;
    else if (Array.isArray(item.link)) {
      link = item.link.find((l) => l.type === 'text/html' || !l.type)?.href || item.link[0]?.href || '';
    }
    const outbound = extractOutboundLink(rawHtml);
    if (outbound) link = outbound;

    const media =
      item['media:content'] ||
      item['media:thumbnail'] ||
      item['media:group']?.['media:content'] ||
      item['media:group']?.['media:thumbnail'];
    const imageUrl =
      pickMediaUrl(media) ||
      pickMediaUrl(item.enclosure) ||
      pickMediaUrl(item['itunes:image']) ||
      extractImagesFromHtml(rawHtml)[0] ||
      '';

    const pubDateStr = item.pubDate || item.published || item.updated || item.date;
    const pubDate = pubDateStr ? new Date(pubDateStr) : null;
    const validDate = pubDate && !Number.isNaN(pubDate.getTime());
    const publishedAt = validDate ? pubDate.toISOString() : null;
    const publishedAtMs = validDate ? pubDate.getTime() : 0;

    const id = getText(item.guid) || getText(item.id) || link || `${sourceKey}-${publishedAtMs}-${index}`;

    const rawFullText = collapseWs(stripHtml(rawHtml)).substring(0, 4000);
    const fullText = !isJunkSnippet(rawFullText) && rawFullText.length > 3 ? rawFullText : '';
    const articleKey = `${sourceKey}:${id}`;
    if (fullText) this.articleStore.set(articleKey, fullText);

    return {
      id,
      source: sourceKey,
      sourceTitle: SOURCES[sourceKey]?.title || sourceKey,
      title,
      snippet,
      link,
      imageUrl: imageUrl || null,
      publishedAt,
      publishedAtMs,
      cleanLink: normalizeLink(link),
      normTitle: normalizeTitle(title),
      fullText,
    };
  }

  getFullText(sourceKey, id) {
    return this.articleStore.get(`${sourceKey}:${id}`) || null;
  }

  async getFullTextAsync(sourceKey, id) {
    const key = `${sourceKey}:${id}`;
    const local = this.articleStore.get(key);
    if (local) return local;

    const source = SOURCES[sourceKey];
    if (!source?.url) return null;
    const bundle = typeof this.cache.getAsync === 'function'
      ? await this.cache.getAsync(source.url)
      : this.cache.get(source.url);
    const hit = Array.isArray(bundle) && bundle.find((article) => String(article?.id) === String(id));
    if (hit?.fullText) {
      this.articleStore.set(key, hit.fullText);
      return hit.fullText;
    }
    return null;
  }
}

function hydrateSearchCache(cached) {
  if (Array.isArray(cached)) {
    return {
      results: cached,
      upstreamFailed: false,
      degraded: false,
      cached: true,
      generatedAt: null,
      sourcesFailed: [],
      sourcesUsed: [],
      deadlineHit: false,
    };
  }
  return {
    results: cached?.results || [],
    upstreamFailed: false,
    degraded: Boolean(cached?.degraded),
    cached: true,
    generatedAt: cached?.generatedAt || null,
    sourcesFailed: Array.isArray(cached?.sourcesFailed) ? cached.sourcesFailed : [],
    sourcesUsed: Array.isArray(cached?.sourcesUsed) ? cached.sourcesUsed : [],
    deadlineHit: Boolean(cached?.deadlineHit),
  };
}

class SearchService {
  constructor(rssService, translationService, searchCache) {
    this.rssService = rssService;
    this.translationService = translationService;
    this.searchCache = searchCache || new LRUCache(CONFIG.CACHE.SEARCH_LIMIT);
    this.pendingSearches = new Map();
  }

  /**
   * @returns {Promise<{ results: object[], upstreamFailed: boolean, degraded: boolean, cached: boolean, generatedAt: string|null, sourcesFailed: string[], sourcesUsed: string[], deadlineHit: boolean }>}
   */
  async search(query, sourceKey, options = {}) {
    const { viewAll, refresh, category, allSources } = options;
    const normQuery = (query || '').trim().toLowerCase();
    const cat = category && category !== 'all' ? category : 'all';
    const cacheKey = `search:${sourceKey || 'all'}:${normQuery}:${Boolean(viewAll)}:${Boolean(allSources)}:${cat}`;

    if (!refresh) {
      const cached = this.searchCache.get(cacheKey);
      if (cached) return hydrateSearchCache(cached);
      if (typeof this.searchCache.getAsync === 'function') {
        const remote = await this.searchCache.getAsync(cacheKey);
        if (remote) return hydrateSearchCache(remote);
      }
      if (this.pendingSearches.has(cacheKey)) {
        return this.pendingSearches.get(cacheKey);
      }
    } else if (this.pendingSearches.has(cacheKey)) {
      try {
        await this.pendingSearches.get(cacheKey);
      } catch {
        /* ignore */
      }
    }

    const promise = this._searchUncached(query, sourceKey, {
      viewAll,
      refresh,
      category: cat,
      allSources,
      cacheKey,
    });
    this.pendingSearches.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      if (this.pendingSearches.get(cacheKey) === promise) {
        this.pendingSearches.delete(cacheKey);
      }
    }
  }

  async _searchUncached(query, sourceKey, { viewAll, refresh, category, allSources, cacheKey }) {
    const normQuery = (query || '').trim().toLowerCase();
    const sources = resolveSources({
      sourceKey,
      normQuery,
      viewAll,
      allSources,
      category,
      skipKeys: this.rssService.health?.openKeys(),
    });

    const allArticles = [];
    const sourcesFailed = [];
    let originOk = 0;
    const deadlineMs = CONFIG.SEARCH.DEADLINE_MS;
    const deadlineAt = deadlineMs > 0 ? Date.now() + deadlineMs : Infinity;

    const { results: feedSlots, deadlineHit } = await mapPoolWithDeadline(
      sources,
      (key) => this.rssService.fetchFeed(key, SOURCES[key].url, { forceRefresh: false }),
      { concurrency: CONFIG.FETCH.MAX_CONCURRENT_FEEDS, deadlineAt }
    );

    for (let idx = 0; idx < sources.length; idx += 1) {
      const key = sources[idx];
      const slot = feedSlots[idx];
      if (!slot || !slot.ok) {
        sourcesFailed.push(key);
        continue;
      }
      const result = slot.value;
      const articles = Array.isArray(result?.articles) ? result.articles : [];
      allArticles.push(...articles);
      if (result?.failed) sourcesFailed.push(key);
      else originOk += 1;
    }

    const generatedAt = new Date().toISOString();
    const degraded = sourcesFailed.length > 0 || deadlineHit;
    const upstreamFailed = sources.length > 0 && originOk === 0 && allArticles.length === 0;

    allArticles.sort((a, b) => (b.publishedAtMs || 0) - (a.publishedAtMs || 0));
    const deduplicatedArticles = dedupeArticles(allArticles);

    let results = deduplicatedArticles;
    let queryTranslateFailed = false;
    if (normQuery) {
      let translatedQuery = '';
      try {
        const leftover = Number.isFinite(deadlineAt) ? deadlineAt - Date.now() : CONFIG.SEARCH.QUERY_TRANSLATE_MS;
        const translateBudget = Math.min(CONFIG.SEARCH.QUERY_TRANSLATE_MS, Math.max(0, leftover));
        const translated = translateBudget < 40
          ? null
          : await withTimeout(this.translationService.translate(normQuery, 'en'), translateBudget, null);
        if (!translated || !String(translated).trim()) queryTranslateFailed = true;
        else translatedQuery = translated;
      } catch (err) {
        queryTranslateFailed = true;
        console.warn('[search] query translate failed:', err.message);
      }

      const { uniqueTokens, needles } = expandQueryTerms(normQuery, translatedQuery);

      const matchesQuery = (article, needle) => {
        if (!needle) return false;
        const title = String(article.title || '').toLowerCase();
        const snippet = String(article.snippet || '').toLowerCase();
        return title.includes(needle) || snippet.includes(needle);
      };

      if (uniqueTokens.length > 0) {
        results = deduplicatedArticles
          .map((article) => ({ article, score: scoreArticle(article, uniqueTokens) }))
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score || (b.article.publishedAtMs || 0) - (a.article.publishedAtMs || 0))
          .map((item) => item.article);
      }

      if (results.length === 0) {
        results = deduplicatedArticles.filter((article) => needles.some((needle) => matchesQuery(article, needle)));
      }
    }

    const limit = viewAll ? CONFIG.SEARCH.MAX_RESULTS_VIEW_ALL : CONFIG.SEARCH.MAX_RESULTS_DEFAULT;
    const finalResults = results.slice(0, limit).map((article) => {
      const { cleanLink, normTitle, fullText, ...publicArticle } = article;
      return publicArticle;
    });

    if (upstreamFailed && finalResults.length === 0) {
      const err = new Error('All upstream feeds failed');
      err.code = 'UPSTREAM_DOWN';
      throw err;
    }

    const payload = {
      results: finalResults,
      degraded,
      generatedAt,
      sourcesFailed,
      sourcesUsed: sources,
      deadlineHit: Boolean(deadlineHit),
    };

    const emptyDueToTranslate =
      Boolean(normQuery) &&
      finalResults.length === 0 &&
      deduplicatedArticles.length > 0 &&
      queryTranslateFailed;

    if (deadlineHit) {
      if (finalResults.length > 0) {
        this.searchCache.set(cacheKey, payload, CONFIG.CACHE.SEARCH_EMPTY_TTL);
      }
    } else if (finalResults.length > 0) {
      this.searchCache.set(cacheKey, payload, CONFIG.CACHE.SEARCH_TTL);
    } else if (!upstreamFailed && !emptyDueToTranslate) {
      this.searchCache.set(cacheKey, payload, CONFIG.CACHE.SEARCH_EMPTY_TTL);
    }

    return {
      ...payload,
      cached: false,
      upstreamFailed,
    };
  }
}

const sharedStore = createSharedStore();
const rssCache = new LayeredCache(new LRUCache(CONFIG.CACHE.RSS_LIMIT), sharedStore, { prefix: 'rss' });
const translationCache = new LayeredCache(new LRUCache(CONFIG.CACHE.TRANSLATION_LIMIT), sharedStore, { prefix: 'tr' });

const translationService = new TranslationService(translationCache);
const rssService = new RSSService(rssCache);
const searchCache = new LayeredCache(new LRUCache(CONFIG.CACHE.SEARCH_LIMIT), sharedStore, { prefix: 'sch' });
const searchService = new SearchService(rssService, translationService, searchCache);
const rateLimiter = new RateLimiter(CONFIG.RATE_LIMIT.WINDOW_MS, CONFIG.RATE_LIMIT.MAX_REQUESTS);
const refreshLimiter = new RateLimiter(CONFIG.RATE_LIMIT.WINDOW_MS, CONFIG.RATE_LIMIT.REFRESH_MAX);
const translateLimiter = new RateLimiter(CONFIG.RATE_LIMIT.WINDOW_MS, CONFIG.RATE_LIMIT.TRANSLATE_MAX);

async function warmupTopSources() {
  const keys = TOP_SOURCES.filter((id) => SOURCES[id]);
  const warmed = [];
  const failed = [];
  const { results } = await mapPoolWithDeadline(
    keys,
    (key) => rssService.fetchFeed(key, SOURCES[key].url),
    { concurrency: CONFIG.FETCH.MAX_CONCURRENT_FEEDS, deadlineAt: Date.now() + 20_000 }
  );
  results.forEach((slot, idx) => {
    const key = keys[idx];
    if (slot?.ok && !slot.value?.failed) warmed.push(key);
    else failed.push(key);
  });
  try {
    await searchService.search('', '', { category: 'all' });
  } catch (err) {
    console.warn('[warmup] homepage search cache failed:', err.message);
  }
  return { warmed, failed, l2: sharedStore?.name || 'none' };
}

async function startBackgroundJobs() {
  const fetchAndCacheAll = async () => {
    console.log('[Background Job] Starting RSS pre-fetch and pre-translation...');
    const start = Date.now();
    const keys = TOP_SOURCES.filter((id) => SOURCES[id]);
    const concurrencyLimit = CONFIG.FETCH.MAX_CONCURRENT_FEEDS;
    const allArticles = [];

    for (let i = 0; i < keys.length; i += concurrencyLimit) {
      const chunk = keys.slice(i, i + concurrencyLimit);
      const results = await Promise.all(chunk.map((key) => rssService.fetchFeed(key, SOURCES[key].url)));
      allArticles.push(...results.flatMap((result) => result?.articles || []));
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

function enrichWithTranslations(results) {
  return results.map((item) => ({
    ...item,
    title_ru: translationService.getCached(item.title, 'ru') || null,
    snippet_ru: translationService.getCached(item.snippet, 'ru') || null,
  }));
}

const app = express();
const trustProxyRaw = String(process.env.TRUST_PROXY || '1').toLowerCase();
app.set(
  'trust proxy',
  trustProxyRaw === '0' || trustProxyRaw === 'false' ? false : (Number(trustProxyRaw) || 1)
);
app.config = CONFIG;
app.services = {
  rssCache,
  translationCache,
  translationService,
  rssService,
  searchService,
  rateLimiter,
  refreshLimiter,
  translateLimiter,
  setFetchImpl,
  sharedStore,
  warmupTopSources,
};
app.helpers = {
  resolveSources,
  hydrateSearchCache,
  setFetchImpl,
  transliterateCyrillic,
  expandQueryTerms,
  tokenize,
  enrichWithTranslations,
  isPlaceholderText,
  isJunkSnippet,
  isMetaFeedItem,
  isTranslatableText,
  extractImagesFromHtml,
  extractOutboundLink,
  TOP_SOURCES,
  CATEGORY_SOURCES,
  SOURCES,
  LRUCache,
  LayeredCache,
  MemorySharedStore,
  mapPoolWithDeadline,
  authorizeCron,
  createSharedStore,
  translationCacheKey,
  safeEqual,
  isTrustedBrowserOrigin,
  isPrivateOrLocalHost,
  assertSafeDestination,
  hostFromAbsoluteUrl,
  signCacheEnvelope,
  isSignedCacheEnvelope,
  metrics,
};

app.use(cors({
  origin(origin, cb) {
    const allowed = CONFIG.ALLOWED_ORIGIN;
    if (!allowed || allowed === 'same-origin') return cb(null, false);
    if (allowed === '*') return cb(null, '*');
    return cb(null, origin === allowed);
  },
  methods: ['GET', 'POST'],
  maxAge: 86400,
}));
app.use(express.json({ limit: '80kb' }));

app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', CSP_HEADER);
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

app.use('/api/', rateLimiter.middleware());

const staticOptions = { maxAge: '7d', fallthrough: true };
app.use('/css', express.static(path.join(__dirname, 'css'), staticOptions));
app.use('/js', express.static(path.join(__dirname, 'js'), staticOptions));

app.get('/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const payload = {
    status: 'ok',
    uptime: process.uptime(),
  };
  if (process.env.NODE_ENV !== 'production') {
    payload.cache = {
      rss: rssCache.size,
      translation: translationCache.size,
      search: searchService.searchCache.size,
    };
    payload.store = {
      l2: sharedStore?.name || 'none',
    };
    payload.metrics = { ...metrics };
  }
  res.json(payload);
});

app.get('/api/cron/warmup', async (req, res) => {
  if (!authorizeCron(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const started = Date.now();
  try {
    const { warmed, failed, l2 } = await warmupTopSources();
    res.json({
      ok: true,
      warmed,
      failed,
      ms: Date.now() - started,
      l2,
    });
  } catch (error) {
    console.error(`[${req.requestId}] cron warmup failed:`, error);
    res.status(500).json({ ok: false, error: 'Warmup failed' });
  }
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

function requireSingleString(value, field) {
  if (value == null || value === '') return '';
  if (Array.isArray(value)) {
    const error = new Error(`${field} must be a single value`);
    error.status = 400;
    throw error;
  }
  return typeof value === 'string' ? value : String(value);
}

app.get('/api/search', async (req, res) => {
  try {
    const query = requireSingleString(req.query.q, 'q').trim();
    const sourceKey = requireSingleString(req.query.source, 'source').trim();
    const categoryRaw = requireSingleString(req.query.category, 'category').trim();
    const viewAll = requireSingleString(req.query.view_all, 'view_all');
    const allSources = requireSingleString(req.query.all_sources, 'all_sources');
    const refresh = requireSingleString(req.query.refresh, 'refresh');
    const translate = requireSingleString(req.query.translate, 'translate');
    const shouldTranslate = translate !== 'false';
    const category = categoryRaw || 'all';

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

    if (category && category !== 'all' && !CATEGORY_SOURCES[category]) {
      return res.status(400).json({
        ok: false,
        error: 'Unknown category',
      });
    }

    if (refresh === 'true') {
      const { limited, retryAfterSec } = refreshLimiter.consume(req.ip || 'unknown');
      if (limited) {
        recordMetric('rateLimited');
        res.setHeader('Retry-After', String(retryAfterSec));
        return res.status(429).json({
          ok: false,
          error: 'Too many refresh requests. Please try again later.',
        });
      }
    }

    const {
      results,
      degraded,
      cached,
      generatedAt,
      sourcesFailed,
      sourcesUsed,
      deadlineHit,
    } = await searchService.search(query, sourceKey, {
      viewAll: viewAll === 'true',
      allSources: allSources === 'true',
      refresh: refresh === 'true',
      category,
    });

    const enrichedResults = enrichWithTranslations(results);

    res.setHeader('Cache-Control', refresh === 'true' ? 'no-store' : 'private, max-age=30');
    const translationsPending = shouldTranslate && enrichedResults.some(
      (item) => (item.title && !item.title_ru) || (item.snippet && !item.snippet_ru)
    );

    res.json({
      ok: true,
      results: enrichedResults,
      count: enrichedResults.length,
      degraded: Boolean(degraded),
      cached: Boolean(cached),
      generatedAt: generatedAt || null,
      sourcesFailed: sourcesFailed || [],
      sourcesUsed: sourcesUsed || [],
      deadlineHit: Boolean(deadlineHit),
      translationsPending,
    });
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({ ok: false, error: error.message });
    }
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
    const sourceKey = requireSingleString(req.query.source, 'source').trim();
    const articleId = requireSingleString(req.query.id, 'id').trim();
    const translate = requireSingleString(req.query.translate, 'translate');

    if (!sourceKey || !articleId) {
      return res.status(400).json({ ok: false, error: 'Source and id required' });
    }

    if (!SOURCES[sourceKey]) {
      return res.status(400).json({ ok: false, error: 'Unknown source' });
    }
    if (articleId.length > 512) {
      return res.status(400).json({ ok: false, error: 'Invalid id' });
    }

    const fullText = await rssService.getFullTextAsync(sourceKey, articleId);
    if (!fullText) {
      return res.status(404).json({ ok: false, error: 'Article not found' });
    }

    let fullTextRu = null;
    if (translate === 'true') {
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
        fullText,
        fullText_ru: fullTextRu,
      },
    });
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({ ok: false, error: error.message });
    }
    console.error(`[${req.requestId}] Article API Error:`, error);
    res.status(500).json({ ok: false, error: 'Failed to fetch article details' });
  }
});

const ALLOWED_TARGET_LANGS = new Set(['ru', 'en', 'de', 'fr', 'es', 'zh', 'ar', 'pt', 'it', 'ja', 'ko']);

function rejectUntrustedTranslate(req, res) {
  if (!isTrustedBrowserOrigin(req)) {
    res.status(403).json({ ok: false, error: 'Origin not allowed' });
    return true;
  }
  const { limited, retryAfterSec } = translateLimiter.consume(req.ip || 'unknown');
  if (limited) {
    recordMetric('rateLimited');
    res.setHeader('Retry-After', String(retryAfterSec));
    res.status(429).json({ ok: false, error: 'Too many translation requests. Please try again later.' });
    return true;
  }
  return false;
}

app.post('/api/translate', async (req, res) => {
  try {
    if (rejectUntrustedTranslate(req, res)) return;
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
    if (rejectUntrustedTranslate(req, res)) return;
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
          return { original: text, translated: null, failed: false };
        }
        if (text.length > CONFIG.TRANSLATION.MAX_BATCH_ITEM_LENGTH) {
          return { original: text, translated: null, failed: true, error: 'invalid' };
        }
        try {
          const translated = await translationService.translate(text, targetLang);
          if (translated == null) {
            return { original: text, translated: null, failed: true };
          }
          return { original: text, translated, failed: false };
        } catch (err) {
          console.warn('[batch translate] item failed:', err.message);
          return { original: text, translated: null, failed: true };
        }
      })
    );

    res.json({ ok: true, translations });
  } catch (error) {
    console.error(`[${req.requestId}] Batch Translation API Error:`, error);
    res.status(500).json({ ok: false, error: 'Batch translation failed' });
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ ok: false, error: 'Not found' });
  }
  next();
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
      refreshLimiter.destroy();
      translateLimiter.destroy();
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
