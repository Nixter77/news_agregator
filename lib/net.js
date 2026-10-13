const dns = require('dns');
const ipaddr = require('ipaddr.js');
const { Agent, fetch: undiciFetch } = require('undici');
const net = require('net');
const { CONFIG } = require('./config');

let dnsLookupImpl = null;

/** Override DNS resolution (tests). Resolver: async (hostname) => [{address, family}]. null restores the default. */
function setDnsLookup(fn) {
  dnsLookupImpl = typeof fn === 'function' ? fn : null;
}

function defaultResolve(hostname) {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

/** The DNS check may only be skipped for offline unit tests, never on Vercel. */
function dnsCheckBypassed() {
  return !dnsLookupImpl && process.env.NODE_ENV === 'test' && !process.env.VERCEL;
}

/** Resolve and return only validated addresses; throws if any is non-unicast. */
async function resolveSafeAddresses(hostname) {
  const bare = String(hostname).replace(/^\[|\]$/g, '');
  if (net.isIP(bare)) {
    if (isBlockedIp(bare)) throw httpError('Blocked fetch destination', 403);
    return [{ address: bare, family: net.isIP(bare) }];
  }
  let addrs;
  try {
    addrs = await (dnsLookupImpl || defaultResolve)(bare);
  } catch {
    throw httpError('DNS lookup failed', 502);
  }
  const list = (Array.isArray(addrs) ? addrs : [addrs])
    .map((a) => (typeof a === 'string' ? { address: a, family: net.isIP(a) } : a))
    .filter((a) => a && a.address);
  if (!list.length || list.some((a) => isBlockedIp(a.address))) {
    throw httpError('Blocked fetch destination', 403);
  }
  return list.map((a) => ({ address: a.address, family: a.family || net.isIP(a.address) }));
}

/**
 * Early check: refuse if the hostname resolves to anything non-unicast.
 */
async function assertSafeResolution(urlString) {
  if (dnsCheckBypassed()) return;
  await resolveSafeAddresses(new URL(urlString).hostname);
}

/**
 * dns.lookup-compatible function for undici's connect.lookup: the socket is
 * opened to an address validated here, so DNS rebinding between the check
 * and the connect cannot reach an internal IP.
 */
function pinnedLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  resolveSafeAddresses(hostname).then((list) => {
    const wanted = options && options.family ? list.filter((a) => a.family === options.family) : list;
    const pool = wanted.length ? wanted : list;
    if (options && options.all) return callback(null, pool);
    return callback(null, pool[0].address, pool[0].family);
  }, (err) => callback(err));
}

const pinnedAgent = new Agent({ connect: { lookup: pinnedLookup } });
const defaultFetch = (url, init = {}) => undiciFetch(url, { ...init, dispatcher: pinnedAgent });

let fetchImpl = defaultFetch;

function setFetchImpl(fn) {
  fetchImpl = typeof fn === 'function' ? fn : defaultFetch;
}

const DEFAULT_FETCH_HEADERS = {
  'User-Agent': CONFIG.FETCH.USER_AGENT,
  Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
};

function statusFromError(error) {
  if (Number.isInteger(error?.status)) return error.status;
  const match = String(error?.message || '').match(/Status (\d{3})/);
  return match ? Number(match[1]) : 0;
}

function httpError(message, status = 0) {
  return Object.assign(new Error(message), { status });
}

function assertXmlLike(contentType, body) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('text/html') && !ct.includes('xml')) {
    throw httpError('Non-XML response', 415);
  }
  const raw = String(body || '');
  const head = raw.slice(0, 240).trim();
  if (/^<!doctype html/i.test(head) || /^<html[\s>]/i.test(head)) {
    throw httpError('Non-XML response', 415);
  }
  if (/<!ENTITY/i.test(raw.slice(0, 8000))) {
    throw httpError('XML entities not allowed', 415);
  }
}

/**
 * An IP is allowed only if ipaddr.js classifies it as plain 'unicast'
 * (IPv4-mapped IPv6 is unwrapped first). IPv6 must additionally be global
 * unicast 2000::/3, which also rules out IPv4-compatible ::a.b.c.d (::/96)
 * that ipaddr.js still reports as unicast.
 */
function isBlockedIp(address) {
  let parsed;
  try {
    parsed = ipaddr.parse(String(address).replace(/^\[|\]$/g, '').split('%')[0]);
  } catch {
    return true;
  }
  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address();
  if (parsed.range() !== 'unicast') return true;
  if (parsed.kind() === 'ipv6' && (parsed.parts[0] & 0xe000) !== 0x2000) return true;
  return false;
}

function isPrivateOrLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  const bare = host.replace(/^\[|\]$/g, '');
  if (net.isIP(bare.split('%')[0])) return isBlockedIp(bare);
  if (bare === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  // Non-canonical numeric hosts (e.g. 0x7f.1) are normalised by URL, but
  // anything that still looks numeric and is not a valid IP is refused.
  if (/^[0-9.]+$/.test(bare) || /^0x/i.test(bare)) return true;
  return false;
}

function assertSafeDestination(finalUrl) {
  let dest;
  try {
    dest = new URL(finalUrl);
  } catch {
    throw httpError('Invalid fetch destination', 403);
  }
  if (dest.protocol !== 'http:' && dest.protocol !== 'https:') {
    throw httpError('Invalid fetch destination', 403);
  }
  if (isPrivateOrLocalHost(dest.hostname)) {
    throw httpError('Blocked fetch destination', 403);
  }
}

function hostFromAbsoluteUrl(value) {
  try {
    return value ? new URL(value).host : '';
  } catch {
    return '';
  }
}

const KNOWN_PRODUCTION_HOSTS = ['news-agregator-seven.vercel.app'];

function allowedOriginList() {
  return String(CONFIG.ALLOWED_ORIGIN || process.env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((v) => v.trim().replace(/\/$/, ''))
    .filter((v) => v && v !== '*' && v !== 'same-origin');
}

/**
 * Hosts a browser request may come from. Request headers (Host,
 * X-Forwarded-Host) are attacker-controlled, so on Vercel only the
 * platform-provided deployment URLs and ALLOWED_ORIGIN are trusted.
 * The Host header is used only for local runs (no VERCEL env).
 */
function trustedHosts(req) {
  const hosts = new Set();
  const add = (h) => { if (h) hosts.add(String(h).toLowerCase()); };
  // VERCEL_PROJECT_PRODUCTION_URL is Vercel's *shortest* production domain,
  // which may be another alias, so the public domain is pinned as well.
  for (const h of KNOWN_PRODUCTION_HOSTS) add(h);
  add(process.env.VERCEL_PROJECT_PRODUCTION_URL);
  add(process.env.VERCEL_URL);
  add(process.env.VERCEL_BRANCH_URL);
  for (const origin of allowedOriginList()) add(hostFromAbsoluteUrl(origin) || origin);
  if (!process.env.VERCEL) add(req.headers.host);
  return hosts;
}

function isTrustedBrowserOrigin(req) {
  const origin = String(req.headers.origin || '');
  const referer = String(req.headers.referer || '');
  const hosts = trustedHosts(req);

  if (origin) {
    if (origin === 'null') return false;
    return hosts.has(hostFromAbsoluteUrl(origin).toLowerCase());
  }
  if (referer) {
    return hosts.has(hostFromAbsoluteUrl(referer).toLowerCase());
  }
  return process.env.NODE_ENV === 'test';
}

async function readLimitedText(response, maxBytes = CONFIG.FETCH.MAX_BODY_BYTES) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw httpError('Response too large', 413);

  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw httpError('Response too large', 413);
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw httpError('Response too large', 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

async function fetchFollowingRedirects(url, { signal, headers, method, body } = {}) {
  let current = String(url);
  assertSafeDestination(current);
  const maxHops = CONFIG.FETCH.MAX_REDIRECTS || 5;
  const verb = String(method || 'GET').toUpperCase();
  const followBody = verb === 'GET' || verb === 'HEAD';

  for (let hop = 0; hop < maxHops; hop += 1) {
    await assertSafeResolution(current);
    const response = await fetchImpl(current, {
      signal,
      headers,
      method: verb,
      body: hop === 0 ? body : undefined,
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      if (!followBody) throw httpError(`Status ${response.status}`, response.status);
      const loc = response.headers.get('location');
      if (!loc) throw httpError(`Status ${response.status}`, response.status);
      let next;
      try {
        next = new URL(loc, current).href;
      } catch {
        throw httpError('Invalid redirect', 403);
      }
      assertSafeDestination(next);
      current = next;
      continue;
    }
    if (response.url) assertSafeDestination(response.url);
    return response;
  }
  throw httpError('Too many redirects', 403);
}

/**
 * `read` (optional) consumes the body while the abort timer is still armed,
 * so a slow or endless body cannot outlive `timeoutMs`.
 * `retryOn429: false` gives up immediately on 429 so callers can back off.
 */
async function fetchWithRetry(url, {
  attempts = CONFIG.FETCH.RETRIES,
  timeoutMs = CONFIG.FETCH.TIMEOUT,
  headers,
  method,
  body,
  read,
  retryOn429 = true,
} = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFollowingRedirects(url, {
        signal: controller.signal,
        headers: { ...DEFAULT_FETCH_HEADERS, ...(headers || {}) },
        method,
        body,
      });
      if (response.ok) return typeof read === 'function' ? await read(response) : response;

      const retryable = (response.status === 429 && retryOn429) || response.status >= 500;
      lastError = httpError(`Status ${response.status}`, response.status);
      if (response.status === 429) lastError.retryAfter = response.headers.get('retry-after');
      if (!retryable) throw lastError;
    } catch (error) {
      lastError = error;
      const status = statusFromError(error);
      const nonRetryableHttp = status >= 400 && status < 500 && (status !== 429 || !retryOn429);
      if (nonRetryableHttp) throw error;
      if (i < attempts - 1) {
        const delay = CONFIG.FETCH.RETRY_BASE_MS * 2 ** i + Math.random() * 100;
        await new Promise((r) => setTimeout(r, delay));
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw lastError;
}

module.exports = {
  setFetchImpl,
  setDnsLookup,
  assertSafeResolution,
  resolveSafeAddresses,
  pinnedLookup,
  isBlockedIp,
  statusFromError,
  httpError,
  assertXmlLike,
  isPrivateOrLocalHost,
  assertSafeDestination,
  hostFromAbsoluteUrl,
  isTrustedBrowserOrigin,
  allowedOriginList,
  readLimitedText,
  fetchWithRetry,
};
