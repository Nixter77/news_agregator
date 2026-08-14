# Code Review — news_agregator (Run 2/3)

**Stack:** Node.js 18+ · Express 4.22 · static HTML/CSS/JS · xml2js · Vercel (`@vercel/node`)  
**Scope:** `server.js`, `js/main.js`, `index.html`, `package.json`, `.env.example`, `test/server.test.js`  
**Reviewer stance:** Senior Software Engineer + Security Specialist (OWASP Top 10, performance, SOLID/DRY)  
**Date:** 2026-08-15

---

## 1. Executive Summary

Run 1’s blocking design bugs were already in the working tree at the start of this fire (fail-closed cron, no public origin-flood on `refresh`, article `fullText` on the RSS envelope, search L2, hashed translation keys, origin-aware CORS, HSTS). This fire closed the **remaining exploitable gaps**: redirect-follow SSRF, missing-`Origin` translate proxy, one-character catalog fan-out, and incomplete private-IP blocking (IPv6 / mapped IPv4).

`npm test` is green: **51/51**. `NODE_ENV=test` is now set by the test script so fail-closed cron/origin checks do not break CI.

**Verdict:** residual risk is operational (unsigned L2, unofficial `gtx` Translate, per-isolate rate limits), not an open amplification primitive. No remaining critical issues in the current tree.

---

## 2. Critical Issues (Security / Performance)

### 2.1 A10 SSRF via `redirect: 'follow'` — FIXED this fire

Run 1 noted that `fetchWithRetry` followed redirects and only inspected `response.url` after the hop. A compromised publisher 302 could already have hit `169.254.169.254` or RFC1918.

**Change:** `fetchFollowingRedirects` uses `redirect: 'manual'`, re-resolves `Location` against the current URL, and runs `assertSafeDestination` **before** each hop (max 5). Blocked destinations now use HTTP 403 so they are not retried as 5xx.

### 2.2 A04 Translate proxy without Origin — FIXED this fire

`isTrustedBrowserOrigin` treated a missing `Origin` as trusted. Browsers send `Origin` on `fetch` POST; curl/scripts do not. Anyone could still drive the unofficial `gtx` proxy.

**Change:** missing Origin is allowed only when `NODE_ENV=test`. Otherwise require Origin (or Referer host) to match `ALLOWED_ORIGIN` or `Host`. Cross-origin browser POSTs still 403.

### 2.3 A04 / performance — 1-char query fan-out — FIXED this fire

`resolveSources` treated any non-empty `normQuery` as “full catalog” (~30 feeds). Token scoring already drops tokens shorter than 2, so a one-letter query paid the fan-out for almost no extra recall.

**Change:** full catalog requires `allSources` or `normQuery.length >= 2`. Client debounce is 650 ms and skips 1-character input.

### 2.4 A01 cron fail-closed / A02 timing-safe compare — FIXED (prior + verified)

`authorizeCron` uses `timingSafeEqual` and denies when `CRON_SECRET` is unset except `NODE_ENV=test`. Dual header (`Authorization` / `x-cron-secret`) remains, both compared in constant time.

**This fire:** `npm test` sets `NODE_ENV=test`; cron restore no longer assigns `undefined` (which Node stringifies).

### 2.5 Article body + search cache not on L2 — FIXED (prior)

`fullText` lives on the cached article; `getFullTextAsync` rehydrates `articleStore` from the RSS envelope. Search cache is a `LayeredCache` (`sch:`). Public search JSON still strips `fullText`.

### 2.6 `refresh=true` amplification — FIXED (prior)

Public search never passes `forceRefresh`. `refresh=true` only busts search L1 and is capped at 6/min (`refreshLimiter`). Cron is no longer exempt from the general 60/min limiter.

### 2.7 A05 leftovers

| Item | Status |
|------|--------|
| CORS default `*` | **FIXED** — empty `ALLOWED_ORIGIN` = same-origin only |
| CNN `http://` | **FIXED** — all feeds `https://` (test-enforced) |
| Unused `node-fetch` | **FIXED** — removed; Express 4.22.2 + overrides |
| HSTS / Permissions-Policy | **FIXED** |
| XML entity expansion | **FIXED** — `<!ENTITY` rejected; parser `strict` + `xmlns: false` |
| Circuit on 5xx/timeout | **FIXED** — flaky trips at `failThreshold + 2` |
| Health cache/L2 recon | **Accepted** — tests assert `cache.*` and `store.l2`; no secrets |
| `trust proxy = 1` | Residual — correct only behind a single trusted hop |
| CSP `style-src 'unsafe-inline'` | Residual — needed for card styles |
| Unofficial `gtx` Translate | Residual WARNING — origin-gated + 20/min, still ToS-brittle |
| L2 envelopes unsigned | Residual A08 — poisoned Redis = poisoned news |
| Per-isolate rate limit | Residual — each Vercel isolate has its own 60/min |

### 2.8 OWASP Top 10 checklist

| # | Theme | Status after run 2 |
|---|--------|-------------------|
| A01 | Broken Access Control | Cron fail-closed; translate origin-gated |
| A02 | Cryptographic Failures | `timingSafeEqual`; all feeds HTTPS |
| A03 | Injection | Entity XML rejected; time attrs escaped |
| A04 | Insecure Design | Refresh/translate budgets; no public origin flood |
| A05 | Security Misconfiguration | CORS default locked; HSTS; `.env.example` complete |
| A06 | Vulnerable Components | `node-fetch` gone; Express 4.22.2 |
| A07 | Auth Failures | Cron Bearer + header, constant-time |
| A08 | Integrity Failures | Residual: unsigned L2 |
| A09 | Logging / Monitoring | Request IDs; still no 429/upstream alerts |
| A10 | SSRF | Manual redirects + private-host deny (incl. IPv6) |

---

## 3. Code Quality

- **S:** `server.js` is still a modular monolith (required). Services remain the split (`RSSService` / `SearchService` / `TranslationService` / `LayeredCache`).
- **DRY:** translation keys hashed on both get/set; `assertSafeDestination` shared by first hop and redirects.
- **Background job** only warms `TOP_SOURCES` (no longer the full catalog every 5 minutes).
- Tests added/extended this fire: 1-char `resolveSources`, IPv6/mapped loopback, private redirect, translate-without-Origin in production.

---

## 4. Refactored examples (this fire)

### Safe outbound fetch (no automatic SSRF)

```javascript
async function fetchFollowingRedirects(url, { signal, headers } = {}) {
  let current = String(url);
  assertSafeDestination(current);
  for (let hop = 0; hop < (CONFIG.FETCH.MAX_REDIRECTS || 5); hop += 1) {
    const response = await fetchImpl(current, { signal, headers, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const loc = response.headers.get('location');
      if (!loc) throw httpError(`Status ${response.status}`, response.status);
      const next = new URL(loc, current).href;
      assertSafeDestination(next);
      current = next;
      continue;
    }
    return response;
  }
  throw httpError('Too many redirects', 403);
}
```

### Translate: fail closed without a matching browser origin

```javascript
function isTrustedBrowserOrigin(req) {
  const origin = String(req.headers.origin || '');
  const referer = String(req.headers.referer || '');
  const host = String(req.headers.host || '');
  if (origin) return hostFromAbsoluteUrl(origin) === host;
  if (referer) return hostFromAbsoluteUrl(referer) === host;
  return process.env.NODE_ENV === 'test';
}
```

### Search: do not wake 30 feeds for `"a"`

```javascript
} else if (allSources || (normQuery && String(normQuery).trim().length >= 2)) {
  keys = Object.keys(SOURCES);
} else {
  keys = TOP_SOURCES.filter((id) => SOURCES[id]);
}
```

---

## Review metadata

- **Run:** 2 of 3  
- **Tests:** `npm test` — 51 passed, 0 failed (2.7s)  
- **Next run should:** confirm no regression of redirect allowlist / origin gate / cron fail-closed; only pick up new residuals (unsigned L2, `gtx` ToS, health recon) if still desired.

### FIXED vs remaining (for run 3)

| Finding | State |
|---------|--------|
| Translate proxy + CORS `*` | FIXED (origin gate + same-origin default) |
| `refresh=true` origin flood | FIXED |
| Article / search not on L2 | FIXED |
| Cron timing / fail-open | FIXED |
| Circuit 5xx/timeout | FIXED |
| CNN HTTP | FIXED |
| `node-fetch` | FIXED |
| timeMeta XSS | FIXED |
| Redirect SSRF | FIXED this fire |
| Missing-Origin translate | FIXED this fire |
| 1-char catalog fan-out | FIXED this fire |
| Health recon, unsigned L2, `gtx` ToS | Residual (non-critical) |
