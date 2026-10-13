import { KNOWN_CATEGORIES } from './constants.js';

const relativeTimeFormatter = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' });
const absoluteTimeFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
});

export const savedSearchTimeFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export function sanitizeString(str) {
  return typeof str === 'string' ? str : '';
}

export function parseBooleanParam(value, defaultValue = false) {
  if (value === null || value === undefined) return defaultValue;
  return ['1', 'true', 'on', 'yes'].includes(String(value).toLowerCase());
}

export function safeExternalUrl(candidate, fallback = '') {
  const value = sanitizeString(candidate).trim();
  if (!value || value === '#') return fallback;
  const scheme = value.slice(0, 16).toLowerCase();
  if (scheme.startsWith('javascript:') || scheme.startsWith('data:') || scheme.startsWith('vbscript:')) return fallback;

  try {
    const normalized = value.startsWith('//') ? `https:${value}` : value;
    const parsed = new URL(normalized);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch {
    return fallback;
  }

  return fallback;
}

export function isEditableTarget(target) {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

export function escapeHtml(str) {
  return sanitizeString(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function isDisplayableSnippet(text) {
  const value = sanitizeString(text).replace(/\s+/g, ' ').trim();
  if (!value) return false;
  if (/^\(\s*(no title|no description|нет описания|нет заголовка)\s*\)$/i.test(value)) return false;
  if (/^submitted by\b/i.test(value)) return false;
  if (/^\/u\/\S+/i.test(value)) return false;
  return true;
}

export function splitIntoTokens(query) {
  return sanitizeString(query)
    .toLowerCase()
    .split(/[\s,.;:!?"'()\[\]{}<>/@#%^&*+=|~`]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2);
}

export function highlightRegexes(query) {
  return splitIntoTokens(query).map((token) => ({
    token,
    re: new RegExp(`(${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'),
  }));
}

export function highlightHtml(text, regexes) {
  // Match on the raw text and escape each piece afterwards, so a token such
  // as "amp" can never land inside an entity like &amp; and break it.
  const raw = sanitizeString(text);
  if (!raw || !regexes?.length) return escapeHtml(raw);
  const marks = new Array(raw.length).fill(false);
  for (const { re } of regexes) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m;
    while ((m = global.exec(raw)) !== null) {
      if (m[0] === '') { global.lastIndex += 1; continue; }
      for (let i = m.index; i < m.index + m[0].length; i += 1) marks[i] = true;
    }
  }
  let out = '';
  let i = 0;
  while (i < raw.length) {
    let j = i;
    while (j < raw.length && marks[j] === marks[i]) j += 1;
    const piece = escapeHtml(raw.slice(i, j));
    out += marks[i] ? `<mark class="news-highlight">${piece}</mark>` : piece;
    i = j;
  }
  return out;
}

export function displayFields(article, translate) {
  const rawTitle = translate
    ? sanitizeString(article.title_ru || article.title)
    : sanitizeString(article.title);
  const rawSnippet = translate
    ? sanitizeString(article.snippet_ru || article.snippet)
    : sanitizeString(article.snippet);
  const title = isDisplayableSnippet(rawTitle) ? rawTitle : sanitizeString(article.title);
  const snippet = isDisplayableSnippet(rawSnippet) ? rawSnippet : '';
  const isTranslated = Boolean(translate && (
    (article.title_ru && article.title_ru === title) ||
    (article.snippet_ru && article.snippet_ru === snippet)
  ));
  return { title, snippet, isTranslated };
}

export function getReadingTime(text, isRussian = false) {
  const words = text ? text.split(/\s+/).length : 0;
  const wpm = isRussian ? 160 : 220;
  return Math.ceil(words / wpm) || 1;
}

export function computeTimeMeta(isoString) {
  const parsed = isoString ? new Date(isoString) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    return { relative: 'Дата не указана', absolute: '' };
  }

  const diffMs = parsed.getTime() - Date.now();
  const diffMinutes = Math.round(diffMs / 60000);
  let relative;

  if (Math.abs(diffMinutes) < 60) {
    relative = relativeTimeFormatter.format(diffMinutes, 'minute');
  } else {
    const diffHours = Math.round(diffMinutes / 60);
    if (Math.abs(diffHours) < 24) {
      relative = relativeTimeFormatter.format(diffHours, 'hour');
    } else {
      const diffDays = Math.round(diffHours / 24);
      relative = relativeTimeFormatter.format(diffDays, 'day');
    }
  }

  return { relative, absolute: absoluteTimeFormatter.format(parsed) };
}

export function articleKey(article) {
  const source = sanitizeString(article?.source).trim();
  const link = safeExternalUrl(article?.link, '').trim();
  const id = sanitizeString(article?.id).trim();
  const publishedAt = sanitizeString(article?.publishedAt).trim();
  const title = sanitizeString(article?.title || article?.title_ru).trim();

  if (id) return `${source}:${id}`;
  if (link) return `${source}|${link}`;
  return `${source}|${title}|${publishedAt}`;
}

export function normalizeSavedSearchState(state) {
  const category = sanitizeString(state?.category).trim() || 'all';
  return {
    query: sanitizeString(state?.query).trim(),
    source: sanitizeString(state?.source).trim(),
    translate: Boolean(state?.translate),
    viewAll: Boolean(state?.viewAll),
    allSources: Boolean(state?.allSources),
    category: KNOWN_CATEGORIES.has(category) ? category : 'all',
  };
}

export function hasSavableSearchState(state) {
  return Boolean(
    state.query
    || state.source
    || !state.translate
    || state.viewAll
    || state.allSources
    || (state.category && state.category !== 'all')
  );
}

export function sameSavedSearch(left, right) {
  return left.query === right.query
    && left.source === right.source
    && left.translate === right.translate
    && left.viewAll === right.viewAll
    && left.allSources === right.allSources
    && left.category === right.category;
}

export function normalizeFavoriteArticle(article) {
  return {
    key: articleKey(article),
    id: sanitizeString(article?.id).trim(),
    title: sanitizeString(article?.title).trim(),
    titleRu: sanitizeString(article?.titleRu || article?.title_ru).trim(),
    snippet: sanitizeString(article?.snippet).trim(),
    snippetRu: sanitizeString(article?.snippetRu || article?.snippet_ru).trim(),
    link: safeExternalUrl(article?.link, ''),
    imageUrl: safeExternalUrl(article?.imageUrl, ''),
    source: sanitizeString(article?.source).trim(),
    sourceTitle: sanitizeString(article?.sourceTitle || article?.source).trim(),
    publishedAt: sanitizeString(article?.publishedAt).trim(),
    fullText: sanitizeString(article?.fullText).trim(),
    savedAt: sanitizeString(article?.savedAt).trim() || new Date().toISOString(),
  };
}
