# Code Review — news_agregator (Run 3/3)

**Stack:** Node.js 18+ · Express 4.22 · static HTML/CSS/JS · xml2js · Vercel (`@vercel/node`)  
**Scope:** `server.js`, `test/server.test.js`, `.env.example`, `README.md`  
**Reviewer stance:** Senior Software Engineer + Security Specialist (OWASP Top 10, performance, SOLID/DRY)  
**Date:** 2026-08-15

---

## 1. Executive Summary

This is the last fire. Runs 1–2 already closed the exploitable design bugs (open translate CORS, `refresh` amplification, in-RAM article bodies, fail-open cron, redirect SSRF, 1-char catalog fan-out). This fire closed the **remaining WARNING residuals**: unsigned L2 envelopes, `/health` recon in production, unofficial-only Translate, and a hard-coded `trust proxy`.

`npm test`: **53/53**. Scheduler `01a0027b3049` is deleted after this report.

**Verdict:** no remaining critical issues. Leftovers are accepted product constraints (CSP `unsafe-inline` for generated cards, `img-src https:` for RSS thumbs, per-isolate rate limits without Redis).

---

## 2. Critical Issues (Security / Performance)

### 2.1 A08 Integrity — unsigned L2 envelopes — FIXED this fire

A writer with Redis/KV access could inject `{ v:1, value: poisonedArticles }`. Hydration trusted any well-shaped envelope.

**Change:** HMAC-SHA256 over `prefix + key + {v,expires,staleUntil,value}` using `CACHE_HMAC_SECRET` → `CRON_SECRET` → process-local key. Tampered or unsigned envelopes are a miss. Shared L2 across isolates requires a shared secret (already required for cron in production).

### 2.2 A01 / A05 — `/health` recon — FIXED this fire

Cache sizes + L2 backend name were public. Tests still need them.

**Change:** full `cache` / `store` / `metrics` only when `NODE_ENV !== 'production'`. Production returns `{ status, uptime }` with `Cache-Control: no-store`.

### 2.3 A04 / A06 — unofficial `gtx` only — FIXED this fire (conditional)

**Change:** if `GOOGLE_TRANSLATE_API_KEY` is set, POST to Cloud Translation v2. Unofficial `gtx` remains the hobby fallback, still origin-gated and 20/min.

### 2.4 A05 — `trust proxy = 1` — FIXED this fire

**Change:** `TRUST_PROXY` env (`0`/`false` disables; default `1`).

### 2.5 A09 — no 429 / upstream counters — FIXED this fire (non-prod)

In-process `metrics.{rateLimited,upstreamFail,translateFail}` increment on those paths and appear on non-production `/health`.

### 2.6 Previously FIXED (do not regress)

| Finding | State |
|---------|--------|
| Translate proxy + CORS `*` | FIXED |
| Missing-Origin translate | FIXED |
| `refresh=true` origin flood | FIXED |
| Article / search L2 | FIXED |
| Cron fail-open / timing | FIXED |
| Circuit 5xx/timeout | FIXED |
| CNN HTTP / `node-fetch` | FIXED |
| timeMeta XSS / XML entities | FIXED |
| Redirect SSRF + IPv6 private | FIXED |
| 1-char catalog fan-out | FIXED |

### 2.7 Accepted residuals (not actionable without a product change)

- CSP `style-src 'unsafe-inline'` — generated card markup uses inline styles.
- `img-src https:` — RSS thumbnails are arbitrary HTTPS CDNs.
- Rate limits are per isolate — shared Redis limiter is out of scope for this monolith pass.

### 2.8 OWASP Top 10 (final)

| # | Theme | Status |
|---|--------|--------|
| A01 | Broken Access Control | Cron fail-closed; health slimmed in prod |
| A02 | Cryptographic Failures | `timingSafeEqual`; HMAC L2; HTTPS feeds |
| A03 | Injection | Entity XML rejected; time attrs escaped |
| A04 | Insecure Design | Refresh/translate budgets; official Translate optional |
| A05 | Security Misconfiguration | CORS locked; HSTS; configurable trust proxy |
| A06 | Vulnerable Components | `node-fetch` gone; Express 4.22.2 |
| A07 | Auth Failures | Cron Bearer + header, constant-time |
| A08 | Integrity Failures | L2 envelopes HMAC-signed |
| A09 | Logging / Monitoring | Request IDs + in-process counters |
| A10 | SSRF | Manual redirects + private-host deny |

---

## 3. Code Quality

- Still the required modular monolith (`RSSService` / `SearchService` / `TranslationService` / `LayeredCache`).
- HMAC helpers are shared (`signCacheEnvelope` / `isSignedCacheEnvelope`); `_hydrate` is the single verification point.
- Tests: tampered L2 miss; production health omits recon.

---

## 4. Refactored examples (this fire)

### Signed L2 envelope

```javascript
function envelopeMac(prefix, key, envelope) {
  const payload = JSON.stringify({
    v: envelope.v,
    expires: envelope.expires,
    staleUntil: envelope.staleUntil,
    value: envelope.value,
  });
  return crypto.createHmac('sha256', cacheMacSecret())
    .update(`${prefix}\n${key}\n`).update(payload).digest('hex');
}

_hydrate(key, envelope) {
  if (!isSignedCacheEnvelope(this.prefix, key, envelope)) return false;
  // ... TTL checks, then l1.setEntry
}
```

### Production-safe health

```javascript
app.get('/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const payload = { status: 'ok', uptime: process.uptime() };
  if (process.env.NODE_ENV !== 'production') {
    payload.cache = { rss: rssCache.size, translation: translationCache.size, search: searchService.searchCache.size };
    payload.store = { l2: sharedStore?.name || 'none' };
    payload.metrics = { ...metrics };
  }
  res.json(payload);
});
```

---

## Review metadata

- **Run:** 3 of 3 — **stopping**  
- **Tests:** `npm test` — 53 passed, 0 failed (~3.5s)  
- **Scheduler:** `01a0027b3049` deleted  
