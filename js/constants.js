/** Theme boot reads this key before modules load, so the string is duplicated in theme-boot.js. */
export const THEME_STORAGE_KEY = 'news-aggregator.theme';

export const STORAGE_KEYS = {
  savedSearches: 'news-aggregator.saved-searches',
  searchHistory: 'news-aggregator.search-history',
  favorites: 'news-aggregator.favorites',
  layout: 'news-aggregator.layout',
  theme: THEME_STORAGE_KEY,
};

export const KNOWN_CATEGORIES = new Set(['all', 'tech', 'business', 'world', 'science', 'culture', 'sports']);

export const CATEGORY_LABELS = {
  tech: 'Технологии',
  business: 'Бизнес',
  world: 'Мир',
  science: 'Наука',
  culture: 'Культура',
  sports: 'Спорт',
};

export const DEFAULT_TOPIC_CHIPS = ['Израиль', 'Украина', 'ИИ', 'Экономика', 'Климат', 'Выборы'];

export const SECTION_CHIP_BLOCKLIST = new Set([
  'технологии', 'наука', 'спорт', 'бизнес', 'мир', 'культура', 'главное', 'все',
  'все материалы', 'больше карточек', 'все источники',
]);

export const LIMITS = {
  savedSearches: 8,
  favorites: 24,
  searchHistory: 40,
  fullText: 100,
};
