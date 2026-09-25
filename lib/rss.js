const xml2js = require('xml2js');
const { CONFIG, SOURCES } = require('./config');
const { LRUCache } = require('./cache');
const {
  fetchWithRetry,
  readLimitedText,
  assertSafeDestination,
  assertXmlLike,
  statusFromError,
} = require('./net');
const { recordMetric } = require('./metrics');
const {
  collapseWs,
  stripHtml,
  getText,
  isMetaFeedItem,
  isJunkSnippet,
  extractOutboundLink,
  pickMediaUrl,
  extractImagesFromHtml,
  normalizeLink,
  normalizeTitle,
} = require('./text');

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

module.exports = { RSSService, SourceHealth };
