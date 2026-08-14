# Code Review — news_agregator (Run 1/3)

**Stack:** Node.js 18+ · Express 4 · static HTML/CSS/JS · xml2js · Vercel (`@vercel/node`)  
**Scope:** `server.js` (1862 loc monolith), `js/main.js` (1776 loc), `index.html`, `vercel.json`, `test/server.test.js`  
**Reviewer stance:** Senior Software Engineer + Security Specialist (OWASP Top 10, performance, SOLID/DRY)  
**Date:** 2026-08-15

---

## 1. Executive Summary

The project is a Vercel-oriented RSS aggregator with SWR/L2 caching, bounded feed concurrency, a search deadline, circuit-ish source health, CSP, query validation, and a surprisingly thorough test suite. The architecture *intent* is sound: `RSSService` / `SearchService` / `TranslationService` + layered cache.

Production-readiness is still blocked by three design bugs that matter more than style:

1. **Open translation proxy + CORS `*`** — any origin can POST up to 10 KB (or 20×2 KB batch) through this host to the unofficial Google `gtx` endpoint. Rate limit is 60 req/min and **does not apply to `/api/cron/*`**.
2. **`refresh=true` is an upstream amplification primitive** — one client request can force-revalidate the full catalog (~30 feeds × 8 s timeout × retries). Combined with 60 req/min this can DDoS publishers *and* exhaust the Vercel function.
3. **Article bodies live only in process RAM** (`rssService.articleStore`). On Vercel isolates, `/api/article` 404s after a different instance handled `/api/search`. Search L1 is also not on L2, so cold starts re-fan-out even when Upstash is configured.

Security hygiene is better than average for a hobby aggregator (CSP, `nosniff`, JSON body 80 KB, query-array rejection, `safeExternalUrl`, `escapeHtml` on most innerHTML). Residual risk is **insecure design and misconfiguration**, not classic XSS/SQLi.

**Verdict:** do not treat the current deploy as a public multi-tenant API until refresh is cost-capped, translation is origin-restricted (or removed from the public surface), cron uses a constant-time secret, and article text is in the shared store.

---

## 2. Critical Issues (Security / Performance)

### 2.1 A04 Insecure Design — public Google Translate proxy (High)

```1735:1759:server.js
app.post('/api/translate', async (req, res) => {
  // ...
  const translated = await translationService.translate(text, targetLang);
```

```880:882:server.js
const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
const response = await fetchWithRetry(url, { attempts: 2, timeoutMs: CONFIG.FETCH.TIMEOUT });
```

- Unofficial `client=gtx` API: ToS violation, brittle, and your server’s IP gets the ban — not the caller’s.
- `ALLOWED_ORIGIN` defaults to `*` (`CONFIG` + `.env.example`). Any website can `fetch` this API (CORS allows GET/POST).
- Budget: 60 req/min × 10 000 chars, or `/api/translate/batch` 20 × 2 000 = **~2.4M chars/min per IP**.
- Frontend then *also* batch-translates every missing title/snippet after search (`ensureArticlesTranslated`), stacking load on the same queue (cap 200, then silent drop).

**Fix:** bind CORS to a real origin in production; require a same-origin check (`Origin`/`Referer`) even if CORS is set; hash+cap translation keys; prefer a billed Translate API with a key that never leaves the server; do not expose raw translate to anonymous clients (search-only, cache-only).

### 2.2 A04 / A05 — `refresh=true` + `all_sources` amplification (High, perf + abuse)

```1273:1277:server.js
const { results: feedSlots, deadlineHit } = await mapPoolWithDeadline(
  sources,
  (key) => this.rssService.fetchFeed(key, SOURCES[key].url, { forceRefresh: Boolean(refresh) }),
  { concurrency: CONFIG.FETCH.MAX_CONCURRENT_FEEDS, deadlineAt }
);
```

- `refresh=true` skips search cache **and** forces origin GETs (test: `forceRefresh issues a new origin GET`).
- Default rate limit: 60/min, **including** search. Worst case ≈ 60 × 30 feeds = **1 800 outbound RSS GETs/min per IP**, plus retries (`RETRIES: 2`, 8 s timeout).
- `/api/` rate limiter **explicitly skips cron**:

```1532:1535:server.js
app.use('/api/', (req, res, next) => {
  if (req.path.startsWith('/cron')) return next();
  return rateLimiter.middleware()(req, res, next);
});
```

- `authorizeCron` allows **anyone** when `CRON_SECRET` is unset and `VERCEL` is unset (local/prod-misconfig). Comparison is not `timingSafeEqual`.

```747:755:server.js
function authorizeCron(req) {
  const secret = process.env.CRON_SECRET || '';
  const auth = String(req.headers.authorization || '');
  const header = String(req.headers['x-cron-secret'] || '');
  if (secret) {
    return auth === `Bearer ${secret}` || header === secret;
  }
  return !process.env.VERCEL;
}
```

**Fix:** separate, much lower budget for `refresh` (e.g. 2/min); ignore `forceRefresh` unless the caller is cron or an admin token; always require `CRON_SECRET` outside `NODE_ENV=test`; compare secrets in constant time; rate-limit cron too.

### 2.3 Serverless correctness — article body + search cache not on L2 (High / broken UX)

```1159:1161:server.js
const fullText = collapseWs(stripHtml(rawHtml)).substring(0, 4000);
const articleKey = `${sourceKey}:${id}`;
this.articleStore.set(articleKey, ...);
```

`articleStore` is a process-local `LRUCache(2000)`. RSS L2 stores **public** articles (no `fullText`). `/api/article` only reads RAM:

```1701:1704:server.js
const fullText = rssService.getFullText(sourceKey, articleId);
if (!fullText) {
  return res.status(404).json({ ok: false, error: 'Article not found' });
}
```

On Vercel: search on isolate A, modal fetch on isolate B → 404. README advertises Upstash/Runtime Cache, but **search results are L1-only** (`SearchService.searchCache = new LRUCache(...)`), so homepage cache also does not survive a new lambda.

`startBackgroundJobs()` only runs when `require.main === module` (good for tests; **dead on Vercel**). Cron warmup helps RSS L2 but not article bodies.

**Fix:** persist `{ fullText }` in the RSS L2 envelope (or a dedicated `article:` key); hydrate `articleStore` on feed read; put search payloads on `LayeredCache` with a short TTL.

### 2.4 A05 Security misconfiguration (Medium–High)

| Item | Evidence | Risk |
|------|----------|------|
| CORS default `*` | `ALLOWED_ORIGIN \|\| '*'` | Cross-origin abuse of translate/search |
| `.env.example` incomplete | Only `PORT` + `ALLOWED_ORIGIN` | Operators ship without `CRON_SECRET` / Redis |
| `trust proxy = 1` | `app.set('trust proxy', 1)` | Rate-limit key (`req.ip`) is whatever the first hop claims if the hop is wrong |
| No HSTS / Permissions-Policy | Custom headers only | Cookie-less site, still missing transport hardening |
| CSP `style-src 'unsafe-inline'` | `CSP_HEADER` | Weakens XSS containment (inline styles in cards) |
| CNN feed is **HTTP** | `http://rss.cnn.com/rss/edition.rss` | MITM can poison CNN items for every user of the cache |
| `xml2js` 2 MB bodies | `MAX_BODY_BYTES`, no entity/depth caps | Parse DoS (billion-laughs / quadratic XML) |
| Unused `node-fetch` | in `package.json`, never `require`d | Extra supply-chain surface (A06) |

Circuit breaker only opens on **403/404/410/415**. Timeouts and 5xx never trip it, so a dead feed is re-hit on every search for 30 minutes of “cooldown” that never starts.

```361:364:server.js
const hardFail = status === 403 || status === 404 || status === 410 || status === 415;
if (hardFail && rec.count >= this.failThreshold) {
  rec.openUntil = Date.now() + this.cooldownMs;
}
```

### 2.5 A01 / A07 — weak cron auth & info leak (Medium)

- Dual secret channels (`Authorization` **or** `x-cron-secret`) double the leak surface.
- Timing-unsafe string compare.
- `GET /health` is unauthenticated and reports cache sizes + L2 backend name (recon for cache-poison / capacity).

### 2.6 A03 Injection — residual XSS (Low)

Client generally does this right: `escapeHtml` + `safeExternalUrl` (blocks `javascript:` / `data:`) + `textContent` for modal body.

Two slips in `createCard`:

```1449:1451:js/main.js
<span class="news-meta-source">${safeSourceTitle}</span>
<span title="${timeMeta.absolute}">${timeMeta.relative}</span>
```

`timeMeta.absolute` / `relative` are not escaped. Today they come from `Intl.DateTimeFormat` (safe). If `publishedAt` handling ever changes, this becomes an attribute-injection hole. Highlight path is OK: escape first, then wrap `$1` after `RegExp` escaping.

Server `stripHtml` is a regex (`/<[^>]+>/g`), not a parser — fine for snippets, not a sanitizer.

### 2.7 A10 SSRF

Feed URLs are hardcoded in `SOURCES` (good). `fetchWithRetry` follows redirects — a compromised publisher 302 can pivot the server to an internal URL **if** the host is ever run inside a VPC. Pin allowlist hostnames after redirect or use `redirect: 'manual'` + re-check host.

Translation URL interpolates user text only as `q=`; not SSRF.

### 2.8 Performance bottlenecks (beyond refresh)

- **Cold search** still fans out to `TOP_SOURCES` (10) or the full catalog on any non-empty query (`resolveSources`: `allSources || normQuery` → `Object.keys(SOURCES)`). A one-letter query (min token length 2 on score, but fetch already happened) wakes ~30 feeds.
- **Deadline** returns partial results and **does not cache** them — the next user repeats the same expensive miss.
- **Background job** (local) walks *all* sources every 5 minutes **and** cron warms top sources — double fetch; easy to get 429/banned from Reddit/Bloomberg.
- **Translation cache key** is `` `${lang}|${full text}` `` — huge Map keys; L2 hashes only when `prefix:key` > 180 chars, L1 does not.
- **No `compression` middleware**; 100-card JSON + translations is chatty on mobile.
- **Client**: 450 ms debounce on *every* keystroke still hits `/api/search`; `view_all` + translate can fire 5 batch POSTs immediately after the search GET.
- **Vercel `builds` (legacy)** in `vercel.json` + catch-all `/(.*)` → `server.js` makes static assets potentially go through the Node function depending on route order.

### 2.9 OWASP Top 10 checklist

| # | Theme | Status |
|---|--------|--------|
| A01 | Broken Access Control | Cron optional secret; health public |
| A02 | Cryptographic Failures | Timing-unsafe secret compare; HTTP CNN |
| A03 | Injection | Mostly mitigated; XML parse DoS; unescaped time attrs |
| A04 | Insecure Design | Translate proxy; refresh amplification |
| A05 | Security Misconfiguration | CORS `*`; missing HSTS; incomplete `.env.example` |
| A06 | Vulnerable Components | `node-fetch` unused; pin-audit `npm audit` not in CI |
| A07 | Auth Failures | Cron Bearer vs header, no rotation story |
| A08 | Integrity Failures | L2 envelopes unsigned; poisoned Redis = poisoned news |
| A09 | Logging / Monitoring | Request IDs good; no metrics/alerts on 429/upstream |
| A10 | SSRF | Hardcoded feeds; open redirects on fetch |

---

## 3. Code Quality Improvements

### SOLID

- **S — Single Responsibility:** `server.js` owns config, caches, HTTP, RSS parse, search, translation, cron, and process lifecycle. Tests reach internals via `app.helpers` / `app.services` (convenient, leaky). Split into `lib/config.js`, `lib/cache.js`, `lib/rss.js`, `lib/search.js`, `lib/translate.js`, `lib/http.js`.
- **O — Open/Closed:** adding a source is a data change (good). Adding a search policy requires editing `resolveSources` + `SearchService` (closed).
- **L / I:** service classes are fine; `LayeredCache` duck-types `getAsync` on the translation path (`typeof this.cache.getAsync === 'function'`).
- **D — Dependency inversion:** `setFetchImpl` is the right seam; production still `require`s `@vercel/functions` inside `createSharedStore` (hard to test without env).

### DRY / consistency

- Tokenize / translit / highlight exist independently on server and client.
- `sanitizeString` on the client is just `typeof str === 'string' ? str : ''` — name oversells safety; callers must remember `escapeHtml`.
- Duplicate highlight-regex construction in `renderArticles` and `patchCardTranslations`.
- `hydrateSearchCache` supports a legacy array shape that nothing writes anymore.

### Other quality notes

- Rate limiter `Map` is per-process and keyed only by IP; prune is interval-based — fine at hobby scale, useless across Vercel instances (each isolate has its own 60/min).
- `processQueue` fire-and-forgets another `processQueue()`; works, but errors in the recursive call are unhandled if `_performTranslation` throws after `activeWorkers` accounting (it does have try/finally).
- Caching `null` is avoided on throw, but a successful empty string is stored and then treated as miss (`if (cached)`) — extra Google traffic.
- Tests are a strength (deadline, HTML-as-RSS, cron secret, param arrays). Missing: CORS/refresh rate-limit, article L2 hydration, redirect allowlist.

### Frontend / a11y (non-blocking)

- `searchFeedback.textContent` interpolates the raw query (safe). Empty-state copy is static (good).
- Modal uses `<dialog>` correctly; skip-link and `role="switch"` are present.
- `img-src https:` allows any CDN — expected for RSS thumbs, but it is a tracking pixel channel.

---

## 4. Refactored Code Example

Goal of this snippet: (1) constant-time cron auth that fails closed, (2) persist article bodies next to RSS so `/api/article` works on any isolate, (3) trip the circuit on timeouts/5xx, (4) stop treating `refresh=true` as a free origin-flood.

```javascript
const { timingSafeEqual } = require('crypto');

function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) {
    timingSafeEqual(left, left); // keep timing flat
    return false;
  }
  return timingSafeEqual(left, right);
}

function authorizeCron(req) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) {
    // Fail closed everywhere except explicit local test.
    return process.env.NODE_ENV === 'test';
  }
  const auth = String(req.headers.authorization || '');
  const expected = `Bearer ${secret}`;
  return safeEqual(auth, expected);
}

// --- RSS: keep fullText in the cached article (L2-friendly) ---
_normalizeItem(sourceKey, item, index) {
  // ...existing title/snippet/link parsing...
  const fullText = collapseWs(stripHtml(rawHtml)).substring(0, 4000);
  const article = {
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
    fullText: !isJunkSnippet(fullText) && fullText.length > 3 ? fullText : '',
  };
  this.articleStore.set(`${sourceKey}:${id}`, article.fullText);
  return article;
}

getFullText(sourceKey, id) {
  const key = `${sourceKey}:${id}`;
  const local = this.articleStore.get(key);
  if (local) return local;
  return null;
}

async getFullTextAsync(sourceKey, id) {
  const key = `${sourceKey}:${id}`;
  const local = this.articleStore.get(key);
  if (local) return local;
  // Rehydrate from any cached feed that already contains this item.
  const source = SOURCES[sourceKey];
  if (!source?.url) return null;
  const bundle = await this.cache.getAsync(source.url);
  const hit = Array.isArray(bundle) && bundle.find((a) => a.id === id);
  if (hit?.fullText) {
    this.articleStore.set(key, hit.fullText);
    return hit.fullText;
  }
  return null;
}

// --- Circuit: timeouts and 5xx count, not only hard HTTP codes ---
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

// --- Search: refresh is cron/admin only; strip fullText from public JSON ---
async _searchUncached(query, sourceKey, { viewAll, refresh, category, allSources, cacheKey }) {
  const allowOriginRefresh = refresh && Boolean(process.env.CRON_SECRET);
  // public ?refresh=true only busts the search L1, never force-hits publishers
  const forceRefresh = allowOriginRefresh;
  // ... fetchFeed(..., { forceRefresh }) ...
  const finalResults = results.slice(0, limit).map((article) => {
    const { cleanLink, normTitle, fullText, ...publicArticle } = article;
    return publicArticle;
  });
  // ...
}

// Rate-limit: do not skip cron; add a tighter bucket for refresh=true in /api/search.
```

Also required outside this snippet:

- Set `ALLOWED_ORIGIN` to the real site; reject translate POSTs without a matching `Origin`.
- Put `searchService.searchCache` behind `LayeredCache` (prefix `search`, TTL 60 s).
- Document `CRON_SECRET`, `SEARCH_DEADLINE_MS`, and Upstash vars in `.env.example`.
- Upgrade CNN (and any other `http://`) to HTTPS or drop the source.
- Remove unused `node-fetch`.
- Escape `timeMeta.absolute` / `relative` in `createCard`.

---

## Review metadata

- **Run:** 1 of 3  
- **Method:** static review of repo sources (no live exploit, no second pass)  
- **Tests:** not re-executed in this fire  
- **Next run should:** verify whether article L2 / cron fail-closed / refresh cap landed; re-scan `server.js` size after any split.
