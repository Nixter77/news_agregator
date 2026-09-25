/**
 * Process config and the feed catalog. Loaded after dotenv so env wins.
 */

const CONFIG = {
  PORT: process.env.PORT || 3000,
  ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || '',
  CACHE: {
    RSS_TTL: 5 * 60 * 1000,
    RSS_STALE_WINDOW: 20 * 60 * 1000,
    TRANSLATION_TTL: 24 * 60 * 60 * 1000,
    SEARCH_TTL: 60 * 1000,
    SEARCH_EMPTY_TTL: 10 * 1000,
    RSS_LIMIT: 100,
    TRANSLATION_LIMIT: 2000,
    SEARCH_LIMIT: 200,
    L2_GET_MS: 250,
  },
  FETCH: {
    TIMEOUT: 8000,
    RETRIES: 2,
    RETRY_BASE_MS: 300,
    MAX_CONCURRENT_TRANSLATIONS: 5,
    MAX_CONCURRENT_FEEDS: 15,
    MAX_ITEMS_PER_FEED: 40,
    MAX_BODY_BYTES: 2 * 1024 * 1024,
    MAX_REDIRECTS: 5,
    USER_AGENT: 'NewsAggregator/2.0 (RSS reader)',
    CIRCUIT_FAILS: 3,
    CIRCUIT_COOLDOWN_MS: 30 * 60 * 1000,
  },
  RATE_LIMIT: {
    WINDOW_MS: 60 * 1000,
    MAX_REQUESTS: 60,
    REFRESH_MAX: 6,
    TRANSLATE_MAX: 20,
  },
  SEARCH: {
    MAX_QUERY_LENGTH: 500,
    MAX_RESULTS_VIEW_ALL: 100,
    MAX_RESULTS_DEFAULT: 30,
    MAX_TRANSLATED_RESULTS: 10,
    TRANSLATE_BUDGET_MS: 0,
    QUERY_TRANSLATE_MS: 400,
    DEADLINE_MS: Math.max(0, Number(process.env.SEARCH_DEADLINE_MS) || 8000),
  },
  TRANSLATION: {
    QUEUE_LIMIT: 200,
    MAX_TEXT_LENGTH: 10000,
    MAX_BATCH_ITEM_LENGTH: 2000,
  },
};

/** @type {Record<string, { url: string, title: string, categories: string[] }>} */
const SOURCES = {
  bbc: { url: 'https://feeds.bbci.co.uk/news/rss.xml', title: 'BBC News', categories: ['world'] },
  nyt: { url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', title: 'The New York Times', categories: ['world'] },
  guardian: { url: 'https://www.theguardian.com/world/rss', title: 'The Guardian', categories: ['world'] },
  cnn: { url: 'https://rss.cnn.com/rss/edition.rss', title: 'CNN', categories: ['world'] },
  aljazeera: { url: 'https://www.aljazeera.com/xml/rss/all.xml', title: 'Al Jazeera', categories: ['world'] },
  npr: { url: 'https://feeds.npr.org/1001/rss.xml', title: 'NPR', categories: ['world'] },
  techcrunch: { url: 'https://techcrunch.com/feed/', title: 'TechCrunch', categories: ['tech'] },
  verge: { url: 'https://www.theverge.com/rss/index.xml', title: 'The Verge', categories: ['tech'] },
  wired: { url: 'https://www.wired.com/feed/rss', title: 'WIRED', categories: ['tech'] },
  engadget: { url: 'https://www.engadget.com/rss.xml', title: 'Engadget', categories: ['tech'] },
  arstechnica: { url: 'https://feeds.arstechnica.com/arstechnica/index', title: 'Ars Technica', categories: ['tech'] },
  atlantic: { url: 'https://www.theatlantic.com/feed/all/', title: 'The Atlantic', categories: ['culture'] },
  newyorker: { url: 'https://www.newyorker.com/feed/everything', title: 'The New Yorker', categories: ['culture'] },
  hackernews: { url: 'https://hnrss.org/frontpage', title: 'Hacker News', categories: ['tech'] },
  reddit_news: { url: 'https://www.reddit.com/r/worldnews/.rss', title: 'Reddit World News', categories: ['world'] },
  bbc_tech: { url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', title: 'BBC Tech', categories: ['tech'] },
  bbc_business: { url: 'https://feeds.bbci.co.uk/news/business/rss.xml', title: 'BBC Business', categories: ['business'] },
  nyt_world: { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', title: 'NYT World', categories: ['world'] },
  nyt_tech: { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml', title: 'NYT Tech', categories: ['tech'] },
  reuters_world: { url: 'https://www.reutersagency.com/feed/?taxonomy=best-topics&post_type=best', title: 'Reuters', categories: ['world'] },
  politico: { url: 'https://rss.politico.com/politics-news.xml', title: 'Politico', categories: ['world'] },
  axios: { url: 'https://api.axios.com/feed/', title: 'Axios', categories: ['business'] },
  bloomberg_tech: { url: 'https://feeds.bloomberg.com/technology/news.rss', title: 'Bloomberg Tech', categories: ['tech'] },
  forbes: { url: 'https://www.forbes.com/innovation/feed2/', title: 'Forbes', categories: ['business'] },
  sciencedaily: { url: 'https://www.sciencedaily.com/rss/all.xml', title: 'Science Daily', categories: ['science'] },
  nature: { url: 'https://www.nature.com/nature.rss', title: 'Nature', categories: ['science'] },
  phys: { url: 'https://phys.org/rss-feed/', title: 'Phys.org', categories: ['science'] },
  space: { url: 'https://www.space.com/feeds/all', title: 'Space.com', categories: ['science'] },
  espn: { url: 'https://www.espn.com/espn/rss/news', title: 'ESPN', categories: ['sports'] },
};

const TOP_SOURCES = ['bbc', 'nyt', 'guardian', 'cnn', 'npr', 'techcrunch', 'verge', 'politico', 'forbes', 'aljazeera'];

const CATEGORY_SOURCES = {
  tech: ['techcrunch', 'verge', 'wired', 'engadget', 'arstechnica', 'hackernews', 'bbc_tech', 'nyt_tech', 'bloomberg_tech'],
  business: ['forbes', 'bbc_business', 'axios'],
  world: ['nyt_world', 'reddit_news', 'politico', 'bbc', 'nyt', 'guardian', 'cnn', 'aljazeera', 'npr', 'reuters_world'],
  science: ['sciencedaily', 'nature', 'phys', 'space'],
  culture: ['atlantic', 'newyorker'],
  sports: ['espn'],
};

const ALLOWED_TARGET_LANGS = new Set(['ru', 'en', 'de', 'fr', 'es', 'zh', 'ar', 'pt', 'it', 'ja', 'ko']);

function resolveTargetLang(to) {
  const value = typeof to === 'string' ? to.toLowerCase() : '';
  return ALLOWED_TARGET_LANGS.has(value) ? value : 'ru';
}

const CSP_HEADER =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; " +
  "img-src 'self' data: https:; " +
  "connect-src 'self'; " +
  "base-uri 'self'; " +
  "form-action 'self'; " +
  "frame-ancestors 'self';";

module.exports = {
  CONFIG,
  SOURCES,
  TOP_SOURCES,
  CATEGORY_SOURCES,
  ALLOWED_TARGET_LANGS,
  resolveTargetLang,
  CSP_HEADER,
};
