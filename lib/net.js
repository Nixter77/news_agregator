const { CONFIG } = require('./config');

let fetchImpl = globalThis.fetch.bind(globalThis);

function setFetchImpl(fn) {
  fetchImpl = typeof fn === 'function' ? fn : globalThis.fetch.bind(globalThis);
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

function isPrivateOrLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  const bare = host.replace(/^\[|\]$/g, '');
  if (bare === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  if (
    bare === 'metadata.google.internal' ||
    bare === '127.0.0.1' ||
    bare === '0.0.0.0' ||
    bare === '::1' ||
    bare === '0:0:0:0:0:0:0:1' ||
    bare === '::'
  ) {
    return true;
  }
  if (bare === '169.254.169.254' || bare.startsWith('169.254.')) return true;
  if (bare.includes(':')) {
    if (bare.startsWith('fe80:') || bare.startsWith('fc') || bare.startsWith('fd')) return true;
    const mapped = bare.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    if (mapped) return isPrivateOrLocalHost(mapped[1]);
  }
  const ipv4 = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return true;
  }
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

function isTrustedBrowserOrigin(req) {
  const origin = String(req.headers.origin || '');
  const referer = String(req.headers.referer || '');
  const allowed = CONFIG.ALLOWED_ORIGIN;
  const host = String(req.headers.host || '');

  if (allowed && allowed !== '*' && allowed !== 'same-origin') {
    if (origin) return origin === allowed;
    const allowedHost = hostFromAbsoluteUrl(allowed);
    if (referer && allowedHost) return hostFromAbsoluteUrl(referer) === allowedHost;
    return process.env.NODE_ENV === 'test';
  }

  if (origin) {
    return hostFromAbsoluteUrl(origin) === host;
  }
  if (referer) {
    return hostFromAbsoluteUrl(referer) === host;
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
  statusFromError,
  httpError,
  assertXmlLike,
  isPrivateOrLocalHost,
  assertSafeDestination,
  hostFromAbsoluteUrl,
  isTrustedBrowserOrigin,
  readLimitedText,
  fetchWithRetry,
};
