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

  consume(ip = 'unknown') {
    const record = this.hits.get(ip) || { count: 0, windowStart: Date.now() };
    if (Date.now() - record.windowStart > this.windowMs) {
      record.count = 1;
      record.windowStart = Date.now();
    } else {
      record.count += 1;
    }
    this.hits.set(ip, record);
    return {
      limited: record.count > this.max,
      retryAfterSec: Math.ceil(this.windowMs / 1000),
    };
  }

  middleware() {
    return (req, res, next) => {
      const { limited, retryAfterSec } = this.consume(req.ip || 'unknown');
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

module.exports = { RateLimiter, authorizeCron };
