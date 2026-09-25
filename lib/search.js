const { CONFIG, SOURCES, TOP_SOURCES, CATEGORY_SOURCES } = require('./config');
const { LRUCache } = require('./cache');
const { mapPoolWithDeadline, withTimeout } = require('./async');
const { dedupeArticles, expandQueryTerms, scoreArticle } = require('./text');

/**
 * Which feed keys a search should hit.
 * An explicit source wins. A category beats the scope toggles.
 * allSources, or a free-text query of at least two characters, fans out
 * across the catalog. viewAll only raises the result limit.
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

  async _searchUncached(query, sourceKey, { viewAll, category, allSources, cacheKey }) {
    const normQuery = (query || '').trim().toLowerCase();
    const sources = resolveSources({
      sourceKey,
      normQuery,
      viewAll,
      allSources,
      category,
      skipKeys: this.rssService.health?.openKeys(),
    });

    const deadlineMs = CONFIG.SEARCH.DEADLINE_MS;
    const deadlineAt = deadlineMs > 0 ? Date.now() + deadlineMs : Infinity;

    // Query translation does not need feed bodies. Start it now so a slow
    // catalog does not eat the translate budget, and a hung translator
    // cannot hold the response past QUERY_TRANSLATE_MS.
    const queryTranslation = normQuery
      ? withTimeout(
        this.translationService.translate(normQuery, 'en'),
        CONFIG.SEARCH.QUERY_TRANSLATE_MS,
        null,
      )
      : null;

    const allArticles = [];
    const sourcesFailed = [];
    let originOk = 0;

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
        const translated = await queryTranslation;
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

module.exports = { SearchService, resolveSources, hydrateSearchCache };
