const crypto = require('crypto');
const { CONFIG } = require('./config');
const { safeEqual } = require('./secret');
const { withTimeout } = require('./async');

function resolveCacheMacSecret() {
  return process.env.CACHE_HMAC_SECRET || process.env.CRON_SECRET || '';
}

let ephemeralCacheMacSecret = '';
function cacheMacSecret() {
  const fromEnv = resolveCacheMacSecret();
  if (fromEnv) return fromEnv;
  if (!ephemeralCacheMacSecret) {
    ephemeralCacheMacSecret = crypto.randomBytes(32).toString('hex');
  }
  return ephemeralCacheMacSecret;
}

function envelopeMac(prefix, key, envelope) {
  const payload = JSON.stringify({
    v: envelope.v,
    expires: envelope.expires,
    staleUntil: envelope.staleUntil,
    value: envelope.value,
  });
  return crypto
    .createHmac('sha256', cacheMacSecret())
    .update(String(prefix))
    .update('\n')
    .update(String(key))
    .update('\n')
    .update(payload)
    .digest('hex');
}

function signCacheEnvelope(prefix, key, envelope) {
  return { ...envelope, mac: envelopeMac(prefix, key, envelope) };
}

function isSignedCacheEnvelope(prefix, key, envelope) {
  if (!envelope || envelope.v !== 1 || typeof envelope.mac !== 'string') return false;
  return safeEqual(envelope.mac, envelopeMac(prefix, key, envelope));
}

class LRUCache {
  constructor(limit, ttlFn = null) {
    this.limit = limit;
    this.ttlFn = ttlFn;
    this.cache = new Map();
    this._pruneInterval = setInterval(() => this.pruneExpired(), 5 * 60 * 1000).unref();
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    const item = this.cache.get(key);
    const now = Date.now();

    const cutoff = item.staleUntil || item.expires;
    if (cutoff && cutoff < now) {
      this.cache.delete(key);
      return null;
    }

    this.cache.delete(key);
    this.cache.set(key, item);
    return item.value;
  }

  /**
   * @returns {{ status: 'fresh'|'stale'|'miss', value: any }}
   */
  getSWR(key) {
    if (!this.cache.has(key)) return { status: 'miss', value: null };
    const item = this.cache.get(key);
    const now = Date.now();

    if (item.expires && item.expires > now) {
      this.cache.delete(key);
      this.cache.set(key, item);
      return { status: 'fresh', value: item.value };
    }

    if (item.staleUntil && item.staleUntil > now) {
      this.cache.delete(key);
      this.cache.set(key, item);
      return { status: 'stale', value: item.value };
    }

    this.cache.delete(key);
    return { status: 'miss', value: null };
  }

  /** Peek without promoting or expiring (for last-known-good after a failed refresh). */
  peek(key) {
    const item = this.cache.get(key);
    return item ? item.value : null;
  }

  _put(key, entry) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.limit) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, entry);
    return entry;
  }

  set(key, value, ttl = 0, staleWindowMs = 0) {
    const now = Date.now();
    const expires = ttl > 0 ? now + ttl : this.ttlFn ? now + this.ttlFn() : 0;
    const staleUntil = expires > 0 && staleWindowMs > 0 ? expires + staleWindowMs : 0;
    return this._put(key, { value, expires, staleUntil });
  }

  setEntry(key, { value, expires = 0, staleUntil = 0 }) {
    return this._put(key, { value, expires, staleUntil });
  }

  delete(key) {
    this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }

  pruneExpired() {
    const now = Date.now();
    for (const [key, item] of this.cache.entries()) {
      const cutoff = item.staleUntil || item.expires;
      if (cutoff && cutoff < now) {
        this.cache.delete(key);
      }
    }
  }

  destroy() {
    clearInterval(this._pruneInterval);
  }
}

const storeFetch = globalThis.fetch.bind(globalThis);

class MemorySharedStore {
  constructor() {
    this.name = 'memory';
    this.map = new Map();
  }

  async get(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  async set(key, value) {
    this.map.set(key, value);
  }
}

class UpstashRestStore {
  constructor({ url, token }) {
    this.name = 'upstash';
    this.url = String(url || '').replace(/\/$/, '');
    this.token = token;
  }

  async _command(args, timeoutMs) {
    const response = await storeFetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`upstash ${response.status}`);
    return response.json();
  }

  async get(key) {
    const data = await this._command(['GET', key], CONFIG.CACHE.L2_GET_MS);
    if (data?.result == null) return null;
    try {
      return typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
    } catch {
      return null;
    }
  }

  async set(key, value, ttlSeconds = 0) {
    const args = ['SET', key, JSON.stringify(value)];
    if (ttlSeconds > 0) args.push('EX', String(Math.ceil(ttlSeconds)));
    await this._command(args, 1500);
  }
}

class VercelRuntimeStore {
  constructor(cache) {
    this.name = 'vercel-runtime';
    this.cache = cache;
  }

  async get(key) {
    const value = await this.cache.get(key);
    return value == null ? null : value;
  }

  async set(key, value, ttlSeconds = 60) {
    await this.cache.set(key, value, {
      ttl: Math.max(1, Math.ceil(ttlSeconds)),
      tags: ['news-agg'],
    });
  }
}

function createSharedStore() {
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (upstashUrl && upstashToken) {
    return new UpstashRestStore({ url: upstashUrl, token: upstashToken });
  }
  if (process.env.VERCEL) {
    try {
      const { getCache } = require('@vercel/functions');
      return new VercelRuntimeStore(getCache({ namespace: 'news-agg' }));
    } catch (err) {
      console.warn('[store] vercel runtime cache unavailable:', err.message);
    }
  }
  return null;
}

class LayeredCache {
  constructor(l1, l2, { prefix = 'c' } = {}) {
    this.l1 = l1;
    this.l2 = l2 || null;
    this.prefix = prefix;
  }

  _k(key) {
    const raw = `${this.prefix}:${key}`;
    if (raw.length <= 180) return raw;
    return `${this.prefix}:h:${crypto.createHash('sha1').update(String(key)).digest('hex')}`;
  }

  get(key) {
    return this.l1.get(key);
  }

  peek(key) {
    return this.l1.peek(key);
  }

  getSWR(key) {
    return this.l1.getSWR(key);
  }

  async _readL2(key) {
    if (!this.l2) return null;
    try {
      return await withTimeout(this.l2.get(this._k(key)), CONFIG.CACHE.L2_GET_MS, null);
    } catch (err) {
      console.warn('[store] l2 get failed:', err.message);
      return null;
    }
  }

  async _writeL2(key, envelope, ttlSeconds) {
    if (!this.l2) return;
    try {
      await this.l2.set(this._k(key), envelope, ttlSeconds);
    } catch (err) {
      console.warn('[store] l2 set failed:', err.message);
    }
  }

  _hydrate(key, envelope) {
    if (!isSignedCacheEnvelope(this.prefix, key, envelope)) {
      return false;
    }
    if (!Object.prototype.hasOwnProperty.call(envelope, 'value')) {
      return false;
    }
    const now = Date.now();
    const staleUntil = Number(envelope.staleUntil) || 0;
    const expires = Number(envelope.expires) || 0;
    if (staleUntil && staleUntil <= now && (!expires || expires <= now)) return false;
    this.l1.setEntry(key, { value: envelope.value, expires, staleUntil });
    return true;
  }

  async getAsync(key) {
    const local = this.l1.get(key);
    if (local != null) return local;
    const remote = await this._readL2(key);
    if (!this._hydrate(key, remote)) return null;
    return this.l1.get(key);
  }

  async getSWRAsync(key) {
    const local = this.l1.getSWR(key);
    if (local.status !== 'miss') return local;
    const remote = await this._readL2(key);
    if (!this._hydrate(key, remote)) return { status: 'miss', value: null };
    return this.l1.getSWR(key);
  }

  async peekAsync(key) {
    const local = this.l1.peek(key);
    if (local != null) return local;
    const remote = await this._readL2(key);
    if (!this._hydrate(key, remote)) return null;
    return this.l1.peek(key);
  }

  set(key, value, ttl = 0, staleWindowMs = 0) {
    const item = this.l1.set(key, value, ttl, staleWindowMs);
    if (!item || !this.l2) return Promise.resolve();
    const until = item.staleUntil || item.expires;
    const ttlSeconds = until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : 1;
    return this._writeL2(key, signCacheEnvelope(this.prefix, key, {
      v: 1,
      value,
      expires: item.expires,
      staleUntil: item.staleUntil,
    }), ttlSeconds);
  }

  delete(key) {
    this.l1.delete(key);
  }

  clear() {
    this.l1.clear();
  }

  get size() {
    return this.l1.size;
  }

  pruneExpired() {
    this.l1.pruneExpired();
  }

  destroy() {
    this.l1.destroy();
  }
}

module.exports = {
  LRUCache,
  MemorySharedStore,
  LayeredCache,
  createSharedStore,
  signCacheEnvelope,
  isSignedCacheEnvelope,
};
