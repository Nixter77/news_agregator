/**
 * Modernized Backend Server for News Aggregator
 *
 * Architecture:
 * - Service-based design (CacheService, TranslationService, RSSService)
 * - Dependency Injection principles
 * - Centralized Configuration
 * - Robust Error Handling & SWR Caching
 */

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const xml2js = require('xml2js');

// Load environment variables
dotenv.config();

/**
 * Configuration Constants
 */
const CONFIG = {
  PORT: process.env.PORT || 3000,
  ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || '*',
  CACHE: {
    RSS_TTL: 5 * 60 * 1000, // 5 minutes fresh
    RSS_STALE_WINDOW: 20 * 60 * 1000, // +20 minutes stale window (SWR)
    TRANSLATION_TTL: 24 * 60 * 60 * 1000, // 24 hours
    SEARCH_TTL: 60 * 1000, // 60 seconds
    RSS_LIMIT: 100,
    TRANSLATION_LIMIT: 2000,
    SEARCH_LIMIT: 200,
  },
  FETCH: {
    TIMEOUT: 8000, // 8 seconds
    MAX_CONCURRENT_TRANSLATIONS: 5,
    MAX_CONCURRENT_FEEDS: 15,
  },
  RATE_LIMIT: {
    WINDOW_MS: 60 * 1000, // 1 minute
    MAX_REQUESTS: 60,
  },
  SEARCH: {
    MAX_QUERY_LENGTH: 500,
    MAX_RESULTS_VIEW_ALL: 100,
    MAX_RESULTS_DEFAULT: 30,
    MAX_TRANSLATED_RESULTS: 10,
  }
};

/**
 * Validated RSS Feeds
 */
const SOURCES = {
  bbc: { url: 'https://feeds.bbci.co.uk/news/rss.xml', title: 'BBC News' },
  nyt: { url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', title: 'The New York Times' },
  guardian: { url: 'https://www.theguardian.com/world/rss', title: 'The Guardian' },
  cnn: { url: 'https://rss.cnn.com/rss/cnn_topstories.rss', title: 'CNN' },
  aljazeera: { url: 'https://www.aljazeera.com/xml/rss/all.xml', title: 'Al Jazeera' },
  npr: { url: 'https://feeds.npr.org/1001/rss.xml', title: 'NPR' },
  techcrunch: { url: 'https://techcrunch.com/feed/', title: 'TechCrunch' },
  verge: { url: 'https://www.theverge.com/rss/index.xml', title: 'The Verge' },
  wired: { url: 'https://www.wired.com/feed/rss', title: 'WIRED' },
  engadget: { url: 'https://www.engadget.com/rss.xml', title: 'Engadget' },
  arstechnica: { url: 'https://feeds.arstechnica.com/arstechnica/index', title: 'Ars Technica' },
  atlantic: { url: 'https://www.theatlantic.com/feed/all/', title: 'The Atlantic' },
  newyorker: { url: 'https://www.newyorker.com/feed/everything', title: 'The New Yorker' },
  hackernews: { url: 'https://hnrss.org/frontpage', title: 'Hacker News' },
  reddit_news: { url: 'https://www.reddit.com/r/worldnews/.rss', title: 'Reddit World News' },
  bbc_tech: { url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', title: 'BBC Tech' },
  bbc_business: { url: 'https://feeds.bbci.co.uk/news/business/rss.xml', title: 'BBC Business' },
  nyt_world: { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', title: 'NYT World' },
  nyt_tech: { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml', title: 'NYT Tech' },
  reuters_world: { url: 'https://www.reutersagency.com/feed/?taxonomy=best-topics&post_type=best', title: 'Reuters' },
  politico: { url: 'https://rss.politico.com/politics-news.xml', title: 'Politico' },
  axios: { url: 'https://api.axios.com/feed/', title: 'Axios' },
  bloomberg_tech: { url: 'https://feeds.bloomberg.com/technology/news.rss', title: 'Bloomberg Tech' },
  forbes: { url: 'https://www.forbes.com/innovation/feed2/', title: 'Forbes' },
  sciencedaily: { url: 'https://www.sciencedaily.com/rss/all.xml', title: 'Science Daily' },
  nature: { url: 'https://www.nature.com/nature.rss', title: 'Nature' },
  phys: { url: 'https://phys.org/rss-feed/', title: 'Phys.org' },
  space: { url: 'https://www.space.com/feeds/all', title: 'Space.com' },
  espn: { url: 'https://www.espn.com/espn/rss/news', title: 'ESPN' }
};

/**
 * Default tier for instant homepage loading
 */
const TOP_SOURCES = ['bbc', 'nyt', 'guardian', 'cnn', 'npr', 'techcrunch', 'verge', 'reuters_world', 'forbes', 'aljazeera'];

/**
 * Utility: LRU Cache Implementation with SWR Support
 */
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
   * Stale-While-Revalidate getter
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

  set(key, value, ttl = 0, staleWindowMs = 0) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.limit) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    const now = Date.now();
    const expires = ttl > 0 ? now + ttl : (this.ttlFn ? now + this.ttlFn() : 0);
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

/**
 * Rate Limiter Middleware
 */
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
        return res.status(429).json({
          ok: false,
          error: 'Too many requests. Please try again later.'
        });
      }
      next();
    };
  }
}

/**
 * Service: Translation Logic
 */
class TranslationService {
  constructor(cache) {
    this.cache = cache;
    this.queue = [];
    this.activeWorkers = 0;
    this.maxWorkers = CONFIG.FETCH.MAX_CONCURRENT_TRANSLATIONS;
  }

  async translate(text, targetLang = 'ru') {
    if (!text) return '';
    const cacheKey = `${targetLang}|${text}`;

    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    return new Promise((resolve, reject) => {
      this.queue.push({ text, targetLang, resolve, reject, cacheKey });
      this.processQueue();
    });
  }

  getCached(text, targetLang = 'ru') {
    if (!text) return '';
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
      console.error('Translation failed:', error.message);
      task.resolve(task.text);
    } finally {
      this.activeWorkers--;
      this.processQueue();
    }
  }

  async _performTranslation(text, targetLang) {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.FETCH.TIMEOUT);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`Status ${response.status}`);

      const data = await response.json();
      if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('Invalid format');

      return data[0].map(item => (Array.isArray(item) ? item[0] : '')).join('');
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * RSS parsing utilities
 */
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

const stripHtml = (str) => str.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Service: RSS Fetching and Parsing
 */
class RSSService {
  constructor(cache) {
    this.cache = cache;
    this.pendingRequests = new Map();
    this.articleStore = new Map(); // Fulltext store out of search list payloads
    this.xmlParser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true, trim: true });
  }

  async fetchFeed(sourceKey, url, options = {}) {
    if (!url) return [];
    const { forceRefresh = false } = options;

    if (!forceRefresh) {
      const swr = this.cache.getSWR(url);
      if (swr.status === 'fresh') return swr.value;
      if (swr.status === 'stale') {
        // Non-blocking background revalidation
        this._revalidateFeed(sourceKey, url).catch(() => {});
        return swr.value;
      }
    }

    return this._revalidateFeed(sourceKey, url);
  }

  async _revalidateFeed(sourceKey, url) {
    if (this.pendingRequests.has(url)) {
      return this.pendingRequests.get(url);
    }

    const fetchPromise = (async () => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.FETCH.TIMEOUT);

        const response = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timeoutId));
        if (!response.ok) throw new Error(`Status ${response.status}`);

        const xml = await response.text();
        const parsed = await this.xmlParser.parseStringPromise(xml);
        const articles = this._normalizeFeed(sourceKey, parsed);

        this.cache.set(url, articles, CONFIG.CACHE.RSS_TTL, CONFIG.CACHE.RSS_STALE_WINDOW);
        return articles;
      } catch (error) {
        console.error(`Error fetching feed ${sourceKey}: ${error.message}`);
        return this.cache.get(url) || [];
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

    return items.map((item, idx) => this._normalizeItem(sourceKey, item, idx)).filter(Boolean);
  }

  _normalizeItem(sourceKey, item, index) {
    const title = stripHtml(getText(item.title));
    const description = stripHtml(getText(item.description) || getText(item.summary) || getText(item['media:description']) || getText(item['content:encoded']));

    let link = '';
    if (typeof item.link === 'string') link = item.link;
    else if (item.link?.href) link = item.link.href;
    else if (Array.isArray(item.link)) link = item.link.find(l => l.type === 'text/html' || !l.type)?.href || item.link[0]?.href || '';

    let imageUrl = null;
    const media = item['media:content'] || item['media:thumbnail'] || item['media:group']?.['media:content'];
    const enclosure = item.enclosure;
    const findUrl = (obj) => obj?.url || obj?.$?.url;

    if (Array.isArray(media)) imageUrl = findUrl(media[0]);
    else if (media) imageUrl = findUrl(media);
    else if (enclosure) imageUrl = findUrl(Array.isArray(enclosure) ? enclosure[0] : enclosure);

    const pubDateStr = item.pubDate || item.published || item.updated || item.date;
    const pubDate = pubDateStr ? new Date(pubDateStr) : null;
    const publishedAt = pubDate && !isNaN(pubDate) ? pubDate.toISOString() : null;
    const publishedAtMs = pubDate && !isNaN(pubDate) ? pubDate.getTime() : 0;

    const id = getText(item.guid) || getText(item.id) || link || `${sourceKey}-${publishedAtMs}-${index}`;

    const rawFull = getText(item['content:encoded']) || description || '';
    const fullText = stripHtml(rawFull).substring(0, 4000);

    const articleKey = `${sourceKey}:${id}`;
    this.articleStore.set(articleKey, fullText.length > 3 ? fullText : description);

    return {
      id,
      source: sourceKey,
      sourceTitle: SOURCES[sourceKey]?.title || sourceKey,
      title: title || '(No Title)',
      snippet: description || '(No Description)',
      link,
      imageUrl,
      publishedAt,
      publishedAtMs
    };
  }

  getFullText(sourceKey, id) {
    return this.articleStore.get(`${sourceKey}:${id}`) || null;
  }
}

/**
 * Service: Search Logic with LRU Result Cache & Tiered Feeds
 */
class SearchService {
  constructor(rssService, translationService) {
    this.rssService = rssService;
    this.translationService = translationService;
    this.searchCache = new LRUCache(CONFIG.CACHE.SEARCH_LIMIT);
  }

  async search(query, sourceKey, options = {}) {
    const { viewAll, refresh, category } = options;
    const normQuery = (query || '').trim().toLowerCase();

    // Check search results cache if not refreshing
    const cacheKey = `search:${sourceKey || 'all'}:${normQuery}:${Boolean(viewAll)}:${category || 'all'}`;
    if (!refresh) {
      const cached = this.searchCache.get(cacheKey);
      if (cached) return cached;
    }

    // Determine sources to query
    let sources;
    if (sourceKey && SOURCES[sourceKey]) {
      sources = [sourceKey];
    } else if (normQuery || viewAll || category) {
      sources = Object.keys(SOURCES);
    } else {
      // Default light tier for instant homepage loading
      sources = TOP_SOURCES;
    }

    // Invalidate cached feeds if force refresh requested
    if (refresh) {
      sources.forEach(key => {
        const url = SOURCES[key]?.url;
        if (url) this.rssService.cache.delete(url);
      });
    }

    // Fetch feeds with concurrency limit
    const allArticles = [];
    const concurrencyLimit = CONFIG.FETCH.MAX_CONCURRENT_FEEDS;
    for (let i = 0; i < sources.length; i += concurrencyLimit) {
      const chunk = sources.slice(i, i + concurrencyLimit);
      const results = await Promise.all(
        chunk.map(key => this.rssService.fetchFeed(key, SOURCES[key].url, { forceRefresh: refresh }))
      );
      allArticles.push(...results.flat());
    }

    // Deduplicate
    allArticles.sort((a, b) => b.publishedAtMs - a.publishedAtMs);
    const deduplicatedArticles = [];
    const seenLinks = new Set();
    const seenTitles = new Set();

    for (const article of allArticles) {
      const cleanLink = (article.link || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
      const normTitle = (article.title || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

      if ((cleanLink && seenLinks.has(cleanLink)) || (normTitle && seenTitles.has(normTitle))) {
        continue;
      }

      deduplicatedArticles.push(article);
      if (cleanLink) seenLinks.add(cleanLink);
      if (normTitle) seenTitles.add(normTitle);
    }

    // Filtering and Scoring
    let results = deduplicatedArticles;
    if (normQuery) {
      let translatedQuery = '';
      try {
        translatedQuery = await this.translationService.translate(normQuery, 'en');
      } catch (err) {}

      const tokens = this._tokenize(normQuery).concat(this._tokenize(translatedQuery));
      const uniqueTokens = [...new Set(tokens)];

      if (uniqueTokens.length > 0) {
        const regexes = uniqueTokens.map(t => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu'));

        results = deduplicatedArticles
          .map(article => ({ article, score: this._score(article, regexes) }))
          .filter(item => item.score > 0)
          .sort((a, b) => b.score - a.score || b.article.publishedAtMs - a.article.publishedAtMs)
          .map(item => item.article);
      }
    }

    const limit = viewAll ? CONFIG.SEARCH.MAX_RESULTS_VIEW_ALL : CONFIG.SEARCH.MAX_RESULTS_DEFAULT;
    const finalResults = results.slice(0, limit);

    // Save to search cache
    this.searchCache.set(cacheKey, finalResults, CONFIG.CACHE.SEARCH_TTL);

    return finalResults;
  }

  _tokenize(text) {
    return text.toLowerCase()
      .split(/[\s,.;:!?"'()\[\]{}<>/@#%^&*+=|~`]+/)
      .map(t => t.trim())
      .filter(t => t.length >= 2);
  }

  _score(article, regexes) {
    let score = 0;
    const title = article.title.toLowerCase();
    const snippet = article.snippet.toLowerCase();

    for (const re of regexes) {
      if (re.test(title)) score += 5;
      else if (re.test(snippet)) score += 2;
    }
    return score;
  }
}

/**
 * Main Application Setup
 */
const rssCache = new LRUCache(CONFIG.CACHE.RSS_LIMIT);
const translationCache = new LRUCache(CONFIG.CACHE.TRANSLATION_LIMIT);

const translationService = new TranslationService(translationCache);
const rssService = new RSSService(rssCache);
const searchService = new SearchService(rssService, translationService);

/**
 * Background pre-fetch & pre-translation scheduler
 */
async function startBackgroundJobs() {
  const fetchAndCacheAll = async () => {
    console.log('[Background Job] Starting RSS pre-fetch and pre-translation...');
    const start = Date.now();
    const keys = Object.keys(SOURCES);

    const concurrencyLimit = CONFIG.FETCH.MAX_CONCURRENT_FEEDS;
    const allArticles = [];

    for (let i = 0; i < keys.length; i += concurrencyLimit) {
      const chunk = keys.slice(i, i + concurrencyLimit);
      const results = await Promise.all(
        chunk.map(key => rssService.fetchFeed(key, SOURCES[key].url))
      );
      allArticles.push(...results.flat());
    }

    allArticles.sort((a, b) => b.publishedAtMs - a.publishedAtMs);
    const topArticlesToTranslate = allArticles.slice(0, 30);

    let translatedCount = 0;
    await Promise.all(topArticlesToTranslate.map(async (item) => {
      try {
        await Promise.all([
          translationService.translate(item.title, 'ru'),
          translationService.translate(item.snippet, 'ru')
        ]);
        translatedCount++;
      } catch (err) {}
    }));

    console.log(`[Background Job] Completed in ${Date.now() - start}ms. Pre-translated: ${translatedCount} articles. Cached feeds: ${rssCache.size}.`);
  };

  fetchAndCacheAll().catch(err => console.error('[Background Job] Initial run error:', err));

  setInterval(() => {
    fetchAndCacheAll().catch(err => console.error('[Background Job] Scheduled run error:', err));
  }, 5 * 60 * 1000).unref();
}

const app = express();
app.set('trust proxy', 1);
app.config = CONFIG;
app.services = {
  rssCache,
  translationCache,
  translationService,
  rssService,
  searchService
};
const rateLimiter = new RateLimiter(CONFIG.RATE_LIMIT.WINDOW_MS, CONFIG.RATE_LIMIT.MAX_REQUESTS);

app.use(cors({
  origin: CONFIG.ALLOWED_ORIGIN,
  methods: ['GET', 'POST'],
  maxAge: 86400
}));
app.use(express.json({ limit: '10kb' }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' https://cdn.jsdelivr.net; " +
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: https:; " +
    "connect-src 'self';"
  );
  next();
});

app.use('/api/', rateLimiter.middleware());

// Serve static assets with 7-day Cache-Control header
const staticOptions = { maxAge: '7d', immutable: true, fallthrough: true };
app.use('/css', express.static(path.join(__dirname, 'css'), staticOptions));
app.use('/js', express.static(path.join(__dirname, 'js'), staticOptions));

// API Routes
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    cache: {
      rss: rssCache.size,
      translation: translationCache.size,
      search: searchService.searchCache.size
    }
  });
});

app.get('/api/sources', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.json({
    ok: true,
    sources: Object.entries(SOURCES).map(([id, { title }]) => ({ id, title }))
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
        error: `Query too long. Maximum length is ${CONFIG.SEARCH.MAX_QUERY_LENGTH} characters.`
      });
    }

    if (sourceKey && !SOURCES[sourceKey]) {
      return res.status(400).json({
        ok: false,
        error: 'Unknown source'
      });
    }

    const results = await searchService.search(query, sourceKey, {
      viewAll: view_all === 'true',
      refresh: refresh === 'true',
      category: typeof category === 'string' ? category.trim() : 'all'
    });

    let enrichedResults;
    if (shouldTranslate) {
      enrichedResults = await Promise.all(results.map(async item => {
        let titleRu = translationService.getCached(item.title, 'ru');
        let snippetRu = translationService.getCached(item.snippet, 'ru');

        if (!titleRu && item.title) {
          try {
            titleRu = await translationService.translate(item.title, 'ru');
          } catch (err) {}
        }
        if (!snippetRu && item.snippet) {
          try {
            snippetRu = await translationService.translate(item.snippet, 'ru');
          } catch (err) {}
        }

        return {
          ...item,
          title_ru: titleRu || null,
          snippet_ru: snippetRu || null
        };
      }));
    } else {
      enrichedResults = results.map(item => ({
        ...item,
        title_ru: translationService.getCached(item.title, 'ru') || null,
        snippet_ru: translationService.getCached(item.snippet, 'ru') || null
      }));
    }

    res.json({ ok: true, results: enrichedResults, count: enrichedResults.length });
  } catch (error) {
    console.error('Search API Error:', error);
    res.status(500).json({ ok: false, error: 'Internal Server Error' });
  }
});

// Single article details route (loads full text & translates on demand)
app.get('/api/article', async (req, res) => {
  try {
    const { source, id, translate } = req.query;
    if (!source || !id) {
      return res.status(400).json({ ok: false, error: 'Source and id required' });
    }

    const fullText = rssService.getFullText(String(source), String(id));
    let fullTextRu = null;

    if (fullText && translate === 'true') {
      try {
        fullTextRu = await translationService.translate(fullText, 'ru');
      } catch (err) {}
    }

    res.json({
      ok: true,
      article: {
        source,
        id,
        fullText: fullText || null,
        fullText_ru: fullTextRu
      }
    });
  } catch (error) {
    console.error('Article API Error:', error);
    res.status(500).json({ ok: false, error: 'Failed to fetch article details' });
  }
});

const ALLOWED_TARGET_LANGS = new Set(['ru', 'en', 'de', 'fr', 'es', 'zh', 'ar', 'pt', 'it', 'ja', 'ko']);

app.post('/api/translate', async (req, res) => {
  try {
    const { text, to } = req.body;
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ ok: false, error: 'Text required' });
    }

    if (text.length > 10000) return res.status(400).json({ ok: false, error: 'Text too long' });

    const targetLang = (typeof to === 'string' && ALLOWED_TARGET_LANGS.has(to.toLowerCase()))
      ? to.toLowerCase()
      : 'ru';

    const translated = await translationService.translate(text, targetLang);
    res.json({ ok: true, translated });
  } catch (error) {
    console.error('Translation API Error:', error);
    res.status(500).json({ ok: false, error: 'Translation failed' });
  }
});

// Batch translation endpoint
app.post('/api/translate/batch', async (req, res) => {
  try {
    const { texts, to } = req.body;
    if (!Array.isArray(texts) || texts.length === 0) {
      return res.status(400).json({ ok: false, error: 'Array of texts required' });
    }

    const targetLang = (typeof to === 'string' && ALLOWED_TARGET_LANGS.has(to.toLowerCase()))
      ? to.toLowerCase()
      : 'ru';

    const limitedTexts = texts.slice(0, 20); // max 20 per batch
    const translations = await Promise.all(limitedTexts.map(async text => {
      if (typeof text !== 'string' || !text.trim()) return { original: text, translated: text };
      try {
        const translated = await translationService.translate(text, targetLang);
        return { original: text, translated };
      } catch (err) {
        return { original: text, translated: text };
      }
    }));

    res.json({ ok: true, translations });
  } catch (error) {
    console.error('Batch Translation API Error:', error);
    res.status(500).json({ ok: false, error: 'Batch translation failed' });
  }
});

// Fallback for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

module.exports = app;

if (require.main === module) {
  startBackgroundJobs();
  app.listen(CONFIG.PORT, () => {
    console.log(`Server running on http://localhost:${CONFIG.PORT}`);
  });
}
