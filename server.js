const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const dotenv = require('dotenv');
const path = require('path');
const xml2js = require('xml2js');

dotenv.config();

const app = express();

// CORS with restrictions
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST'],
  maxAge: 86400
}));

app.use(express.json({ limit: '10kb' }));

// Simple rate limiting
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 60; // requests per window

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const record = rateLimitMap.get(ip);

  if (!record || now - record.start > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { start: now, count: 1 });
    return next();
  }

  if (record.count >= RATE_LIMIT_MAX) {
    return res.status(429).json({ ok: false, error: 'Too many requests. Please try again later.' });
  }

  record.count++;
  next();
}

app.use('/api/', rateLimit);

// Serve static frontend
app.use(express.static(path.join(__dirname)));

// --- Constants & simple in-memory caches ---
const RSS_CACHE_MS = 5 * 60 * 1000; // 5 minutes
const TRANSLATION_CACHE_MS = 24 * 60 * 60 * 1000; // 24 hours
const RSS_CACHE_LIMIT = 60;
const TRANSLATION_CACHE_LIMIT = 600;
const FETCH_TIMEOUT_MS = 10000; // 10 seconds
const MAX_QUERY_LENGTH = 500;
const MAX_CONCURRENT_TRANSLATIONS = 5;

const rssCache = new Map();
const translationCache = new Map();
const pendingFetches = new Map(); // Deduplication for concurrent requests

// --- Updated RSS feeds (verified working feeds) ---
const rssFeeds = {
  bbc: 'https://feeds.bbci.co.uk/news/rss.xml',
  nyt: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml',
  guardian: 'https://www.theguardian.com/world/rss',
  cnn: 'http://rss.cnn.com/rss/cnn_topstories.rss',
  aljazeera: 'https://www.aljazeera.com/xml/rss/all.xml',
  npr: 'https://feeds.npr.org/1001/rss.xml',
  techcrunch: 'https://techcrunch.com/feed/',
  verge: 'https://www.theverge.com/rss/index.xml',
  wired: 'https://www.wired.com/feed/rss',
  engadget: 'https://www.engadget.com/rss.xml',
  arstechnica: 'https://feeds.arstechnica.com/arstechnica/index',
  atlantic: 'https://www.theatlantic.com/feed/all/',
  newyorker: 'https://www.newyorker.com/feed/everything',
  hackernews: 'https://hnrss.org/frontpage',
  reddit_news: 'https://www.reddit.com/r/worldnews/.rss',
  bbc_tech: 'https://feeds.bbci.co.uk/news/technology/rss.xml',
  bbc_business: 'https://feeds.bbci.co.uk/news/business/rss.xml',
  nyt_world: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
  nyt_tech: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml',
  reuters_world: 'https://www.reutersagency.com/feed/?taxonomy=best-topics&post_type=best',
  politico: 'https://rss.politico.com/politics-news.xml',
  axios: 'https://api.axios.com/feed/',
  bloomberg_tech: 'https://feeds.bloomberg.com/technology/news.rss',
  forbes: 'https://www.forbes.com/innovation/feed2/',
  sciencedaily: 'https://www.sciencedaily.com/rss/all.xml',
  nature: 'https://www.nature.com/nature.rss',
  phys: 'https://phys.org/rss-feed/',
  space: 'https://www.space.com/feeds/all',
  espn: 'https://www.espn.com/espn/rss/news'
};

const feedTitles = {
  bbc: 'BBC News',
  nyt: 'The New York Times',
  guardian: 'The Guardian',
  cnn: 'CNN',
  aljazeera: 'Al Jazeera',
  npr: 'NPR',
  techcrunch: 'TechCrunch',
  verge: 'The Verge',
  wired: 'WIRED',
  engadget: 'Engadget',
  arstechnica: 'Ars Technica',
  atlantic: 'The Atlantic',
  newyorker: 'The New Yorker',
  hackernews: 'Hacker News',
  reddit_news: 'Reddit World News',
  bbc_tech: 'BBC Tech',
  bbc_business: 'BBC Business',
  nyt_world: 'NYT World',
  nyt_tech: 'NYT Tech',
  reuters_world: 'Reuters',
  politico: 'Politico',
  axios: 'Axios',
  bloomberg_tech: 'Bloomberg Tech',
  forbes: 'Forbes',
  sciencedaily: 'Science Daily',
  nature: 'Nature',
  phys: 'Phys.org',
  space: 'Space.com',
  espn: 'ESPN'
};

// --- Helpers ---
function pruneCache(map, limit) {
  if (map.size <= limit) return;
  const iterator = map.keys();
  while (map.size > limit) {
    const key = iterator.next().value;
    if (key === undefined) break;
    map.delete(key);
  }
}

// Periodic cache cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of rssCache.entries()) {
    if (value.expires < now) rssCache.delete(key);
  }
  for (const [key, value] of translationCache.entries()) {
    if (value.expires < now) translationCache.delete(key);
  }
  rateLimitMap.clear();
}, 5 * 60 * 1000);

function stripHtml(input = '') {
  return input.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return extractText(value[0]);
  if (typeof value === 'object') {
    if ('_' in value) return extractText(value._);
    if ('$' in value && typeof value.$.href === 'string') return value.$.href;
    if (typeof value.href === 'string') return value.href;
  }
  return '';
}

function extractLink(item) {
  if (!item.link) return '';
  if (typeof item.link === 'string') return item.link;
  if (Array.isArray(item.link)) {
    for (const entry of item.link) {
      const url = extractLink({ link: entry });
      if (url) return url;
    }
    return '';
  }
  if (typeof item.link === 'object') {
    if (typeof item.link.href === 'string') return item.link.href;
    if (item.link.$ && typeof item.link.$.href === 'string') return item.link.$.href;
    if (typeof item.link._ === 'string') return item.link._;
  }
  return '';
}

function extractImage(item) {
  const mediaGroup = item['media:group'];
  if (mediaGroup) {
    const mediaContent = mediaGroup['media:content'] || mediaGroup['media:thumbnail'];
    if (mediaContent) {
      const entry = Array.isArray(mediaContent) ? mediaContent[0] : mediaContent;
      if (entry) {
        return entry.url || (entry.$ && entry.$.url) || null;
      }
    }
  }

  const mediaContent = item['media:content'] || item['media:thumbnail'];
  if (mediaContent) {
    const entry = Array.isArray(mediaContent) ? mediaContent[0] : mediaContent;
    if (entry) {
      return entry.url || (entry.$ && entry.$.url) || null;
    }
  }

  const enclosure = item.enclosure;
  if (enclosure) {
    const entry = Array.isArray(enclosure) ? enclosure[0] : enclosure;
    if (entry) {
      return entry.url || (entry.$ && entry.$.url) || null;
    }
  }

  return null;
}

function parseDate(dateString) {
  if (!dateString) return null;
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function tokenize(query) {
  return query
    .toLowerCase()
    .split(/[\s,.;:!?"'()\\[\]{}<>/@#%^&*+=|~`]+/)
    .map(token => token.trim())
    .filter(Boolean);
}

function buildSearchTokens(originalQuery, translatedQuery) {
  const tokens = new Set();
  tokenize(originalQuery).forEach(token => tokens.add(token));
  tokenize(translatedQuery).forEach(token => tokens.add(token));
  return Array.from(tokens);
}

// Fetch with timeout using AbortController
async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

// Rate-limited translation with queue
const translationQueue = [];
let activeTranslations = 0;

async function processTranslationQueue() {
  while (translationQueue.length > 0 && activeTranslations < MAX_CONCURRENT_TRANSLATIONS) {
    const task = translationQueue.shift();
    if (task) {
      activeTranslations++;
      task.execute().finally(() => {
        activeTranslations--;
        processTranslationQueue();
      });
    }
  }
}

async function translateText(text, { to = 'ru', from = 'auto' } = {}) {
  if (!text) {
    return '';
  }

  const cacheKey = `${from}|${to}|${text}`;
  const cached = translationCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.value;
  }

  return new Promise((resolve) => {
    const execute = async () => {
      try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;
        const response = await fetchWithTimeout(url, {}, 5000);

        if (!response.ok) {
          throw new Error(`Translation request failed: ${response.status}`);
        }

        const data = await response.json();
        if (!Array.isArray(data) || !Array.isArray(data[0])) {
          throw new Error('Unexpected translation payload');
        }

        const translated = data[0]
          .map(item => (Array.isArray(item) && item.length > 0 ? item[0] : ''))
          .join('');

        translationCache.set(cacheKey, { value: translated, expires: Date.now() + TRANSLATION_CACHE_MS });
        pruneCache(translationCache, TRANSLATION_CACHE_LIMIT);

        resolve(translated);
      } catch (error) {
        console.error('Translation error:', error.message);
        resolve(text);
      }
    };

    translationQueue.push({ execute });
    processTranslationQueue();
  });
}

async function translateQueryToEnglish(query) {
  try {
    return await translateText(query, { to: 'en', from: 'auto' });
  } catch (error) {
    console.error('Query translation failed:', error.message);
    return query;
  }
}

async function fetchFeedWithCache(sourceKey, rssUrl) {
  const cached = rssCache.get(rssUrl);
  if (cached && cached.expires > Date.now()) {
    return cached.value;
  }

  // Deduplication - if there's already a pending fetch for this URL, wait for it
  if (pendingFetches.has(rssUrl)) {
    return pendingFetches.get(rssUrl);
  }

  const fetchPromise = (async () => {
    try {
      const response = await fetchWithTimeout(rssUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch RSS feed (${response.status})`);
      }

      const xml = await response.text();
      const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true, trim: true });
      const parsed = await parser.parseStringPromise(xml);

      let items = [];
      if (parsed?.rss?.channel?.item) {
        items = Array.isArray(parsed.rss.channel.item) ? parsed.rss.channel.item : [parsed.rss.channel.item];
      } else if (parsed?.feed?.entry) {
        items = Array.isArray(parsed.feed.entry) ? parsed.feed.entry : [parsed.feed.entry];
      }

      const articles = items.map((item, index) => normalizeArticle(sourceKey, item, index)).filter(Boolean);

      rssCache.set(rssUrl, { value: articles, expires: Date.now() + RSS_CACHE_MS });
      pruneCache(rssCache, RSS_CACHE_LIMIT);

      return articles;
    } finally {
      pendingFetches.delete(rssUrl);
    }
  })();

  pendingFetches.set(rssUrl, fetchPromise);
  return fetchPromise;
}

function normalizeArticle(sourceKey, item, index) {
  if (!item) return null;

  const title = stripHtml(extractText(item.title) || '');
  const description = stripHtml(
    extractText(item.description) ||
      extractText(item.summary) ||
      extractText(item['media:description']) ||
      extractText(item['content:encoded'])
  );
  const link = extractLink(item);
  const imageUrl = extractImage(item);
  const fullTextSource =
    extractText(item['content:encoded']) ||
    extractText(item.description) ||
    extractText(item.summary) ||
    extractText(item.content) ||
    '';
  const fullTextClean = stripHtml(fullTextSource);
  const fullText = fullTextClean.length > 4000 ? `${fullTextClean.slice(0, 4000)}…` : fullTextClean;
  const publishedDate =
    parseDate(item.pubDate) || parseDate(item.published) || parseDate(item.updated) || parseDate(item.date);
  const publishedAt = publishedDate ? publishedDate.toISOString() : null;
  const publishedAtMs = publishedDate ? publishedDate.getTime() : 0;
  const guid =
    extractText(item.guid) ||
    (typeof item.id === 'string' ? item.id : '') ||
    link ||
    `${sourceKey}-${publishedAtMs || Date.now()}-${index}`;

  return {
    id: guid,
    source: sourceKey,
    sourceTitle: feedTitles[sourceKey] || sourceKey,
    title: title || '(Без заголовка)',
    snippet: description || '(Описание недоступно)',
    link: link || '',
    imageUrl: imageUrl || null,
    fullText,
    publishedAt,
    publishedAtMs
  };
}

function scoreArticle(article, tokens) {
  if (!tokens.length) return { article, score: 0 };
  const haystack = `${article.title} ${article.snippet} ${article.fullText}`.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += 1;
    }
  }
  return { article, score };
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    cacheSize: {
      rss: rssCache.size,
      translation: translationCache.size
    }
  });
});

// /api/search?q=topic&source=bbc
app.get('/api/search', async (req, res) => {
  const source = (req.query.source || '').toLowerCase().slice(0, 50);
  let searchQuery = (req.query.q || '').trim();

  // Validate and limit query length
  if (searchQuery.length > MAX_QUERY_LENGTH) {
    searchQuery = searchQuery.slice(0, MAX_QUERY_LENGTH);
  }

  try {
    // Validate source if provided
    const sourcesToLoad = source && rssFeeds[source]
      ? [source]
      : Object.keys(rssFeeds);

    let tokens = [];
    if (searchQuery) {
      const translatedQuery = await translateQueryToEnglish(searchQuery);
      tokens = buildSearchTokens(searchQuery, translatedQuery);
    }

    const articlesNested = await Promise.all(
      sourcesToLoad.map(async key => {
        const rssUrl = rssFeeds[key];
        if (!rssUrl) {
          return [];
        }
        try {
          return await fetchFeedWithCache(key, rssUrl);
        } catch (error) {
          console.error(`Failed to fetch feed "${key}"`, error.message);
          return [];
        }
      })
    );

    let articles = articlesNested.flat();

    if (tokens.length) {
      articles = articles
        .map(article => scoreArticle(article, tokens))
        .filter(item => item.score > 0)
        .sort((a, b) => {
          if (b.score !== a.score) {
            return b.score - a.score;
          }
          return (b.article.publishedAtMs || 0) - (a.article.publishedAtMs || 0);
        })
        .map(item => item.article);
    } else {
      articles.sort((a, b) => (b.publishedAtMs || 0) - (a.publishedAtMs || 0));
    }

    const limited = articles.slice(0, 30);

    const translated = await Promise.all(
      limited.map(async item => {
        const [titleRu, snippetRu] = await Promise.all([
          translateText(item.title, { to: 'ru', from: 'auto' }),
          translateText(item.snippet, { to: 'ru', from: 'auto' })
        ]);
        return {
          ...item,
          title_ru: titleRu,
          snippet_ru: snippetRu
        };
      })
    );

    res.json({ ok: true, results: translated, count: translated.length });
  } catch (error) {
    console.error('RSS parsing error:', error);
    res.status(500).json({ ok: false, error: 'Failed to parse RSS feed.' });
  }
});

app.post('/api/translate', async (req, res) => {
  const { text, to } = req.body || {};

  if (!text) {
    return res.status(400).json({ ok: false, error: 'text required' });
  }

  // Validate text length
  if (typeof text !== 'string' || text.length > 10000) {
    return res.status(400).json({ ok: false, error: 'Invalid text' });
  }

  // Validate target language
  const validLanguages = ['ru', 'en', 'de', 'fr', 'es', 'it', 'pt', 'zh', 'ja', 'ko'];
  const targetLang = validLanguages.includes(to) ? to : 'ru';

  const translated = await translateText(text, { to: targetLang, from: 'auto' });
  res.json({ ok: true, translated });
});

// List available sources
app.get('/api/sources', (req, res) => {
  const sources = Object.entries(feedTitles).map(([key, title]) => ({
    id: key,
    title
  }));
  res.json({ ok: true, sources });
});

// Serve index.html for root path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Catch-all for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Export for Vercel serverless
module.exports = app;

// Start server only if run directly (not imported by Vercel)
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}
