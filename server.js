/**
 * Modernized Backend Server for News Aggregator
 *
 * Architecture:
 * - Service-based design (CacheService, TranslationService, RSSService)
 * - Dependency Injection principles
 * - Centralized Configuration
 * - Robust Error Handling
 */

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const dotenv = require('dotenv');
const path = require('path');
const xml2js = require('xml2js');
const { EventEmitter } = require('events');

// Load environment variables
dotenv.config();

/**
 * Configuration Constants
 */
const CONFIG = {
  PORT: process.env.PORT || 3000,
  ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || '*',
  CACHE: {
    RSS_TTL: 5 * 60 * 1000, // 5 minutes
    TRANSLATION_TTL: 24 * 60 * 60 * 1000, // 24 hours
    RSS_LIMIT: 100,
    TRANSLATION_LIMIT: 1000,
  },
  FETCH: {
    TIMEOUT: 10000, // 10 seconds
    MAX_CONCURRENT_TRANSLATIONS: 5,
    MAX_CONCURRENT_FEEDS: 10,
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
  cnn: { url: 'http://rss.cnn.com/rss/cnn_topstories.rss', title: 'CNN' },
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
 * Utility: LRU Cache Implementation
 * Optimized for O(1) access and eviction using JS Map iteration order.
 */
class LRUCache {
  constructor(limit, ttlFn = null) {
    this.limit = limit;
    this.ttlFn = ttlFn; // Optional function to calculate TTL per item or global TTL logic
    this.cache = new Map();
    setInterval(() => this.pruneExpired(), 5 * 60 * 1000).unref();
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    const item = this.cache.get(key);

    // Check expiration
    if (item.expires && item.expires < Date.now()) {
      this.cache.delete(key);
      return null;
    }

    // Refresh LRU position: delete and re-insert
    this.cache.delete(key);
    this.cache.set(key, item);
    return item.value;
  }

  set(key, value, ttl = 0) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.limit) {
      // Evict oldest (first inserted)
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    const expires = ttl > 0 ? Date.now() + ttl : (this.ttlFn ? Date.now() + this.ttlFn() : 0);
    this.cache.set(key, { value, expires });
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }

  // Periodic cleanup for expired items without access
  pruneExpired() {
    const now = Date.now();
    for (const [key, item] of this.cache.entries()) {
      if (item.expires && item.expires < now) {
        this.cache.delete(key);
      }
    }
  }
}

/**
 * Utility: Rate Limiter Middleware
 */
class RateLimiter {
  constructor(windowMs, max) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
    setInterval(() => this._prune(), this.windowMs).unref();
  }

  _prune() {
    const now = Date.now();
    for (const [ip, record] of this.hits.entries()) {
      if (now - record.startTime > this.windowMs) {
        this.hits.delete(ip);
      }
    }
  }

  middleware() {
    return (req, res, next) => {
      const forwardedFor = req.headers['x-forwarded-for'];
      const ip = (typeof forwardedFor === 'string' && forwardedFor.split(',')[0].trim())
        || req.ip
        || req.connection?.remoteAddress
        || 'unknown';
      const record = this.hits.get(ip) || { count: 0, startTime: Date.now() };

      if (Date.now() - record.startTime > this.windowMs) {
        record.count = 1;
        record.startTime = Date.now();
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
      task.resolve(task.text); // Fallback to original text
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
 * Service: RSS Fetching and Parsing
 */
class RSSService {
  constructor(cache) {
    this.cache = cache;
    this.pendingRequests = new Map();
    this.xmlParser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true, trim: true });
  }

  async fetchFeed(sourceKey, url) {
    if (!url) return [];

    // Check Cache
    const cached = this.cache.get(url);
    if (cached) return cached;

    // Check Pending Request (Request Deduplication)
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

        this.cache.set(url, articles, CONFIG.CACHE.RSS_TTL);
        return articles;
      } catch (error) {
        console.error(`Error fetching feed ${sourceKey}: ${error.message}`);
        return [];
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

    const title = stripHtml(getText(item.title));
    const description = stripHtml(getText(item.description) || getText(item.summary) || getText(item['media:description']) || getText(item['content:encoded']));

    // Extract Link
    let link = '';
    if (typeof item.link === 'string') link = item.link;
    else if (item.link?.href) link = item.link.href;
    else if (Array.isArray(item.link)) link = item.link.find(l => l.type === 'text/html' || !l.type)?.href || item.link[0]?.href || '';

    // Extract Image
    let imageUrl = null;
    const media = item['media:content'] || item['media:thumbnail'] || item['media:group']?.['media:content'];
    const enclosure = item.enclosure;
    const findUrl = (obj) => obj?.url || obj?.$?.url;

    if (Array.isArray(media)) imageUrl = findUrl(media[0]);
    else if (media) imageUrl = findUrl(media);
    else if (enclosure) imageUrl = findUrl(Array.isArray(enclosure) ? enclosure[0] : enclosure);

    // Dates
    const pubDateStr = item.pubDate || item.published || item.updated || item.date;
    const pubDate = pubDateStr ? new Date(pubDateStr) : null;
    const publishedAt = pubDate && !isNaN(pubDate) ? pubDate.toISOString() : null;
    const publishedAtMs = pubDate && !isNaN(pubDate) ? pubDate.getTime() : 0;

    const id = getText(item.guid) || getText(item.id) || link || `${sourceKey}-${publishedAtMs}-${index}`;

    // Full text (truncated)
    const rawFull = getText(item['content:encoded']) || description || '';
    const fullText = stripHtml(rawFull).substring(0, 4000); // Limit size

    return {
      id,
      source: sourceKey,
      sourceTitle: SOURCES[sourceKey]?.title || sourceKey,
      title: title || '(No Title)',
      snippet: description || '(No Description)',
      link,
      imageUrl,
      fullText: fullText.length > 3 ? fullText : description,
      publishedAt,
      publishedAtMs
    };
  }
}

/**
 * Service: Search Logic
 */
class SearchService {
  constructor(rssService, translationService) {
    this.rssService = rssService;
    this.translationService = translationService;
  }

  async search(query, sourceKey, options = {}) {
    const { viewAll, refresh } = options;

    // Determine sources
    const sources = sourceKey && SOURCES[sourceKey] ? [sourceKey] : Object.keys(SOURCES);

    if (refresh) {
      this.rssService.cache.clear();
    }

    // Parallel Fetch with Concurrency Limit could be added here if needed,
    // currently Promise.all is used but controlled by service logic.
    const allArticles = (await Promise.all(
      sources.map(key => this.rssService.fetchFeed(key, SOURCES[key].url))
    )).flat();

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
    if (query) {
      const translatedQuery = await this.translationService.translate(query, 'en');
      const tokens = this._tokenize(query).concat(this._tokenize(translatedQuery));
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
    return results.slice(0, limit);
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
app.use('/api/', rateLimiter.middleware());
app.use('/css', express.static(path.join(__dirname, 'css'), { fallthrough: false }));
app.use('/js', express.static(path.join(__dirname, 'js'), { fallthrough: false }));
app.use('/fonts', express.static(path.join(__dirname, 'fonts'), { fallthrough: false }));

// API Routes
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    cache: {
      rss: rssCache.size,
      translation: translationCache.size
    }
  });
});

app.get('/api/sources', (req, res) => {
  res.json({
    ok: true,
    sources: Object.entries(SOURCES).map(([id, { title }]) => ({ id, title }))
  });
});

app.get('/api/search', async (req, res) => {
  try {
    const { q, source, view_all, refresh } = req.query;
    const query = typeof q === 'string' ? q.trim() : '';
    const sourceKey = typeof source === 'string' ? source.trim() : '';

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
      refresh: refresh === 'true'
    });

    const resultsToTranslate = results.slice(0, CONFIG.SEARCH.MAX_TRANSLATED_RESULTS);
    const resultsRest = results.slice(CONFIG.SEARCH.MAX_TRANSLATED_RESULTS);

    const translatedResults = await Promise.all(resultsToTranslate.map(async item => {
      try {
        const [titleRu, snippetRu] = await Promise.all([
          translationService.translate(item.title, 'ru'),
          translationService.translate(item.snippet, 'ru')
        ]);
        return { ...item, title_ru: titleRu, snippet_ru: snippetRu };
      } catch (e) {
        return { ...item, title_ru: item.title, snippet_ru: item.snippet }; // Fallback
      }
    }));

    const finalResults = [...translatedResults, ...resultsRest];

    res.json({ ok: true, results: finalResults, count: finalResults.length });
  } catch (error) {
    console.error('Search API Error:', error);
    res.status(500).json({ ok: false, error: 'Internal Server Error' });
  }
});

app.post('/api/translate', async (req, res) => {
  try {
    const { text, to } = req.body;
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ ok: false, error: 'Text required' });
    }

    // Basic validation
    if (text.length > 10000) return res.status(400).json({ ok: false, error: 'Text too long' });

    const translated = await translationService.translate(text, to || 'ru');
    res.json({ ok: true, translated });
  } catch (error) {
    console.error('Translation API Error:', error);
    res.status(500).json({ ok: false, error: 'Translation failed' });
  }
});

// Fallback for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Export for testing/serverless
module.exports = app;

// Start Server
if (require.main === module) {
  app.listen(CONFIG.PORT, () => {
    console.log(`Server running on http://localhost:${CONFIG.PORT}`);
  });
}
