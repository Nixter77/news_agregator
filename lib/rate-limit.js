const { safeEqual } = require('./secret');
const { recordMetric } = require('./metrics');

function authorizeCron(req) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) {
    return process.env.NODE_ENV === 'test';
  }
  const auth = String(req.headers.authorization || '');
  const header = String(req.headers['x-cron-secret'] || '');
  return safeEqual(auth, `Bearer ${secret}`) || safeEqual(header, secret);
}

/**
 * Rate-limit key for a request. On Vercel the edge sets x-vercel-forwarded-for
 * (clients cannot spoof it); elsewhere Express's req.ip (trust proxy) is used.
 * IPv6 clients are bucketed by /64 so address rotation inside one allocation
 * does not reset the counter.
 */
function clientKey(req) {
  let ip = '';
  if (process.env.VERCEL) ip = String(req.headers?.['x-vercel-forwarded-for'] || '').split(',')[0].trim();
  if (!ip) ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
  ip = ip.replace(/^::ffff:(?=\d+\.)/i, '');
  if (ip.includes(':')) {
    const groups = ip.split('::')[0].split(':').filter(Boolean).slice(0, 4);
    return `v6:${groups.join(':')}::/64`;
  }
  return ip;
}

/**
 * In-memory fixed-window limiter with an optional second, longer window.
 * Per-instance only (each Vercel function instance has its own memory), so
 * it is a best-effort brake, not a global quota.
 */
class RateLimiter {
  constructor(windowMs, max, { longWindowMs = 0, longMax = 0, maxKeys = 10000 } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.longWindowMs = longWindowMs;
    this.longMax = longMax;
    this.maxKeys = maxKeys;
    this.hits = new Map();
    this._pruneInterval = setInterval(() => this._prune(), this.windowMs).unref();
  }

  _prune() {
    const now = Date.now();
    const horizon = Math.max(this.windowMs, this.longWindowMs);
    for (const [key, record] of this.hits.entries()) {
      if (now - record.longStart > horizon && now - record.windowStart > this.windowMs) {
        this.hits.delete(key);
      }
    }
  }

  destroy() {
    clearInterval(this._pruneInterval);
  }

  consume(key = 'unknown') {
    const now = Date.now();
    let record = this.hits.get(key);
    if (!record) {
      if (this.hits.size >= this.maxKeys) {
        this._prune();
        // Still full: evict the oldest entry (Map keeps insertion order).
        if (this.hits.size >= this.maxKeys) this.hits.delete(this.hits.keys().next().value);
      }
      record = { count: 0, windowStart: now, longCount: 0, longStart: now };
    }
    if (now - record.windowStart >= this.windowMs) {
      record.count = 0;
      record.windowStart = now;
    }
    if (this.longWindowMs && now - record.longStart >= this.longWindowMs) {
      record.longCount = 0;
      record.longStart = now;
    }
    record.count += 1;
    record.longCount += 1;
    this.hits.set(key, record);

    if (this.longMax && record.longCount > this.longMax) {
      return { limited: true, retryAfterSec: Math.max(1, Math.ceil((record.longStart + this.longWindowMs - now) / 1000)) };
    }
    return {
      limited: record.count > this.max,
      retryAfterSec: Math.max(1, Math.ceil((record.windowStart + this.windowMs - now) / 1000)),
    };
  }

  middleware() {
    return (req, res, next) => {
      const { limited, retryAfterSec } = this.consume(clientKey(req));
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

module.exports = { RateLimiter, authorizeCron, clientKey };
