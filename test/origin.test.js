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

test('prod domain same-origin request is trusted with ALLOWED_ORIGIN empty', () => {
  withEnv({ ALLOWED_ORIGIN: '' }, () => {
    assert.equal(isTrustedBrowserOrigin(req({ host: PROD, origin: `https://${PROD}` })), true);
    assert.equal(isTrustedBrowserOrigin(req({ host: PROD, referer: `https://${PROD}/?q=x` })), true);
  });
});

test('prod domain stays trusted even if ALLOWED_ORIGIN names another domain', () => {
  withEnv({ ALLOWED_ORIGIN: 'https://other.example.com' }, () => {
    assert.equal(isTrustedBrowserOrigin(req({ host: PROD, origin: `https://${PROD}` })), true);
    assert.equal(isTrustedBrowserOrigin(req({ host: PROD, origin: 'https://other.example.com' })), true);
    assert.equal(isTrustedBrowserOrigin(req({ host: PROD, origin: 'https://evil.example' })), false);
  });
});

test('Vercel production URL and comma-separated ALLOWED_ORIGIN are trusted', () => {
  withEnv({ ALLOWED_ORIGIN: 'https://a.example, https://b.example/', VERCEL_PROJECT_PRODUCTION_URL: PROD }, () => {
    const host = 'news-agregator-git-main-nixter77s-projects.vercel.app';
    assert.equal(isTrustedBrowserOrigin(req({ host, origin: `https://${PROD}` })), true);
    assert.equal(isTrustedBrowserOrigin(req({ host, origin: 'https://b.example' })), true);
    assert.equal(isTrustedBrowserOrigin(req({ host, origin: 'null' })), false);
    assert.equal(isTrustedBrowserOrigin(req({ host, origin: 'https://evil.example' })), false);
  });
});
