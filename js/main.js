document.addEventListener('DOMContentLoaded', () => {
  const searchForm = document.getElementById('search-form');
  const searchButton = document.getElementById('search-button');
  const refreshButton = document.getElementById('refresh-button');
  const newsContainer = document.getElementById('news-container');
  
  // Native HTML5 <dialog> modal
  const newsModal = document.getElementById('news-modal');
  const newsModalClose = document.getElementById('news-modal-close');
  const newsModalLabel = document.getElementById('news-modal-label');
  const newsModalBody = document.getElementById('news-modal-body');

  const sourceSelect = document.getElementById('source-select');
  const topicInput = document.getElementById('topic-input');
  const loadingIndicator = document.getElementById('loading-indicator');
  const searchFeedback = document.getElementById('search-feedback');
  const translateToggle = document.getElementById('translate-toggle');
  const viewAllToggle = document.getElementById('view-all-toggle');
  const allSourcesToggle = document.getElementById('all-sources-toggle');
  const brandHome = document.getElementById('brand-home');
  const saveSearchButton = document.getElementById('save-search-button');
  const savedSearchesContainer = document.getElementById('saved-searches-list');
  const savedSearchesPanel = document.getElementById('saved-searches-panel');
  const savedSearchesStorageKey = 'news-aggregator.saved-searches';
  const searchHistoryStorageKey = 'news-aggregator.search-history';
  const maxSavedSearches = 8;
  const quickChipsContainer = document.querySelector('.quick-chips-scroll');
  const favoritesListContainer = document.getElementById('favorites-list');
  const favoritesPanel = document.getElementById('favorites-panel');
  const panelsContainer = document.getElementById('panels-container');
  const favoritesCountElement = document.getElementById('favorites-count');
  const favoritesStorageKey = 'news-aggregator.favorites';
  const maxFavorites = 24;

  // Theme Toggle Elements
  const themeToggleBtn = document.getElementById('theme-toggle-btn');

  // Inline SVG Placeholder data-URI (fully URI-encoded to avoid inline attribute JS syntax errors)
  const SVG_PLACEHOLDER = 'data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22800%22%20height%3D%22500%22%20viewBox%3D%220%200%20800%20500%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%25%22%20y1%3D%220%25%22%20x2%3D%22100%25%22%20y2%3D%22100%25%22%3E%3Cstop%20offset%3D%220%25%22%20stop-color%3D%22%231c1c1e%22%2F%3E%3Cstop%20offset%3D%22100%25%22%20stop-color%3D%22%232c2c2e%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22800%22%20height%3D%22500%22%20fill%3D%22url(%23g)%22%2F%3E%3Ctext%20x%3D%2250%25%22%20y%3D%2250%25%22%20dominant-baseline%3D%22middle%22%20text-anchor%3D%22middle%22%20fill%3D%22%238e8e93%22%20font-family%3D%22-apple-system%2C%20sans-serif%22%20font-size%3D%2228%22%20font-weight%3D%22600%22%3ENews%20Aggregator%3C%2Ftext%3E%3C%2Fsvg%3E';

  // Modern UI DOM references
  const categoryTabs = document.querySelectorAll('.category-tab');
  const layoutGridBtn = document.getElementById('layout-grid-btn');
  const layoutListBtn = document.getElementById('layout-list-btn');
  const statsToggleBtn = document.getElementById('stats-toggle-btn');
  const statsDashboard = document.getElementById('stats-dashboard');
  const statsCloseBtn = document.getElementById('stats-close-btn');
  const statsKeywords = document.getElementById('stats-keywords');
  const statsSources = document.getElementById('stats-sources');
  const toastRegion = document.getElementById('toast-region');
  const categoryTablist = document.querySelector('.category-tabs');
  let toastTimer = 0;

  const relativeTimeFormatter = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' });
  const absoluteTimeFormatter = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit'
  });
  const savedSearchTimeFormatter = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });

  let activeSearchController = null;
  let activeSearchToken = 0;
  let activeModalArticleKey = null;
  let clientArticlesCache = [];
  /** @type {Map<string, object>} Article key → article for O(1) card lookup */
  let clientArticlesByKey = new Map();
  /** @type {Map<string, string>} Article key → fullText store (bounded LRU) */
  const FULLTEXT_STORE_LIMIT = 100;
  const fullTextStore = new Map();
  /** @type {Set<string>} Memory cache of favorite article keys for O(1) checks */
  let favoritesMemorySet = new Set();
  /** @type {object[]|null} In-memory favorites list (avoid re-parsing localStorage) */
  let favoritesMemoryList = null;

  let currentCategory = 'all';
  let pendingSourceFromUrl = '';
  const sourceTitleById = new Map();
  const KNOWN_CATEGORIES = new Set(['all', 'tech', 'business', 'world', 'science', 'culture', 'sports']);
  const CATEGORY_LABELS = {
    tech: 'Технологии',
    business: 'Бизнес',
    world: 'Мир',
    science: 'Наука',
    culture: 'Культура',
    sports: 'Спорт'
  };
  const DEFAULT_TOPIC_CHIPS = ['Израиль', 'Украина', 'ИИ', 'Экономика', 'Климат', 'Выборы'];
  const SECTION_CHIP_BLOCKLIST = new Set([
    'технологии', 'наука', 'спорт', 'бизнес', 'мир', 'культура', 'главное', 'все',
    'все материалы', 'больше карточек', 'все источники'
  ]);

  function safeStorageGet(key, fallback = null) {
    try {
      return window.localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function safeStorageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (error) {
      console.warn('localStorage write failed', error);
      return false;
    }
  }

  function fullTextStoreSet(key, value) {
    if (!key || !value) return;
    if (fullTextStore.has(key)) fullTextStore.delete(key);
    fullTextStore.set(key, value);
    while (fullTextStore.size > FULLTEXT_STORE_LIMIT) {
      const oldest = fullTextStore.keys().next().value;
      fullTextStore.delete(oldest);
    }
  }

  function getStoredFullText(key) {
    const value = fullTextStore.get(key);
    if (!value) return { original: '', ru: '' };
    if (typeof value === 'string') return { original: value, ru: '' };
    return {
      original: sanitizeString(value.original),
      ru: sanitizeString(value.ru)
    };
  }

  function storeFullText(key, { original, ru } = {}) {
    if (!key) return;
    const prev = getStoredFullText(key);
    const next = {
      original: original != null && original !== '' ? original : prev.original,
      ru: ru != null && ru !== '' ? ru : prev.ru
    };
    if (!next.original && !next.ru) return;
    fullTextStoreSet(key, next);
  }

  function bindImageFallback(root) {
    if (!root) return;
    const images = root.tagName === 'IMG' ? [root] : root.querySelectorAll('img');
    images.forEach((img) => {
      if (img.dataset.fallbackBound === '1') return;
      img.dataset.fallbackBound = '1';
      img.addEventListener('error', () => {
        if (img.src !== SVG_PLACEHOLDER) img.src = SVG_PLACEHOLDER;
      });
    });
  }

  function preferredLayout() {
    const stored = safeStorageGet('news-aggregator.layout');
    if (stored === 'grid' || stored === 'list') return stored;
    return window.matchMedia('(max-width: 768px)').matches ? 'list' : 'grid';
  }

  let currentLayout = preferredLayout();

  function isDarkTheme() {
    const explicit = document.documentElement.getAttribute('data-theme');
    if (explicit === 'dark') return true;
    if (explicit === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function updateThemeColorMeta() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', isDarkTheme() ? '#1C1C1E' : '#007AFF');
  }

  function updateThemeIcons() {
    const isDark = isDarkTheme();
    const sunIcon = themeToggleBtn?.querySelector('.theme-icon-sun');
    const moonIcon = themeToggleBtn?.querySelector('.theme-icon-moon');

    if (sunIcon && moonIcon) {
      sunIcon.classList.toggle('d-none', !isDark);
      moonIcon.classList.toggle('d-none', isDark);
    }
    if (themeToggleBtn) {
      themeToggleBtn.setAttribute('aria-pressed', String(isDark));
      themeToggleBtn.title = isDark ? 'Включить светлую тему' : 'Включить тёмную тему';
      themeToggleBtn.setAttribute('aria-label', themeToggleBtn.title);
    }
    updateThemeColorMeta();
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    safeStorageSet('news-aggregator.theme', theme);
    updateThemeIcons();
  }

  updateThemeIcons();

  function populateSourceSelect(data) {
    if (!sourceSelect) return;
    const previous = sanitizeString(sourceSelect.value).trim() || pendingSourceFromUrl;
    const sources = Array.isArray(data?.sources) ? data.sources : [];
    const categories = data?.categories && typeof data.categories === 'object' ? data.categories : {};
    const top = Array.isArray(data?.topSources) ? data.topSources : [];
    const byId = new Map(sources.map((item) => [item.id, item]));

    sourceTitleById.clear();
    sources.forEach((item) => {
      if (item?.id) sourceTitleById.set(item.id, item.title || item.id);
    });

    const seen = new Set();
    const addGroup = (label, ids) => {
      const items = (ids || []).filter((id) => byId.has(id) && !seen.has(id));
      if (!items.length) return '';
      items.forEach((id) => seen.add(id));
      const options = items.map((id) => (
        `<option value="${escapeHtml(id)}">${escapeHtml(byId.get(id).title || id)}</option>`
      )).join('');
      return `<optgroup label="${escapeHtml(label)}">${options}</optgroup>`;
    };

    let html = '<option value="">По разделу</option>';
    html += addGroup('Главное', top);
    Object.keys(CATEGORY_LABELS).forEach((cat) => {
      html += addGroup(CATEGORY_LABELS[cat], categories[cat]);
    });
    html += addGroup('Другие', sources.map((item) => item.id).filter((id) => !seen.has(id)));

    sourceSelect.innerHTML = html;
    if (previous && Array.from(sourceSelect.options).some((option) => option.value === previous)) {
      sourceSelect.value = previous;
    }
    pendingSourceFromUrl = '';
  }

  async function loadSourceCatalog() {
    try {
      const resp = await fetch('/api/sources');
      if (!resp.ok) return;
      const data = await resp.json();
      if (data?.ok) populateSourceSelect(data);
    } catch (err) {
      console.warn('Failed to load source catalog', err);
    }
  }

  themeToggleBtn?.addEventListener('click', () => {
    applyTheme(isDarkTheme() ? 'light' : 'dark');
  });

  function sanitizeString(str) {
    return typeof str === 'string' ? str : '';
  }

  function parseBooleanParam(value, defaultValue = false) {
    if (value === null || value === undefined) return defaultValue;
    return ['1', 'true', 'on', 'yes'].includes(String(value).toLowerCase());
  }

  function safeExternalUrl(candidate, fallback = '') {
    const value = sanitizeString(candidate).trim();
    if (!value || value === '#') return fallback;
    if (value.startsWith('javascript:') || value.startsWith('data:')) return fallback;

    try {
      const normalized = value.startsWith('//') ? `https:${value}` : value;
      const parsed = new URL(normalized);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.href;
      }
    } catch (error) {
      return fallback;
    }

    return fallback;
  }

  function isEditableTarget(target) {
    return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
  }

  function formatRussianCount(count, forms) {
    const normalized = Math.abs(Number(count) || 0);
    const mod10 = normalized % 10;
    const mod100 = normalized % 100;

    if (mod10 === 1 && mod100 !== 11) return forms[0];
    if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return forms[1];
    return forms[2];
  }

  function getStorage() {
    try {
      return window.localStorage;
    } catch (error) {
      return null;
    }
  }

  function readJsonList(key) {
    const storage = getStorage();
    if (!storage) return [];

    const raw = storage.getItem(key);
    if (!raw) return [];

    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.warn('Failed to read JSON storage entry', error);
      return [];
    }
  }

  function writeJsonList(key, value) {
    const storage = getStorage();
    if (!storage) return false;

    try {
      storage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.warn('Failed to write JSON storage entry', error);
      showToast('Не удалось сохранить локально (хранилище недоступно).');
      return false;
    }
  }

  function generateId(prefix = 'item') {
    if (window.crypto?.randomUUID) {
      return `${prefix}-${window.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function getSelectedSource() {
    return sanitizeString(sourceSelect?.value).trim() || sanitizeString(pendingSourceFromUrl).trim();
  }

  function getCurrentSearchState() {
    return {
      query: sanitizeString(topicInput?.value).trim(),
      source: getSelectedSource(),
      translate: isTranslateEnabled(),
      viewAll: isViewAllEnabled(),
      allSources: isAllSourcesEnabled(),
      category: currentCategory
    };
  }

  function hasSavableSearchState(state = getCurrentSearchState()) {
    return Boolean(
      state.query
      || state.source
      || !state.translate
      || state.viewAll
      || state.allSources
      || (state.category && state.category !== 'all')
    );
  }

  function normalizeSavedSearchState(state) {
    const category = sanitizeString(state?.category).trim() || 'all';
    return {
      query: sanitizeString(state?.query).trim(),
      source: sanitizeString(state?.source).trim(),
      translate: Boolean(state?.translate),
      viewAll: Boolean(state?.viewAll),
      allSources: Boolean(state?.allSources),
      category: KNOWN_CATEGORIES.has(category) ? category : 'all'
    };
  }

  function getSavedSearches() {
    return readJsonList(savedSearchesStorageKey)
      .map(item => ({
        id: sanitizeString(item?.id).trim() || generateId('search'),
        ...normalizeSavedSearchState(item),
        savedAt: sanitizeString(item?.savedAt).trim() || new Date().toISOString()
      }))
      .sort((left, right) => new Date(right.savedAt).getTime() - new Date(left.savedAt).getTime());
  }

  function recordSearchQuery(query) {
    const safe = sanitizeString(query).trim();
    if (!safe || safe.length < 2) return;
    
    // Normalize key for frequency counting
    const key = safe.toLowerCase();
    const history = readJsonList(searchHistoryStorageKey);
    const existing = history.find(item => item.query.toLowerCase() === key);
    
    if (existing) {
      existing.count = (existing.count || 1) + 1;
      existing.lastSearched = new Date().toISOString();
      // preserve user's preferred casing
      existing.query = safe;
    } else {
      history.push({
        query: safe,
        count: 1,
        lastSearched: new Date().toISOString()
      });
    }
    
    writeJsonList(searchHistoryStorageKey, history);
    renderQuickChips();
  }

  function getTopSearchQueries(limit = 3) {
    const history = readJsonList(searchHistoryStorageKey);
    return history
      .sort((a, b) => (b.count - a.count) || (new Date(b.lastSearched).getTime() - new Date(a.lastSearched).getTime()))
      .slice(0, limit)
      .map(item => item.query);
  }

  function renderQuickChips() {
    if (!quickChipsContainer) return;
    const topSearches = getTopSearchQueries(3);
    const combined = [];
    const seen = new Set();

    const pushChip = (label, isTop) => {
      const lower = sanitizeString(label).trim().toLowerCase();
      if (!lower || seen.has(lower) || SECTION_CHIP_BLOCKLIST.has(lower)) return;
      seen.add(lower);
      combined.push({ label, isTop });
    };

    topSearches.forEach((q) => pushChip(q, true));
    DEFAULT_TOPIC_CHIPS.forEach((chip) => pushChip(chip, false));

    quickChipsContainer.innerHTML = combined.map((item) => `
      <button type="button" class="chip-btn${item.isTop ? ' chip-btn--top' : ''}" data-quick-topic="${escapeHtml(item.label)}">${escapeHtml(item.label)}</button>
    `).join('');
    updateChipActiveState();
  }

  function updateChipActiveState() {
    if (!quickChipsContainer) return;
    const query = sanitizeString(topicInput?.value).trim().toLowerCase();
    quickChipsContainer.querySelectorAll('[data-quick-topic]').forEach((button) => {
      const on = sanitizeString(button.dataset.quickTopic).trim().toLowerCase() === query;
      button.classList.toggle('chip-btn--active', on);
      button.setAttribute('aria-pressed', String(on));
    });
  }

  function storeSavedSearches(savedSearches) {
    writeJsonList(savedSearchesStorageKey, savedSearches.slice(0, maxSavedSearches));
  }

  function findMatchingSavedSearch(state) {
    const normalized = normalizeSavedSearchState(state);
    return getSavedSearches().find(item => (
      item.query === normalized.query &&
      item.source === normalized.source &&
      item.translate === normalized.translate &&
      item.viewAll === normalized.viewAll &&
      item.allSources === normalized.allSources &&
      item.category === normalized.category
    ));
  }

  function getSourceLabel(source) {
    if (!source) return currentCategory !== 'all'
      ? (CATEGORY_LABELS[currentCategory] || 'По разделу')
      : 'По разделу';
    if (sourceTitleById.has(source)) return sourceTitleById.get(source);
    const option = Array.from(sourceSelect?.options || []).find(item => item.value === source);
    return sanitizeString(option?.textContent?.trim() || source);
  }

  function formatSavedSearchTitle(savedSearch) {
    const query = sanitizeString(savedSearch?.query).trim();
    if (query) return query;
    return getSourceLabel(savedSearch?.source);
  }

  function formatSavedSearchMeta(savedSearch) {
    const parts = [];
    const sourceLabel = getSourceLabel(savedSearch?.source);
    const translateLabel = savedSearch?.translate ? 'Перевод' : 'Оригинал';
    parts.push(sourceLabel);
    if (savedSearch?.viewAll) parts.push('Больше карточек');
    if (savedSearch?.allSources) parts.push('Все источники');
    if (savedSearch?.category && savedSearch.category !== 'all') {
      parts.push(CATEGORY_LABELS[savedSearch.category] || savedSearch.category);
    }
    parts.push(translateLabel);
    return parts.join(' · ');
  }

  function formatSavedSearchTooltip(savedSearch) {
    const savedAt = sanitizeString(savedSearch?.savedAt).trim();
    const savedAtLabel = savedAt && !Number.isNaN(new Date(savedAt).getTime())
      ? savedSearchTimeFormatter.format(new Date(savedAt))
      : '';
    const parts = [];

    if (savedAtLabel) parts.push(`Сохранено: ${savedAtLabel}`);
    if (savedSearch?.query) parts.push(`Запрос: ${savedSearch.query}`);
    if (savedSearch?.source) parts.push(`Источник: ${getSourceLabel(savedSearch.source)}`);
    parts.push(savedSearch?.translate ? 'Перевод на русский' : 'Оригинал');
    if (savedSearch?.viewAll) parts.push('Больше карточек');
    if (savedSearch?.allSources) parts.push('Все источники');
    if (savedSearch?.category && savedSearch.category !== 'all') {
      parts.push(`Раздел: ${CATEGORY_LABELS[savedSearch.category] || savedSearch.category}`);
    }

    return parts.join(' · ');
  }

  function updateSaveSearchButtonState() {
    if (!saveSearchButton) return;
    const currentState = getCurrentSearchState();
    const matchingSearch = findMatchingSavedSearch(currentState);
    const canSave = hasSavableSearchState(currentState);

    saveSearchButton.disabled = !canSave;
    saveSearchButton.textContent = matchingSearch ? 'Обновить сохранённый поиск' : 'Сохранить текущий поиск';
    saveSearchButton.title = canSave
      ? 'Сохранить текущее сочетание запроса, источника и переключателей'
      : 'Введите запрос или выберите фильтры, чтобы сохранить поиск';
  }

  function renderSavedSearches() {
    if (!savedSearchesContainer) return;
    const savedSearches = getSavedSearches();
    updateSaveSearchButtonState();

    updateCollapsiblePanels();
    if (!savedSearches.length) {
      savedSearchesContainer.innerHTML = '';
      return;
    }

    savedSearchesContainer.innerHTML = savedSearches.map(savedSearch => {
      const title = escapeHtml(formatSavedSearchTitle(savedSearch));
      const meta = escapeHtml(formatSavedSearchMeta(savedSearch));
      const tooltip = escapeHtml(formatSavedSearchTooltip(savedSearch));
      const id = escapeHtml(savedSearch.id);

      return `
        <div class="saved-search" data-saved-search-id="${id}">
          <button
            type="button"
            class="saved-search__apply"
            data-saved-search-apply="${id}"
            title="${tooltip}"
          >
            <span class="saved-search__title">${title}</span>
            <span class="saved-search__meta">${meta}</span>
          </button>
          <button
            type="button"
            class="saved-search__remove"
            data-saved-search-remove="${id}"
            aria-label="Удалить сохранённый поиск «${title}»"
            title="Удалить сохранённый поиск"
          >×</button>
        </div>
      `;
    }).join('');
  }

  function saveCurrentSearch() {
    const currentState = normalizeSavedSearchState(getCurrentSearchState());
    if (!hasSavableSearchState(currentState)) {
      showToast('Сначала введите запрос или выберите фильтры, которые хотите сохранить.');
      updateSaveSearchButtonState();
      return;
    }

    const savedSearches = getSavedSearches();
    const matchingIndex = savedSearches.findIndex(item => (
      item.query === currentState.query &&
      item.source === currentState.source &&
      item.translate === currentState.translate &&
      item.viewAll === currentState.viewAll &&
      item.allSources === currentState.allSources &&
      item.category === currentState.category
    ));
    const now = new Date().toISOString();
    const nextSavedSearch = {
      id: matchingIndex >= 0 ? savedSearches[matchingIndex].id : generateId('search'),
      ...currentState,
      savedAt: now
    };

    const nextSavedSearches = [
      nextSavedSearch,
      ...savedSearches.filter((_, index) => index !== matchingIndex)
    ].slice(0, maxSavedSearches);

    storeSavedSearches(nextSavedSearches);
    renderSavedSearches();
    showToast('Поиск сохранён.');
  }

  function applySavedSearch(savedSearch) {
    if (topicInput) topicInput.value = savedSearch.query || '';
    if (sourceSelect) sourceSelect.value = savedSearch.source || '';
    if (translateToggle) translateToggle.checked = Boolean(savedSearch.translate);
    if (viewAllToggle) viewAllToggle.checked = Boolean(savedSearch.viewAll);
    if (allSourcesToggle) allSourcesToggle.checked = Boolean(savedSearch.allSources);
    setActiveCategory(savedSearch.category || 'all');

    topicInput?.focus();
    topicInput?.select();
    renderSavedSearches();
    fetchAndDisplayNews({ refresh: true });
  }

  function removeSavedSearch(savedSearchId) {
    const nextSavedSearches = getSavedSearches().filter(item => item.id !== savedSearchId);
    storeSavedSearches(nextSavedSearches);
    renderSavedSearches();
    showToast('Сохранённый поиск удалён.');
  }

  function getArticleKey(article) {
    const source = sanitizeString(article?.source).trim();
    const link = safeExternalUrl(article?.link, '').trim();
    const id = sanitizeString(article?.id).trim();
    const publishedAt = sanitizeString(article?.publishedAt).trim();
    const title = sanitizeString(article?.title || article?.title_ru).trim();

    if (id) return `${source}:${id}`;
    if (link) return `${source}|${link}`;
    return `${source}|${title}|${publishedAt}`;
  }

  function normalizeFavoriteArticle(article) {
    return {
      key: getArticleKey(article),
      id: sanitizeString(article?.id).trim(),
      title: sanitizeString(article?.title).trim(),
      titleRu: sanitizeString(article?.titleRu || article?.title_ru).trim(),
      snippet: sanitizeString(article?.snippet).trim(),
      snippetRu: sanitizeString(article?.snippetRu || article?.snippet_ru).trim(),
      link: safeExternalUrl(article?.link, ''),
      imageUrl: safeExternalUrl(article?.imageUrl, SVG_PLACEHOLDER),
      source: sanitizeString(article?.source).trim(),
      sourceTitle: sanitizeString(article?.sourceTitle || article?.source).trim(),
      publishedAt: sanitizeString(article?.publishedAt).trim(),
      fullText: sanitizeString(article?.fullText).trim(),
      savedAt: sanitizeString(article?.savedAt).trim() || new Date().toISOString()
    };
  }

  function getFavoriteArticles() {
    if (favoritesMemoryList) return favoritesMemoryList;

    const list = readJsonList(favoritesStorageKey)
      .map(item => normalizeFavoriteArticle(item))
      .filter(item => item.key)
      .sort((left, right) => new Date(right.savedAt).getTime() - new Date(left.savedAt).getTime());

    favoritesMemoryList = list;
    favoritesMemorySet = new Set(list.map(item => item.key));
    return list;
  }

  function storeFavoriteArticles(favoriteArticles) {
    const next = favoriteArticles.slice(0, maxFavorites);
    writeJsonList(favoritesStorageKey, next);
    favoritesMemoryList = next;
    favoritesMemorySet = new Set(next.map(item => item.key));
  }

  function findFavoriteArticle(articleKey) {
    return getFavoriteArticles().find(item => item.key === articleKey) || null;
  }

  function getFavoriteArticleTitle(favoriteArticle) {
    const translate = isTranslateEnabled();
    if (translate && favoriteArticle?.titleRu) return favoriteArticle.titleRu;
    return favoriteArticle?.title || favoriteArticle?.titleRu || 'Без названия';
  }

  function getFavoriteArticleMeta(favoriteArticle) {
    const sourceTitle = sanitizeString(favoriteArticle?.sourceTitle || favoriteArticle?.source).trim() || 'Источник не указан';
    const timeMeta = computeTimeMeta(favoriteArticle?.publishedAt);
    const parts = [sourceTitle];
    if (timeMeta.relative && timeMeta.relative !== 'Дата не указана') {
      parts.push(timeMeta.relative);
    }
    return parts.join(' · ');
  }

  function updateFavoriteCount(count) {
    if (!favoritesCountElement) return;
    favoritesCountElement.textContent = String(count);
  }

  function updateFavoriteButton(cardElement, isFavorite) {
    if (!cardElement) return;
    cardElement.classList.toggle('news-card--bookmarked', isFavorite);
    const button = cardElement.querySelector('[data-favorite-toggle]');
    if (!button) return;

    button.setAttribute('aria-pressed', String(isFavorite));
    button.setAttribute('aria-label', isFavorite ? 'Убрать из избранного' : 'Добавить в избранное');
    button.title = isFavorite ? 'Убрать из избранного' : 'Добавить в избранное';
    button.innerHTML = isFavorite ? '<span aria-hidden="true">★</span>' : '<span aria-hidden="true">☆</span>';
  }

  function syncFavoriteButtonState(articleKey) {
    if (!newsContainer || !articleKey) return;
    const card = newsContainer.querySelector(`.news-card[data-article-key="${CSS.escape(articleKey)}"]`);
    if (!card) return;
    updateFavoriteButton(card, favoritesMemorySet.has(articleKey));
  }

  function updateCollapsiblePanels() {
    const savedCount = getSavedSearches().length;
    const favoriteCount = getFavoriteArticles().length;

    if (savedSearchesPanel) {
      savedSearchesPanel.hidden = savedCount === 0;
      if (savedCount === 0) savedSearchesPanel.open = false;
    }
    if (favoritesPanel) {
      favoritesPanel.hidden = favoriteCount === 0;
      if (favoriteCount === 0) favoritesPanel.open = false;
    }
    if (panelsContainer) {
      panelsContainer.hidden = savedCount === 0 && favoriteCount === 0;
    }
  }

  function renderFavoritesPanel() {
    if (!favoritesListContainer) return;
    const favoriteArticles = getFavoriteArticles();
    updateFavoriteCount(favoriteArticles.length);
    updateCollapsiblePanels();

    if (!favoriteArticles.length) {
      favoritesListContainer.innerHTML = '';
      return;
    }

    favoritesListContainer.innerHTML = favoriteArticles.map(favoriteArticle => {
      const articleKey = escapeHtml(favoriteArticle.key);
      const title = escapeHtml(getFavoriteArticleTitle(favoriteArticle));
      const meta = escapeHtml(getFavoriteArticleMeta(favoriteArticle));
      const image = escapeHtml(safeExternalUrl(favoriteArticle.imageUrl, SVG_PLACEHOLDER));

      return `
        <div class="favorite-item" data-favorite-key="${articleKey}">
          <button
            type="button"
            class="favorite-item__preview"
            data-favorite-open="${articleKey}"
          >
            <img src="${image}" class="favorite-item__thumb" alt="${title}" loading="lazy" decoding="async">
            <span class="favorite-item__content">
              <span class="favorite-item__title">${title}</span>
              <span class="favorite-item__meta">${meta}</span>
            </span>
          </button>
          <button
            type="button"
            class="favorite-item__remove"
            data-favorite-remove="${articleKey}"
            aria-label="Удалить «${title}»"
            title="Удалить из избранного"
          >×</button>
        </div>
      `;
    }).join('');
    bindImageFallback(favoritesListContainer);
  }

  function toggleFavoriteArticle(article) {
    const articleKey = getArticleKey(article);
    if (!articleKey) return;

    if (favoritesMemorySet.has(articleKey)) {
      removeFavoriteArticle(articleKey, 'Статья удалена из избранного.');
      return;
    }

    const favorites = getFavoriteArticles();
    const nextFavorite = normalizeFavoriteArticle({ ...article, savedAt: new Date().toISOString() });
    const nextFavorites = [nextFavorite, ...favorites.filter(item => item.key !== articleKey)].slice(0, maxFavorites);

    storeFavoriteArticles(nextFavorites);
    syncFavoriteButtonState(articleKey);
    renderFavoritesPanel();
    showToast('Статья добавлена в избранное.');
  }

  function removeFavoriteArticle(articleKey, feedbackMessage = 'Статья удалена из избранного.') {
    const nextFavorites = getFavoriteArticles().filter(item => item.key !== articleKey);
    storeFavoriteArticles(nextFavorites);
    syncFavoriteButtonState(articleKey);
    renderFavoritesPanel();
    if (feedbackMessage) showToast(feedbackMessage);
  }

  // Open native HTML5 <dialog> modal
  async function openArticleModal(article) {
    if (!newsModal || !article) return;

    const articleKey = getArticleKey(article);
    activeModalArticleKey = articleKey;
    const sourceKey = sanitizeString(article?.source).trim();
    const idKey = sanitizeString(article?.id).trim();
    const translate = isTranslateEnabled();
    const stillThisArticle = () => activeModalArticleKey === articleKey;

    const stored = getStoredFullText(articleKey);
    let originalText = stored.original || sanitizeString(article?.fullText).trim();
    let translatedText = stored.ru || sanitizeString(article?.fullText_ru || article?.fullTextRu).trim();

    const title = translate
      ? sanitizeString(article?.title_ru || article?.titleRu || article?.title).trim()
      : sanitizeString(article?.title).trim();
    const displayTitle = title || 'Загрузка...';
    const sourceTitle = sanitizeString(article?.sourceTitle || article?.source).trim() || 'Источник';
    const timeMeta = computeTimeMeta(article?.publishedAt);
    const imageSrc = safeExternalUrl(article?.imageUrl || article?.imageSrc, SVG_PLACEHOLDER);
    const link = safeExternalUrl(article?.link, '#');

    newsModalLabel.textContent = displayTitle;
    newsModalBody.innerHTML = `
      <div class="modal-article">
        ${imageSrc ? `<img src="${escapeHtml(imageSrc)}" class="modal-article-img" alt="${escapeHtml(displayTitle)}">` : ''}
        <div class="modal-article-meta">
          <span class="badge">${escapeHtml(sourceTitle)}</span>
          <span>${escapeHtml(timeMeta.relative)}</span>
          <span id="modal-reading-time" hidden></span>
        </div>
        <p class="modal-article-text modal-article-text--loading" id="modal-text-content">Загружаем текст статьи...</p>
        <p><a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Читать в оригинале ↗</a></p>
      </div>
    `;
    bindImageFallback(newsModalBody);
    newsModal.showModal();

    if ((!originalText || (translate && !translatedText)) && sourceKey && idKey) {
      try {
        const resp = await fetch(`/api/article?source=${encodeURIComponent(sourceKey)}&id=${encodeURIComponent(idKey)}&translate=${translate}`);
        if (!resp.ok) throw new Error(`article ${resp.status}`);
        const data = await resp.json();
        if (!stillThisArticle()) return;
        if (data?.ok && data.article) {
          if (data.article.fullText) originalText = data.article.fullText;
          if (data.article.fullText_ru) translatedText = data.article.fullText_ru;
          storeFullText(articleKey, { original: originalText, ru: translatedText });
        }
      } catch (err) {
        console.warn('Failed to load article body', err);
        const textElErr = document.getElementById('modal-text-content');
        if (textElErr && stillThisArticle() && !originalText && !translatedText) {
          textElErr.classList.remove('modal-article-text--loading');
          textElErr.textContent = 'Не удалось загрузить полный текст. Попробуйте позже.';
          return;
        }
      }
    }

    if (!stillThisArticle()) return;

    if (translate && originalText && !translatedText) {
      const maybeRu = await translateViaApi(originalText);
      if (!stillThisArticle()) return;
      if (maybeRu && maybeRu !== originalText) {
        translatedText = maybeRu;
        storeFullText(articleKey, { original: originalText, ru: translatedText });
      }
    }

    const textEl = document.getElementById('modal-text-content');
    if (!textEl || !stillThisArticle()) return;
    textEl.classList.remove('modal-article-text--loading');

    if (translate && translatedText) {
      textEl.textContent = translatedText;
    } else if (originalText) {
      textEl.textContent = originalText;
    } else {
      textEl.textContent = (translate
        ? sanitizeString(article?.snippet_ru || article?.snippet)
        : sanitizeString(article?.snippet)) || 'Полный текст недоступен для этой новости.';
    }

    const readingEl = document.getElementById('modal-reading-time');
    if (readingEl) {
      const minutes = getReadingTime(textEl.textContent, translate);
      readingEl.hidden = false;
      readingEl.textContent = `${minutes} мин`;
    }
  }

  newsModalClose?.addEventListener('click', () => {
    newsModal?.close();
  });

  newsModal?.addEventListener('click', (e) => {
    if (e.target === newsModal) {
      newsModal.close();
    }
  });

  function setActiveCategory(category) {
    const next = KNOWN_CATEGORIES.has(category) ? category : 'all';
    currentCategory = next;
    categoryTabs.forEach((tab) => {
      const on = tab.dataset.category === next;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    });
    if (next !== 'all' && allSourcesToggle) {
      allSourcesToggle.checked = false;
    }
  }

  function syncStateFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q');
    const source = params.get('source');
    const category = params.get('category');

    if (topicInput && q !== null) topicInput.value = q;
    if (source) {
      pendingSourceFromUrl = source;
      if (sourceSelect && Array.from(sourceSelect.options).some((option) => option.value === source)) {
        sourceSelect.value = source;
        pendingSourceFromUrl = '';
      }
    }
    if (translateToggle) translateToggle.checked = parseBooleanParam(params.get('translate'), true);
    if (viewAllToggle) viewAllToggle.checked = parseBooleanParam(params.get('view_all'), false);
    if (allSourcesToggle) allSourcesToggle.checked = parseBooleanParam(params.get('all_sources'), false);
    if (category && KNOWN_CATEGORIES.has(category)) {
      setActiveCategory(category);
    }
  }

  function syncUrlFromState({ query, source, translate, viewAll, allSources, category }) {
    const url = new URL(window.location.href);

    if (query) url.searchParams.set('q', query);
    else url.searchParams.delete('q');

    if (source) url.searchParams.set('source', source);
    else url.searchParams.delete('source');

    if (!translate) url.searchParams.set('translate', 'false');
    else url.searchParams.delete('translate');

    if (viewAll) url.searchParams.set('view_all', 'true');
    else url.searchParams.delete('view_all');

    if (allSources) url.searchParams.set('all_sources', 'true');
    else url.searchParams.delete('all_sources');

    if (category && category !== 'all') url.searchParams.set('category', category);
    else url.searchParams.delete('category');

    const queryString = url.searchParams.toString();
    const nextUrl = queryString ? `${url.pathname}?${queryString}${url.hash}` : `${url.pathname}${url.hash}`;
    window.history.replaceState({}, '', nextUrl);
  }

  function escapeHtml(str) {
    return sanitizeString(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderSkeletons(count = 6) {
    if (!newsContainer) return;
    const fragment = document.createDocumentFragment();

    for (let index = 0; index < count; index += 1) {
      const item = document.createElement('div');
      item.className = 'news-grid-item';
      item.innerHTML = `
        <article class="news-card news-card--skeleton" aria-hidden="true">
          <div class="news-card-media skeleton-media"></div>
          <div class="news-card-body">
            <div class="skeleton-line" style="width:70%;height:16px;"></div>
            <div class="skeleton-line" style="width:90%;height:14px;margin-top:6px;"></div>
          </div>
        </article>
      `;
      fragment.appendChild(item);
    }

    newsContainer.innerHTML = '';
    newsContainer.appendChild(fragment);
  }

  function renderEmptyState(query, source) {
    if (!newsContainer) return;
    const canReset = Boolean(query || source || currentCategory !== 'all' || isViewAllEnabled() || isAllSourcesEnabled());
    newsContainer.innerHTML = `
      <div class="feed-status">
        <h3>Ничего не найдено</h3>
        <p>Попробуйте изменить ключевые слова или сбросить фильтры.</p>
        <div class="feed-status__actions">
          <button type="button" class="btn-primary" data-retry-search>Повторить</button>
          ${canReset ? '<button type="button" class="btn-ghost" data-reset-filters>Сбросить</button>' : ''}
        </div>
      </div>
    `;
  }

  function renderErrorState(message) {
    if (!newsContainer) return;
    newsContainer.innerHTML = `
      <div class="feed-status">
        <h3>Ошибка загрузки</h3>
        <p>${escapeHtml(message)}</p>
        <div class="feed-status__actions">
          <button type="button" class="btn-primary" data-retry-search>Повторить</button>
        </div>
      </div>
    `;
  }

  function splitIntoTokens(query) {
    return sanitizeString(query)
      .toLowerCase()
      .split(/[\s,.;:!?"'()\[\]{}<>/@#%^&*+=|~`]+/)
      .map(token => token.trim())
      .filter(token => token.length > 2);
  }

  function highlightMatchesWithRegexes(text, regexes) {
    const safeText = escapeHtml(text);
    if (!safeText || !regexes.length) return safeText;
    return regexes.reduce((acc, { re }) => {
      re.lastIndex = 0;
      return acc.replace(re, '<mark class="news-highlight">$1</mark>');
    }, safeText);
  }

  function computeTimeMeta(isoString) {
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

  function formatSearchStatus(data) {
    const count = Array.isArray(data?.results) ? data.results.length : 0;
    const parts = [`Показаны ${count} материалов`];

    if (data?.generatedAt) {
      const timeMeta = computeTimeMeta(data.generatedAt);
      if (timeMeta.relative && timeMeta.relative !== 'Дата не указана') {
        parts.push(data.cached ? `кэш · ${timeMeta.relative}` : `обновлено ${timeMeta.relative}`);
      }
    }

    if (data?.degraded) {
      const failed = Array.isArray(data.sourcesFailed) ? data.sourcesFailed : [];
      if (failed.length) {
        const labels = failed.slice(0, 4).map((id) => getSourceLabel(id) || id);
        const extra = failed.length > 4 ? ` и ещё ${failed.length - 4}` : '';
        parts.push(`недоступны: ${labels.join(', ')}${extra}`);
      } else {
        parts.push('часть источников недоступна');
      }
    }

    return `${parts.join('. ')}.`;
  }

  function showToast(message) {
    const text = sanitizeString(message).trim();
    if (!toastRegion || !text) return;
    toastRegion.textContent = text;
    toastRegion.classList.add('toast-region--visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastRegion.classList.remove('toast-region--visible');
    }, 2800);
  }

  function setLoading(isLoading) {
    loadingIndicator?.classList.toggle('d-none', !isLoading);
    if (searchButton) searchButton.disabled = isLoading;
    if (refreshButton) refreshButton.disabled = isLoading;
    newsContainer?.setAttribute('aria-busy', String(isLoading));
    if (newsContainer) {
      newsContainer.style.opacity = isLoading ? '0.6' : '1';
    }
  }

  function isTranslateEnabled() {
    return translateToggle?.checked ?? true;
  }

  function isViewAllEnabled() {
    return viewAllToggle?.checked ?? false;
  }

  function isAllSourcesEnabled() {
    return allSourcesToggle?.checked ?? false;
  }

  async function translateViaApi(text) {
    const safeText = sanitizeString(text);
    if (!safeText) return '';

    try {
      const resp = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: safeText, to: 'ru' })
      });
      const data = await resp.json();
      if (data?.ok && data.translated) return data.translated;
    } catch (error) {}

    return safeText;
  }

  function getReadingTime(text, isRussian = false) {
    const words = text ? text.split(/\s+/).length : 0;
    const wpm = isRussian ? 160 : 220;
    return Math.ceil(words / wpm) || 1;
  }

  function updateLayoutView() {
    if (!newsContainer) return;
    const isList = currentLayout === 'list';
    newsContainer.classList.toggle('view-list', isList);
    layoutListBtn?.classList.toggle('active', isList);
    layoutGridBtn?.classList.toggle('active', !isList);
    layoutListBtn?.setAttribute('aria-pressed', String(isList));
    layoutGridBtn?.setAttribute('aria-pressed', String(!isList));
  }

  function buildStatsDashboard(articles) {
    if (!statsKeywords || !statsSources) return;
    if (!Array.isArray(articles) || articles.length === 0) return;

    const excludeWords = new Set(['это', 'как', 'для', 'что', 'или', 'этот', 'эта', 'эти', 'все', 'под', 'над', 'the', 'and', 'for', 'with', 'about', 'from']);
    const wordFreq = {};
    articles.forEach(art => {
      const text = `${art.title} ${art.snippet} ${art.title_ru || ''}`.toLowerCase();
      const tokens = text.split(/[\s,.;:!?"'()\[\]{}<>/@#%^&*+=|~`\-_]+/)
        .map(t => t.trim())
        .filter(t => t.length > 4 && !excludeWords.has(t));
      
      tokens.forEach(token => { wordFreq[token] = (wordFreq[token] || 0) + 1; });
    });

    const topKeywords = Object.entries(wordFreq).sort((a, b) => b[1] - a[1]).slice(0, 10);
    statsKeywords.innerHTML = topKeywords.map(([word, count]) => `
      <button type="button" class="trend-keyword-badge" data-quick-topic="${escapeHtml(word)}">
        #${escapeHtml(word)} <span>${count}</span>
      </button>
    `).join('');

    statsKeywords.querySelectorAll('.trend-keyword-badge').forEach(badge => {
      badge.addEventListener('click', () => {
        if (topicInput) {
          topicInput.value = badge.dataset.quickTopic;
          topicInput.focus();
          fetchAndDisplayNews();
        }
      });
    });

    const sourceCount = {};
    articles.forEach(art => {
      const src = art.sourceTitle || art.source || 'Другие';
      sourceCount[src] = (sourceCount[src] || 0) + 1;
    });

    const sortedSources = Object.entries(sourceCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
    statsSources.innerHTML = sortedSources.map(([src, count]) => `
      <div style="font-size:12px;margin-bottom:4px;">
        <span>${escapeHtml(src)}</span>: <strong>${count}</strong>
      </div>
    `).join('');
  }

  function renderArticles(articles, { query, source }, searchToken = activeSearchToken) {
    const highlightTokens = splitIntoTokens(query);
    const highlightRegexes = highlightTokens.map(token => ({
      token,
      re: new RegExp(`(${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
    }));
    const translate = isTranslateEnabled();

    if (articles && articles.length > 0) {
      clientArticlesCache = articles;
      clientArticlesByKey = new Map();
      articles.forEach(article => {
        const key = getArticleKey(article);
        if (key) {
          clientArticlesByKey.set(key, article);
          if (article.fullText || article.fullText_ru) {
            storeFullText(key, { original: article.fullText, ru: article.fullText_ru });
          }
        }
      });
      // Stats only when dashboard is open (avoid work on every render)
      if (statsDashboard && !statsDashboard.classList.contains('d-none')) {
        buildStatsDashboard(articles);
      }
    }

    if (!Array.isArray(articles) || articles.length === 0) {
      searchFeedback.textContent = query ? `Ничего не найдено по запросу «${query}».` : 'Нет материалов в выбранном разделе.';
      renderEmptyState(query, source);
      return;
    }

    searchFeedback.textContent = `Показаны ${articles.length} материалов.`;
    newsContainer.innerHTML = '';

    getFavoriteArticles();

    const fragment = document.createDocumentFragment();
    articles.forEach((article, index) => {
      fragment.appendChild(createCard(article, highlightRegexes, translate, index));
    });
    newsContainer.appendChild(fragment);
    updateLayoutView();
    updateChipActiveState();

    if (translate) {
      ensureArticlesTranslated(articles, searchToken);
    }
  }

  function patchCardTranslations(article) {
    const articleKey = getArticleKey(article);
    if (!newsContainer || !articleKey) return;
    const card = newsContainer.querySelector(`.news-card[data-article-key="${CSS.escape(articleKey)}"]`);
    if (!card) return;

    const translate = isTranslateEnabled();
    const title = translate ? sanitizeString(article.title_ru || article.title) : sanitizeString(article.title);
    const snippet = translate ? sanitizeString(article.snippet_ru || article.snippet) : sanitizeString(article.snippet);
    const query = sanitizeString(topicInput?.value).trim();
    const highlightRegexes = splitIntoTokens(query).map((token) => ({
      token,
      re: new RegExp(`(${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
    }));
    const titleEl = card.querySelector('.news-card-open') || card.querySelector('.news-card-title');
    const textEl = card.querySelector('.news-card-text');
    if (titleEl) titleEl.innerHTML = highlightMatchesWithRegexes(title, highlightRegexes);
    if (textEl) textEl.innerHTML = highlightMatchesWithRegexes(snippet, highlightRegexes);

    if (article.title_ru || article.snippet_ru) {
      const badges = card.querySelector('.news-card-badges');
      if (badges && !badges.querySelector('.news-card-badge--lang')) {
        const badge = document.createElement('span');
        badge.className = 'news-card-badge news-card-badge--lang';
        badge.title = 'Переведено на русский';
        badge.textContent = 'RU';
        badges.appendChild(badge);
      }
    }
  }

  async function translateBatchChunk(texts) {
    const resp = await fetch('/api/translate/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts, to: 'ru' })
    });
    if (!resp.ok) throw new Error(`batch ${resp.status}`);
    const data = await resp.json();
    const map = new Map();
    if (data?.ok && Array.isArray(data.translations)) {
      data.translations.forEach((item) => {
        if (item?.failed || !item?.original || !item?.translated) return;
        map.set(item.original, item.translated);
      });
    }
    return map;
  }

  async function ensureArticlesTranslated(articles, searchToken = activeSearchToken) {
    if (!isTranslateEnabled() || !Array.isArray(articles) || articles.length === 0) return;

    const missingTexts = [];
    const seen = new Set();
    articles.forEach((article) => {
      if (article.title && !article.title_ru && !seen.has(article.title)) {
        seen.add(article.title);
        missingTexts.push(article.title);
      }
      if (article.snippet && !article.snippet_ru && !seen.has(article.snippet)) {
        seen.add(article.snippet);
        missingTexts.push(article.snippet);
      }
    });

    if (missingTexts.length === 0) return;

    const BATCH = 20;
    try {
      for (let offset = 0; offset < missingTexts.length; offset += BATCH) {
        if (activeSearchToken !== searchToken || !isTranslateEnabled()) return;
        const map = await translateBatchChunk(missingTexts.slice(offset, offset + BATCH));
        if (activeSearchToken !== searchToken) return;

        articles.forEach((article) => {
          let patched = false;
          if (!article.title_ru && article.title && map.has(article.title)) {
            article.title_ru = map.get(article.title);
            patched = true;
          }
          if (!article.snippet_ru && article.snippet && map.has(article.snippet)) {
            article.snippet_ru = map.get(article.snippet);
            patched = true;
          }
          if (patched && isTranslateEnabled() && activeSearchToken === searchToken) {
            patchCardTranslations(article);
          }
        });
      }
    } catch (err) {
      console.warn('Failed client-side batch translation', err);
    }
  }

  function createCard(article, highlightRegexes, translate = true, index = 0) {
    const col = document.createElement('div');
    col.className = 'news-grid-item';

    const articleKey = getArticleKey(article);
    const isFavorite = favoritesMemorySet.has(articleKey);
    const isTranslated = Boolean(translate && (article.title_ru || article.snippet_ru));
    const title = translate ? sanitizeString(article.title_ru || article.title) : sanitizeString(article.title);
    const snippet = translate ? sanitizeString(article.snippet_ru || article.snippet) : sanitizeString(article.snippet);
    const timeMeta = computeTimeMeta(article.publishedAt);
    const sourceTitle = sanitizeString(article.sourceTitle || article.source);
    const image = safeExternalUrl(article.imageUrl, SVG_PLACEHOLDER);

    const highlightedTitle = highlightMatchesWithRegexes(title, highlightRegexes);
    const highlightedSnippet = highlightMatchesWithRegexes(snippet, highlightRegexes);
    const safeImage = escapeHtml(image);
    const safeSourceTitle = escapeHtml(sourceTitle);
    const safeAlt = escapeHtml(title);
    const safeArticleKey = escapeHtml(articleKey);
    const favoriteIcon = isFavorite ? '★' : '☆';
    const eager = index < 2;
    const langBadge = isTranslated
      ? `<span class="news-card-badge news-card-badge--lang" title="Переведено на русский">RU</span>`
      : '';

    col.innerHTML = `
      <article
        class="news-card${isFavorite ? ' news-card--bookmarked' : ''}"
        data-article-key="${safeArticleKey}"
      >
        <div class="news-card-media">
          <button
            type="button"
            class="news-card-favorite"
            data-favorite-toggle="${safeArticleKey}"
            aria-pressed="${isFavorite}"
            aria-label="${isFavorite ? 'Убрать из избранного' : 'Добавить в избранное'}"
          ><span aria-hidden="true">${favoriteIcon}</span></button>
          <img src="${safeImage}" class="news-card-img" alt="${safeAlt}" loading="${eager ? 'eager' : 'lazy'}" decoding="async"${eager ? ' fetchpriority="high"' : ''}>
          <div class="news-card-badges">
            ${langBadge}
          </div>
        </div>
        <div class="news-card-body">
          <h3 class="news-card-title">
            <button type="button" class="news-card-open">${highlightedTitle}</button>
          </h3>
          <p class="news-card-text">${highlightedSnippet}</p>
        </div>
        <footer class="news-card-meta">
          <span class="news-meta-source">${safeSourceTitle}</span>
          <span title="${timeMeta.absolute}">${timeMeta.relative}</span>
        </footer>
      </article>
    `;

    bindImageFallback(col);
    return col;
  }

  async function fetchAndDisplayNews(options = {}) {
    const { initial = false, refresh = false } = options;
    const query = sanitizeString(topicInput?.value).trim();
    const source = getSelectedSource();
    const viewAll = isViewAllEnabled();
    const allSources = isAllSourcesEnabled();
    const translate = isTranslateEnabled();

    updateSaveSearchButtonState();
    renderFavoritesPanel();

    const hasRealCards = Boolean(newsContainer?.querySelector('.news-card:not(.news-card--skeleton)'));
    if (initial || !hasRealCards) {
      renderSkeletons();
    }

    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (source) params.set('source', source);
    if (viewAll) params.set('view_all', 'true');
    if (allSources) params.set('all_sources', 'true');
    if (refresh) params.set('refresh', 'true');
    if (currentCategory !== 'all') params.set('category', currentCategory);
    params.set('translate', translate ? 'true' : 'false');

    syncUrlFromState({ query, source, translate, viewAll, allSources, category: currentCategory });
    updateChipActiveState();

    if (activeSearchController) {
      activeSearchController.abort();
    }
    const requestController = new AbortController();
    activeSearchController = requestController;
    const searchToken = ++activeSearchToken;

    setLoading(true);
    searchFeedback.textContent = refresh ? 'Обновляем новости...' : 'Загрузка...';

    try {
      const response = await fetch(`/api/search?${params.toString()}`, {
        signal: requestController.signal
      });
      if (!response.ok) {
        let message = `Status ${response.status}`;
        try {
          const errBody = await response.json();
          if (errBody?.error) message = errBody.error;
        } catch { /* non-JSON error body */ }
        throw new Error(message);
      }
      const data = await response.json();
      if (!data?.ok || !Array.isArray(data.results)) {
        throw new Error(data?.error || 'Не удалось получить данные');
      }
      if (query) {
        recordSearchQuery(query);
      }
      renderArticles(data.results, { query, source }, searchToken);
      if (searchFeedback) {
        if (data.results.length > 0) {
          searchFeedback.textContent = formatSearchStatus(data);
        } else if (data.degraded) {
          searchFeedback.textContent = `${searchFeedback.textContent} ${formatSearchStatus(data)}`;
        }
      }
    } catch (error) {
      if (error.name === 'AbortError') return;
      const msg = error.message || 'Ошибка соединения.';
      searchFeedback.textContent = msg.includes('unavailable') || msg.includes('Status 503')
        ? 'Источники новостей временно недоступны.'
        : 'Ошибка соединения.';
      renderErrorState(msg.includes('unavailable')
        ? 'Попробуйте обновить позже.'
        : 'Проверьте подключение к сети и попробуйте снова.');
    } finally {
      if (activeSearchController === requestController) {
        activeSearchController = null;
        setLoading(false);
      }
    }
  }

  function getArticleFromCard(card) {
    if (!card) return null;
    const key = sanitizeString(card.dataset.articleKey).trim();
    if (key && clientArticlesByKey.has(key)) return clientArticlesByKey.get(key);
    return null;
  }

  // Input Debounce set to 450ms
  const throttledFetch = (() => {
    let timeoutId = null;
    return () => {
      updateSaveSearchButtonState();
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        fetchAndDisplayNews();
      }, 450);
    };
  })();

  searchForm?.addEventListener('submit', event => {
    event.preventDefault();
    fetchAndDisplayNews();
  });

  searchButton?.addEventListener('click', event => {
    event.preventDefault();
    fetchAndDisplayNews();
  });

  refreshButton?.addEventListener('click', event => {
    event.preventDefault();
    fetchAndDisplayNews({ refresh: true });
  });

  saveSearchButton?.addEventListener('click', event => {
    event.preventDefault();
    saveCurrentSearch();
  });

  topicInput?.addEventListener('input', throttledFetch);
  topicInput?.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      fetchAndDisplayNews();
    }
  });

  sourceSelect?.addEventListener('change', () => {
    pendingSourceFromUrl = '';
    if (sourceSelect.value) {
      setActiveCategory('all');
    }
    fetchAndDisplayNews();
  });

  quickChipsContainer?.addEventListener('click', event => {
    const button = event.target.closest('[data-quick-topic]');
    if (!button) return;
    const quickTopic = sanitizeString(button.dataset.quickTopic).trim();
    if (!quickTopic || !topicInput) return;
    topicInput.value = quickTopic;
    fetchAndDisplayNews();
  });

  savedSearchesContainer?.addEventListener('click', event => {
    const applyBtn = event.target.closest('[data-saved-search-apply]');
    if (applyBtn) {
      const id = sanitizeString(applyBtn.dataset.savedSearchApply).trim();
      const savedSearch = getSavedSearches().find(item => item.id === id);
      if (savedSearch) applySavedSearch(savedSearch);
      return;
    }
    const removeBtn = event.target.closest('[data-saved-search-remove]');
    if (removeBtn) {
      const id = sanitizeString(removeBtn.dataset.savedSearchRemove).trim();
      if (id) removeSavedSearch(id);
    }
  });

  newsContainer?.addEventListener('click', async event => {
    if (event.target.closest('[data-retry-search]')) {
      fetchAndDisplayNews({ refresh: true });
      return;
    }
    if (event.target.closest('[data-reset-filters]')) {
      resetToHome();
      return;
    }
    const favoriteToggle = event.target.closest('[data-favorite-toggle]');
    if (favoriteToggle) {
      const card = favoriteToggle.closest('.news-card');
      if (card) toggleFavoriteArticle(getArticleFromCard(card));
      return;
    }
    const card = event.target.closest('.news-card');
    if (card) {
      await openArticleModal(getArticleFromCard(card));
    }
  });

  favoritesListContainer?.addEventListener('click', async event => {
    const openBtn = event.target.closest('[data-favorite-open]');
    if (openBtn) {
      const key = sanitizeString(openBtn.dataset.favoriteOpen).trim();
      const fav = findFavoriteArticle(key);
      if (fav) await openArticleModal(fav);
      return;
    }
    const removeBtn = event.target.closest('[data-favorite-remove]');
    if (removeBtn) {
      const key = sanitizeString(removeBtn.dataset.favoriteRemove).trim();
      if (key) removeFavoriteArticle(key);
    }
  });

  translateToggle?.addEventListener('change', async () => {
    updateSaveSearchButtonState();
    if (clientArticlesCache.length > 0) {
      const translate = isTranslateEnabled();
      renderArticles(clientArticlesCache, {
        query: sanitizeString(topicInput?.value).trim(),
        source: sanitizeString(sourceSelect?.value).trim()
      });
      if (translate) {
        await ensureArticlesTranslated(clientArticlesCache);
      }
    } else {
      fetchAndDisplayNews();
    }
  });

  viewAllToggle?.addEventListener('change', () => {
    updateSaveSearchButtonState();
    fetchAndDisplayNews();
  });

  allSourcesToggle?.addEventListener('change', () => {
    if (isAllSourcesEnabled()) {
      setActiveCategory('all');
      if (sourceSelect) sourceSelect.value = '';
      pendingSourceFromUrl = '';
    }
    updateSaveSearchButtonState();
    fetchAndDisplayNews();
  });

  function resetToHome() {
    if (topicInput) topicInput.value = '';
    if (sourceSelect) sourceSelect.value = '';
    pendingSourceFromUrl = '';
    if (viewAllToggle) viewAllToggle.checked = false;
    if (allSourcesToggle) allSourcesToggle.checked = false;
    setActiveCategory('all');
    fetchAndDisplayNews();
  }

  brandHome?.addEventListener('click', (event) => {
    event.preventDefault();
    resetToHome();
  });

  document.addEventListener('keydown', event => {
    if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !isEditableTarget(event.target)) {
      event.preventDefault();
      topicInput?.focus();
      topicInput?.select();
    }
  });

  layoutGridBtn?.addEventListener('click', () => {
    currentLayout = 'grid';
    safeStorageSet('news-aggregator.layout', 'grid');
    updateLayoutView();
  });

  layoutListBtn?.addEventListener('click', () => {
    currentLayout = 'list';
    safeStorageSet('news-aggregator.layout', 'list');
    updateLayoutView();
  });

  statsToggleBtn?.addEventListener('click', () => {
    const isHidden = statsDashboard?.classList.toggle('d-none');
    statsToggleBtn?.classList.toggle('active', !isHidden);
    statsToggleBtn?.setAttribute('aria-expanded', String(!isHidden));
    if (!isHidden && clientArticlesCache.length > 0) {
      buildStatsDashboard(clientArticlesCache);
    }
  });

  statsCloseBtn?.addEventListener('click', () => {
    statsDashboard?.classList.add('d-none');
    statsToggleBtn?.classList.remove('active');
    statsToggleBtn?.setAttribute('aria-expanded', 'false');
  });

  categoryTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const next = tab.dataset.category || 'all';
      setActiveCategory(next);

      if (next !== 'all' && sourceSelect) {
        sourceSelect.value = '';
        pendingSourceFromUrl = '';
      }

      fetchAndDisplayNews();
    });
  });

  categoryTablist?.addEventListener('keydown', (event) => {
    const tabs = Array.from(categoryTabs);
    const currentIndex = tabs.indexOf(event.target);
    if (currentIndex < 0) return;

    let nextIndex = -1;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else return;

    event.preventDefault();
    tabs[nextIndex].focus();
    tabs[nextIndex].click();
  });

  syncStateFromUrl();
  renderSavedSearches();
  renderQuickChips();
  updateLayoutView();
  renderSkeletons();
  fetchAndDisplayNews({ initial: true });
  loadSourceCatalog();
});
