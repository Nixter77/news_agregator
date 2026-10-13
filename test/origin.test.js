const { test } = require('node:test');
const assert = require('node:assert/strict');

const { CONFIG } = require('../lib/config');
const { isTrustedBrowserOrigin } = require('../lib/net');

const PROD = 'news-agregator-seven.vercel.app';
const req = (headers) => ({ headers });

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = k === 'ALLOWED_ORIGIN' ? CONFIG.ALLOWED_ORIGIN : process.env[k];
    if (k === 'ALLOWED_ORIGIN') CONFIG.ALLOWED_ORIGIN = v;
    else if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (k === 'ALLOWED_ORIGIN') CONFIG.ALLOWED_ORIGIN = v;
      else if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const onVercel = { VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: PROD, VERCEL_URL: 'news-agregator-abc123-nixter77s-projects.vercel.app', VERCEL_BRANCH_URL: undefined, ALLOWED_ORIGIN: '' };

test('on Vercel the production domain is trusted', () => {
  withEnv(onVercel, () => {
    assert.equal(isTrustedBrowserOrigin(req({ host: PROD, origin: `https://${PROD}` })), true);
    assert.equal(isTrustedBrowserOrigin(req({ host: PROD, referer: `https://${PROD}/?q=x` })), true);
  });
});

test('on Vercel forged Host / X-Forwarded-Host cannot make an origin trusted', () => {
  withEnv(onVercel, () => {
    assert.equal(isTrustedBrowserOrigin(req({ host: 'evil.com', origin: 'https://evil.com' })), false);
    assert.equal(isTrustedBrowserOrigin(req({ host: PROD, 'x-forwarded-host': 'evil.com', origin: 'https://evil.com' })), false);
    assert.equal(isTrustedBrowserOrigin(req({ host: 'evil.com', 'x-forwarded-host': 'evil.com', referer: 'https://evil.com/' })), false);
    assert.equal(isTrustedBrowserOrigin(req({ host: PROD, origin: 'null' })), false);
  });
});

test('ALLOWED_ORIGIN list is honoured on Vercel', () => {
  withEnv({ ...onVercel, ALLOWED_ORIGIN: 'https://a.example, https://b.example/' }, () => {
    assert.equal(isTrustedBrowserOrigin(req({ host: PROD, origin: 'https://b.example' })), true);
    assert.equal(isTrustedBrowserOrigin(req({ host: PROD, origin: 'https://c.example' })), false);
  });
});

test('local runs (no VERCEL env) trust the same Host only', () => {
  withEnv({ VERCEL: undefined, VERCEL_PROJECT_PRODUCTION_URL: undefined, VERCEL_URL: undefined, VERCEL_BRANCH_URL: undefined, ALLOWED_ORIGIN: '' }, () => {
    assert.equal(isTrustedBrowserOrigin(req({ host: 'localhost:3000', origin: 'http://localhost:3000' })), true);
    assert.equal(isTrustedBrowserOrigin(req({ host: 'localhost:3000', 'x-forwarded-host': 'evil.com', origin: 'https://evil.com' })), false);
  });
});

test('public prod domain is trusted even if Vercel reports another production alias', () => {
  withEnv({ ...onVercel, VERCEL_PROJECT_PRODUCTION_URL: 'news-agregator-nixter77s-projects.vercel.app' }, () => {
    assert.equal(isTrustedBrowserOrigin(req({ host: PROD, origin: `https://${PROD}` })), true);
  });
});
