function normalizeLink(link) {
  return String(link || '')
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/\/$/, '');
}

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[\s,.;:!?"'()\[\]{}<>/@#%^&*+=|~`]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

const CYRILLIC_TO_LATIN = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function transliterateCyrillic(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[а-яё]/g, (ch) => (CYRILLIC_TO_LATIN[ch] != null ? CYRILLIC_TO_LATIN[ch] : ch));
}

function hasCyrillic(text) {
  return /[а-яё]/i.test(String(text || ''));
}

const QUERY_ALIASES = {
  израиль: ['israel', 'israeli'],
  украина: ['ukraine', 'ukrainian'],
  экономика: ['economy', 'economic'],
  технологии: ['technology', 'technologies', 'tech'],
  ии: ['ai', 'artificial'],
  наука: ['science', 'scientific'],
  спорт: ['sport', 'sports'],
  трамп: ['trump'],
};

function expandQueryTerms(normQuery, translatedQuery = '') {
  const translitQuery = hasCyrillic(normQuery) ? transliterateCyrillic(normQuery) : '';
  const aliases = QUERY_ALIASES[normQuery] || [];
  const uniqueTokens = [...new Set(
    tokenize(normQuery)
      .concat(tokenize(translatedQuery), tokenize(translitQuery), aliases.flatMap((alias) => tokenize(alias)))
  )];
  const needles = [...new Set(
    [normQuery, translitQuery, String(translatedQuery || '').toLowerCase(), ...aliases].filter(Boolean)
  )];
  return { translitQuery, uniqueTokens, needles };
}

function scoreArticle(article, tokens) {
  let score = 0;
  const title = String(article?.title || '').toLowerCase();
  const snippet = String(article?.snippet || '').toLowerCase();

  for (const token of tokens) {
    if (title.includes(token)) score += 5;
    else if (snippet.includes(token)) score += 2;
  }
  return score;
}

function dedupeArticles(articles) {
  const deduplicated = [];
  const seenLinks = new Set();
  const seenTitles = new Set();

  for (const article of articles) {
    const cleanLink = article.cleanLink || normalizeLink(article.link);
    const normTitle = article.normTitle || normalizeTitle(article.title);

    if ((cleanLink && seenLinks.has(cleanLink)) || (normTitle && seenTitles.has(normTitle))) {
      continue;
    }

    deduplicated.push(article);
    if (cleanLink) seenLinks.add(cleanLink);
    if (normTitle) seenTitles.add(normTitle);
  }
  return deduplicated;
}

function getText(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return getText(val[0]);
  if (typeof val === 'object') {
    if (val._) return getText(val._);
    if (val.$?.href) return val.$.href;
  }
  return '';
}

function stripHtml(str) {
  if (typeof str !== 'string' || !str) return '';
  return str.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

const PLACEHOLDER_TEXT_RE = /^\(\s*(no title|no description|нет описания|нет заголовка)\s*\)$/i;
const META_TITLE_RE =
  /(\blive\s+threads?\b|\bmegathread\b|\blooking for (new )?moderators?\b|\b(daily|weekly|monthly)\s+(discussion|thread|round.?up)\b|^\s*\[?\s*(meta|mod\s*posts?|announcement)\s*\]?)/i;

function collapseWs(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function isPlaceholderText(text) {
  const t = collapseWs(text);
  return !t || PLACEHOLDER_TEXT_RE.test(t);
}

function isJunkSnippet(text) {
  const t = collapseWs(text);
  if (!t || isPlaceholderText(t)) return true;
  if (/^submitted by\b/i.test(t)) return true;
  if (/^\/u\/\S+/i.test(t)) return true;
  if (/^\[(link|comments)\]/i.test(t)) return true;
  if (/^(comments?|view comments?)$/i.test(t)) return true;
  if (/submitted by/i.test(t) && /\[(link|comments)\]/i.test(t)) return true;
  return false;
}

function isMetaFeedItem(title) {
  const t = collapseWs(title);
  if (!t || isPlaceholderText(t)) return true;
  if (META_TITLE_RE.test(t)) return true;
  if (/^\/?r\/\S+/i.test(t) && /\b(live|thread|megathread|moderators?)\b/i.test(t)) return true;
  return false;
}

function isTranslatableText(text) {
  const t = collapseWs(text);
  if (t.length < 2) return false;
  if (isPlaceholderText(t) || isJunkSnippet(t)) return false;
  return true;
}

function extractImagesFromHtml(html) {
  const urls = [];
  const re = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
  let match;
  while ((match = re.exec(String(html || '')))) {
    const url = String(match[1] || '').replace(/&amp;/g, '&').trim();
    if (/^https?:\/\//i.test(url)) urls.push(url);
  }
  return urls;
}

function extractOutboundLink(html) {
  const labeled = String(html || '').match(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>\s*\[link\]\s*<\/a>/i);
  const href = labeled ? String(labeled[1] || '').replace(/&amp;/g, '&').trim() : '';
  if (!/^https?:\/\//i.test(href)) return '';
  if (/reddit\.com\/r\//i.test(href) && /\/comments\//i.test(href)) return '';
  return href;
}

function pickMediaUrl(node) {
  if (!node) return '';
  if (typeof node === 'string' && /^https?:\/\//i.test(node)) return node;
  if (Array.isArray(node)) return pickMediaUrl(node[0]);
  if (typeof node === 'object') {
    const url = node.url || node.href || node.$?.url || node.$?.href;
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url;
  }
  return '';
}

module.exports = {
  normalizeLink,
  normalizeTitle,
  tokenize,
  transliterateCyrillic,
  hasCyrillic,
  expandQueryTerms,
  scoreArticle,
  dedupeArticles,
  getText,
  stripHtml,
  collapseWs,
  isPlaceholderText,
  isJunkSnippet,
  isMetaFeedItem,
  isTranslatableText,
  extractImagesFromHtml,
  extractOutboundLink,
  pickMediaUrl,
};
