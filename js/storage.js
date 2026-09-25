import { LIMITS } from './constants.js';
import { sanitizeString } from './text.js';

export function safeStorageGet(key, fallback = null) {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function safeStorageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.warn('localStorage write failed', error);
    return false;
  }
}

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readJsonList(key) {
  const store = storage();
  if (!store) return [];

  const raw = store.getItem(key);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn('Failed to read JSON storage entry', error);
    return [];
  }
}

export function writeJsonList(key, value) {
  const store = storage();
  if (!store) return false;

  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.warn('Failed to write JSON storage entry', error);
    return false;
  }
}

export function generateId(prefix = 'item') {
  if (window.crypto?.randomUUID) {
    return `${prefix}-${window.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** @returns {'skip'|'ok'|'fail'} */
export function rememberQuery(storageKey, query) {
  const safe = typeof query === 'string' ? query.trim() : '';
  if (safe.length < 2) return 'skip';

  const key = safe.toLowerCase();
  const history = readJsonList(storageKey);
  const existing = history.find((item) => item.query.toLowerCase() === key);

  if (existing) {
    existing.count = (existing.count || 1) + 1;
    existing.lastSearched = new Date().toISOString();
    existing.query = safe;
  } else {
    history.push({
      query: safe,
      count: 1,
      lastSearched: new Date().toISOString(),
    });
  }

  history.sort((a, b) => new Date(b.lastSearched).getTime() - new Date(a.lastSearched).getTime());
  const saved = writeJsonList(storageKey, history.slice(0, LIMITS.searchHistory));
  return saved ? 'ok' : 'fail';
}

export function topQueries(storageKey, limit = 3) {
  return readJsonList(storageKey)
    .sort((a, b) => (b.count - a.count) || (new Date(b.lastSearched).getTime() - new Date(a.lastSearched).getTime()))
    .slice(0, limit)
    .map((item) => item.query);
}

export function createFullTextStore(limit = LIMITS.fullText) {
  const fullTextStore = new Map();

  function setRaw(key, value) {
    if (!key || !value) return;
    if (fullTextStore.has(key)) fullTextStore.delete(key);
    fullTextStore.set(key, value);
    while (fullTextStore.size > limit) {
      const oldest = fullTextStore.keys().next().value;
      fullTextStore.delete(oldest);
    }
  }

  function get(key) {
    const value = fullTextStore.get(key);
    if (!value) return { original: '', ru: '' };
    if (typeof value === 'string') return { original: value, ru: '' };
    return {
      original: sanitizeString(value.original),
      ru: sanitizeString(value.ru),
    };
  }

  function store(key, { original, ru } = {}) {
    if (!key) return;
    const prev = get(key);
    const next = {
      original: original != null && original !== '' ? original : prev.original,
      ru: ru != null && ru !== '' ? ru : prev.ru,
    };
    if (!next.original && !next.ru) return;
    setRaw(key, next);
  }

  return { get, store };
}
