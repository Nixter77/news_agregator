/**
 * News aggregator HTTP entry.
 * Feed, search, translation, and cache behavior live in lib/.
 */

const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');

const {
  CONFIG,
  SOURCES,
  TOP_SOURCES,
  CATEGORY_SOURCES,
  resolveTargetLang,
  CSP_HEADER,
} = require('./lib/config');
const {
  setFetchImpl,
  isTrustedBrowserOrigin,
  allowedOriginList,
  isPrivateOrLocalHost,
  assertSafeDestination,
  hostFromAbsoluteUrl,
} = require('./lib/net');
const { mapPoolWithDeadline } = require('./lib/async');
const {
  LRUCache,
  LayeredCache,
  MemorySharedStore,
  createSharedStore,
  signCacheEnvelope,
  isSignedCacheEnvelope,
} = require('./lib/cache');
const { metrics, recordMetric } = require('./lib/metrics');
const { safeEqual } = require('./lib/secret');
const { RateLimiter, authorizeCron, clientKey } = require('./lib/rate-limit');
const { TranslationService, translationCacheKey } = require('./lib/translate');
const { RSSService } = require('./lib/rss');
const { SearchService, resolveSources, hydrateSearchCache } = require('./lib/search');
const {
  transliterateCyrillic,
  expandQueryTerms,
  tokenize,
  isPlaceholderText,
  isJunkSnippet,
  isMetaFeedItem,
  isTranslatableText,
  extractImagesFromHtml,
  extractOutboundLink,
} = require('./lib/text');

const sharedStore = createSharedStore();
const rssCache = new LayeredCache(new LRUCache(CONFIG.CACHE.RSS_LIMIT), sharedStore, { prefix: 'rss' });
const translationCache = new LayeredCache(new LRUCache(CONFIG.CACHE.TRANSLATION_LIMIT), sharedStore, { prefix: 'tr' });
const translationService = new TranslationService(translationCache);
const rssService = new RSSService(rssCache);
const searchCache = new LayeredCache(new LRUCache(CONFIG.CACHE.SEARCH_LIMIT), sharedStore, { prefix: 'sch' });
const searchService = new SearchService(rssService, translationService, searchCache);
const RL = CONFIG.RATE_LIMIT;
const rateLimiter = new RateLimiter(RL.WINDOW_MS, RL.MAX_REQUESTS, { longWindowMs: RL.LONG_WINDOW_MS, longMax: RL.LONG_MAX_REQUESTS, maxKeys: RL.MAX_KEYS });
const refreshLimiter = new RateLimiter(RL.WINDOW_MS, RL.REFRESH_MAX, { longWindowMs: RL.LONG_WINDOW_MS, longMax: RL.LONG_REFRESH_MAX, maxKeys: RL.MAX_KEYS });
const translateLimiter = new RateLimiter(RL.WINDOW_MS, RL.TRANSLATE_MAX, { longWindowMs: RL.LONG_WINDOW_MS, longMax: RL.LONG_TRANSLATE_MAX, maxKeys: RL.MAX_KEYS });

async function loadTopFeeds(deadlineMs) {
  const keys = TOP_SOURCES.filter((id) => SOURCES[id]);
  const deadlineAt = deadlineMs > 0 ? Date.now() + deadlineMs : Infinity;
  const { results } = await mapPoolWithDeadline(
    keys,
    (key) => rssService.fetchFeed(key, SOURCES[key].url),
    { concurrency: CONFIG.FETCH.MAX_CONCURRENT_FEEDS, deadlineAt },
  );
  return { keys, results };
}

async function warmupTopSources() {
  const { keys, results } = await loadTopFeeds(20_000);
  const warmed = [];
  const failed = [];
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
    const { results } = await loadTopFeeds(0);
    const allArticles = [];
    for (const slot of results) {
      if (slot?.ok && Array.isArray(slot.value?.articles)) {
        allArticles.push(...slot.value.articles);
      }
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
    return cb(null, allowedOriginList().includes(String(origin || '').replace(/\/$/, '')));
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
  // Internal counters are recon material: only show them to the cron/ops
  // secret holder, never by default (Vercel does not set NODE_ENV for us).
  if (authorizeCron(req)) {
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

function flagOn(value) {
  return value === 'true';
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

    if (flagOn(refresh)) {
      const { limited, retryAfterSec } = refreshLimiter.consume(clientKey(req));
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
      viewAll: flagOn(viewAll),
      allSources: flagOn(allSources),
      refresh: flagOn(refresh),
      category,
    });

    const enrichedResults = enrichWithTranslations(results);

    res.setHeader('Cache-Control', flagOn(refresh) ? 'no-store' : 'private, max-age=30');
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
    if (flagOn(translate)) {
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

function rejectUntrustedTranslate(req, res) {
  if (!isTrustedBrowserOrigin(req)) {
    res.status(403).json({ ok: false, error: 'Origin not allowed' });
    return true;
  }
  const { limited, retryAfterSec } = translateLimiter.consume(clientKey(req));
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

    const translated = await translationService.translate(text, resolveTargetLang(to));
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

    const targetLang = resolveTargetLang(to);
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
