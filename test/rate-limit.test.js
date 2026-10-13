const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RateLimiter, clientKey } = require('../lib/rate-limit');
const { CONFIG } = require('../lib/config');

test('stricter default limits', () => {
  assert.ok(CONFIG.RATE_LIMIT.TRANSLATE_MAX <= 10);
  assert.ok(CONFIG.RATE_LIMIT.REFRESH_MAX <= 3);
  assert.ok(CONFIG.RATE_LIMIT.MAX_REQUESTS <= 40);
  assert.ok(CONFIG.RATE_LIMIT.LONG_TRANSLATE_MAX > 0);
});

test('short window limits and reports remaining Retry-After', () => {
  const rl = new RateLimiter(60000, 2);
  try {
    assert.equal(rl.consume('a').limited, false);
    assert.equal(rl.consume('a').limited, false);
    const third = rl.consume('a');
    assert.equal(third.limited, true);
    assert.ok(third.retryAfterSec >= 1 && third.retryAfterSec <= 60);
    assert.equal(rl.consume('b').limited, false);
  } finally { rl.destroy(); }
});

test('long window caps sustained traffic across short windows', () => {
  const rl = new RateLimiter(1000, 100, { longWindowMs: 3600000, longMax: 3 });
  try {
    for (let i = 0; i < 3; i += 1) assert.equal(rl.consume('x').limited, false);
    const rec = rl.hits.get('x');
    rec.windowStart -= 2000; // short window rolled over
    const r = rl.consume('x');
    assert.equal(r.limited, true);
    assert.ok(r.retryAfterSec > 1000);
  } finally { rl.destroy(); }
});

test('key table is bounded', () => {
  const rl = new RateLimiter(60000, 5, { maxKeys: 50 });
  try {
    for (let i = 0; i < 500; i += 1) rl.consume(`ip${i}`);
    assert.ok(rl.hits.size <= 50);
  } finally { rl.destroy(); }
});

test('client key uses x-vercel-forwarded-for on Vercel and buckets IPv6 by /64', () => {
  const saved = process.env.VERCEL;
  process.env.VERCEL = '1';
  try {
    assert.equal(clientKey({ ip: '10.0.0.1', headers: { 'x-vercel-forwarded-for': '203.0.113.5, 10.0.0.1' } }), '203.0.113.5');
    assert.equal(
      clientKey({ ip: '1.1.1.1', headers: { 'x-vercel-forwarded-for': '2001:db8:1:2:aaaa::1' } }),
      clientKey({ ip: '1.1.1.1', headers: { 'x-vercel-forwarded-for': '2001:db8:1:2:bbbb::9' } }),
    );
  } finally {
    if (saved === undefined) delete process.env.VERCEL; else process.env.VERCEL = saved;
  }
  assert.equal(clientKey({ ip: '::ffff:192.0.2.1', headers: {} }), '192.0.2.1');
});
