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
  const quickTopicButtons = document.querySelectorAll('[data-quick-topic]');
  const saveSearchButton = document.getElementById('save-search-button');
  const savedSearchesContainer = document.getElementById('saved-searches-list');
  const savedSearchesStorageKey = 'news-aggregator.saved-searches';
  const maxSavedSearches = 8;
  const favoritesListContainer = document.getElementById('favorites-list');
  const favoritesCountElement = document.getElementById('favorites-count');
  const favoritesStorageKey = 'news-aggregator.favorites';
  const maxFavorites = 24;

  // Theme Toggle Elements
  const themeToggleBtn = document.getElementById('theme-toggle-btn');

  // Inline SVG Placeholder data-URI to replace external network requests (no picsum)
  const SVG_PLACEHOLDER = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="%231c1c1e"/><stop offset="100%" stop-color="%232c2c2e"/></linearGradient></defs><rect width="800" height="500" fill="url(%23g)"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="%238e8e93" font-family="-apple-system, sans-serif" font-size="28" font-weight="600">News Aggregator</text></svg>`;

  // Modern UI DOM references
  const categoryTabs = document.querySelectorAll('.category-tab');
  const layoutGridBtn = document.getElementById('layout-grid-btn');
  const layoutListBtn = document.getElementById('layout-list-btn');
  const statsToggleBtn = document.getElementById('stats-toggle-btn');
  const statsDashboard = document.getElementById('stats-dashboard');
  const statsCloseBtn = document.getElementById('stats-close-btn');
  const statsKeywords = document.getElementById('stats-keywords');
  const statsSources = document.getElementById('stats-sources');

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
  let clientArticlesCache = [];
  /** @type {Map<string, string>} Article key → fullText store */
  const fullTextStore = new Map();
  /** @type {Set<string>} Memory cache of favorite article keys for O(1) checks */
  let favoritesMemorySet = new Set();

  let currentCategory = 'all';
  let currentLayout = localStorage.getItem('news-aggregator.layout') || 'grid';

  const CATEGORY_MAP = {
    tech: ['techcrunch', 'verge', 'wired', 'engadget', 'arstechnica', 'hackernews', 'bbc_tech', 'nyt_tech', 'bloomberg_tech'],
    business: ['forbes', 'bbc_business', 'axios'],
    world: ['nyt_world', 'reddit_news', 'politico', 'bbc', 'nyt', 'guardian', 'cnn', 'aljazeera', 'npr', 'reuters_world'],
    science: ['sciencedaily', 'nature', 'phys', 'space'],
    culture: ['atlantic', 'newyorker'],
    sports: ['espn']
  };

  // Initialize Theme
  const savedTheme = localStorage.getItem('news-aggregator.theme');
  if (savedTheme) {
    document.documentElement.setAttribute('data-theme', savedTheme);
  }
  updateThemeIcons();

  function updateThemeIcons() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark' ||
      (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches);
    
    const sunIcon = themeToggleBtn?.querySelector('.theme-icon-sun');
    const moonIcon = themeToggleBtn?.querySelector('.theme-icon-moon');
    
    if (sunIcon && moonIcon) {
      sunIcon.classList.toggle('d-none', !isDark);
      moonIcon.classList.toggle('d-none', isDark);
    }
  }

  themeToggleBtn?.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('news-aggregator.theme', next);
    updateThemeIcons();
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
    if (!storage) return;

    storage.setItem(key, JSON.stringify(value));
  }

  function generateId(prefix = 'item') {
    if (window.crypto?.randomUUID) {
      return `${prefix}-${window.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function getCurrentSearchState() {
    return {
      query: sanitizeString(topicInput?.value).trim(),
      source: sanitizeString(sourceSelect?.value).trim(),
      translate: isTranslateEnabled(),
      viewAll: isViewAllEnabled()
    };
  }

  function hasSavableSearchState(state = getCurrentSearchState()) {
    return Boolean(state.query || state.source || !state.translate || state.viewAll);
  }

  function normalizeSavedSearchState(state) {
    return {
      query: sanitizeString(state?.query).trim(),
      source: sanitizeString(state?.source).trim(),
      translate: Boolean(state?.translate),
      viewAll: Boolean(state?.viewAll)
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

  function storeSavedSearches(savedSearches) {
    writeJsonList(savedSearchesStorageKey, savedSearches.slice(0, maxSavedSearches));
  }

  function findMatchingSavedSearch(state) {
    const normalized = normalizeSavedSearchState(state);
    return getSavedSearches().find(item => (
      item.query === normalized.query &&
      item.source === normalized.source &&
      item.translate === normalized.translate &&
      item.viewAll === normalized.viewAll
    ));
  }

  function getSourceLabel(source) {
    if (!source) return 'Все источники';
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
    if (savedSearch?.viewAll) parts.push('Все материалы');
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
    if (savedSearch?.viewAll) parts.push('Показаны все материалы');

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

    if (!savedSearches.length) {
      savedSearchesContainer.innerHTML = `
        <p class="saved-searches__empty">Пока ничего не сохранено. Нажмите кнопку выше, чтобы закрепить текущий поиск.</p>
      `;
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
      searchFeedback.textContent = 'Сначала введите запрос или выберите фильтры, которые хотите сохранить.';
      updateSaveSearchButtonState();
      return;
    }

    const savedSearches = getSavedSearches();
    const matchingIndex = savedSearches.findIndex(item => (
      item.query === currentState.query &&
      item.source === currentState.source &&
      item.translate === currentState.translate &&
      item.viewAll === currentState.viewAll
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
    searchFeedback.textContent = 'Поиск сохранён.';
  }

  function applySavedSearch(savedSearch) {
    if (topicInput) topicInput.value = savedSearch.query || '';
    if (sourceSelect) sourceSelect.value = savedSearch.source || '';
    if (translateToggle) translateToggle.checked = Boolean(savedSearch.translate);
    if (viewAllToggle) viewAllToggle.checked = Boolean(savedSearch.viewAll);

    topicInput?.focus();
    topicInput?.select();
    renderSavedSearches();
    fetchAndDisplayNews({ refresh: true });
  }

  function removeSavedSearch(savedSearchId) {
    const nextSavedSearches = getSavedSearches().filter(item => item.id !== savedSearchId);
    storeSavedSearches(nextSavedSearches);
    renderSavedSearches();
    searchFeedback.textContent = 'Сохранённый поиск удалён.';
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
    const list = readJsonList(favoritesStorageKey)
      .map(item => normalizeFavoriteArticle(item))
      .filter(item => item.key)
      .sort((left, right) => new Date(right.savedAt).getTime() - new Date(left.savedAt).getTime());
    
    // Refresh in-memory Set
    favoritesMemorySet = new Set(list.map(item => item.key));
    return list;
  }

  function storeFavoriteArticles(favoriteArticles) {
    writeJsonList(favoritesStorageKey, favoriteArticles.slice(0, maxFavorites));
    favoritesMemorySet = new Set(favoriteArticles.map(item => item.key));
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

  function renderFavoritesPanel() {
    if (!favoritesListContainer) return;
    const favoriteArticles = getFavoriteArticles();
    updateFavoriteCount(favoriteArticles.length);

    if (!favoriteArticles.length) {
      favoritesListContainer.innerHTML = `
        <p class="favorites-empty">Нажмите ☆ в карточке новости, чтобы сохранить ее на потом.</p>
      `;
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
            <img src="${image}" class="favorite-item__thumb" alt="${title}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${SVG_PLACEHOLDER}';">
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
    searchFeedback.textContent = 'Статья добавлена в избранное.';
  }

  function removeFavoriteArticle(articleKey, feedbackMessage = 'Статья удалена из избранного.') {
    const nextFavorites = getFavoriteArticles().filter(item => item.key !== articleKey);
    storeFavoriteArticles(nextFavorites);
    syncFavoriteButtonState(articleKey);
    renderFavoritesPanel();
    if (feedbackMessage) searchFeedback.textContent = feedbackMessage;
  }

  // Open native HTML5 <dialog> modal
  async function openArticleModal(article) {
    if (!newsModal) return;

    const articleKey = getArticleKey(article);
    const sourceKey = sanitizeString(article?.source).trim();
    const idKey = sanitizeString(article?.id).trim();

    let fullText = fullTextStore.get(articleKey) || sanitizeString(article?.fullText).trim();
    const translate = isTranslateEnabled();

    // Show initial skeleton in modal
    const title = sanitizeString(article?.title || article?.title_ru || article?.titleRu).trim() || 'Загрузка...';
    const sourceTitle = sanitizeString(article?.sourceTitle || article?.source).trim() || 'Источник';
    const timeMeta = computeTimeMeta(article?.publishedAt);
    const imageSrc = safeExternalUrl(article?.imageUrl || article?.imageSrc, SVG_PLACEHOLDER);
    const link = safeExternalUrl(article?.link, '#');

    newsModalLabel.textContent = title;
    newsModalBody.innerHTML = `
      <div class="modal-article">
        ${imageSrc ? `<img src="${escapeHtml(imageSrc)}" class="modal-article-img" alt="${escapeHtml(title)}" loading="lazy">` : ''}
        <div class="modal-article-meta mb-3">
          <span class="badge">${escapeHtml(sourceTitle)}</span>
          <span>${escapeHtml(timeMeta.relative)}</span>
        </div>
        <p class="modal-article-text" id="modal-text-content">Загружаем текст статьи...</p>
        <p><a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Читать в оригинале ↗</a></p>
      </div>
    `;

    newsModal.showModal();

    // Fetch fullText from /api/article if not present in client memory
    if (!fullText && sourceKey && idKey) {
      try {
        const resp = await fetch(`/api/article?source=${encodeURIComponent(sourceKey)}&id=${encodeURIComponent(idKey)}&translate=${translate}`);
        const data = await resp.json();
        if (data?.ok && data.article?.fullText) {
          fullText = data.article.fullText_ru || data.article.fullText;
          fullTextStore.set(articleKey, data.article.fullText);
        }
      } catch (err) {}
    }

    if (!fullText) {
      fullText = article?.snippet_ru || article?.snippet || 'Полный текст недоступен для этой новости.';
    } else if (translate && !article?.fullText_ru) {
      fullText = await translateViaApi(fullText);
    }

    const textEl = document.getElementById('modal-text-content');
    if (textEl) {
      textEl.textContent = fullText;
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

  function syncStateFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q');
    const source = params.get('source');

    if (topicInput && q !== null) topicInput.value = q;
    if (sourceSelect && source !== null) sourceSelect.value = source;
    if (translateToggle) translateToggle.checked = parseBooleanParam(params.get('translate'), true);
    if (viewAllToggle) viewAllToggle.checked = parseBooleanParam(params.get('view_all'), false);
  }

  function syncUrlFromState({ query, source, translate, viewAll }) {
    const url = new URL(window.location.href);

    if (query) url.searchParams.set('q', query);
    else url.searchParams.delete('q');

    if (source) url.searchParams.set('source', source);
    else url.searchParams.delete('source');

    if (!translate) url.searchParams.set('translate', 'false');
    else url.searchParams.delete('translate');

    if (viewAll) url.searchParams.set('view_all', 'true');
    else url.searchParams.delete('view_all');

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
    newsContainer.innerHTML = `
      <div style="grid-column: 1 / -1; padding: 40px; text-align: center;">
        <h3>Ничего не найдено</h3>
        <p style="color: var(--text-secondary); margin-top: 8px;">Попробуйте изменить ключевые слова или сбросить фильтры.</p>
      </div>
    `;
  }

  function renderErrorState(message) {
    if (!newsContainer) return;
    newsContainer.innerHTML = `
      <div style="grid-column: 1 / -1; padding: 40px; text-align: center;">
        <h3>Ошибка загрузки</h3>
        <p style="color: var(--text-secondary); margin-top: 8px;">${escapeHtml(message)}</p>
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

  function setLoading(isLoading) {
    if (!loadingIndicator) return;
    loadingIndicator.classList.toggle('d-none', !isLoading);
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
    if (currentLayout === 'list') {
      newsContainer.classList.add('view-list');
      layoutListBtn?.classList.add('active');
      layoutGridBtn?.classList.remove('active');
    } else {
      newsContainer.classList.remove('view-list');
      layoutListBtn?.classList.remove('active');
      layoutGridBtn?.classList.add('active');
    }
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

  function renderArticles(articles, { query, source }) {
    const highlightTokens = splitIntoTokens(query);
    const highlightRegexes = highlightTokens.map(token => ({
      token,
      re: new RegExp(`(${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
    }));
    const translate = isTranslateEnabled();

    if (articles && articles.length > 0) {
      clientArticlesCache = articles;
      articles.forEach(article => {
        const key = getArticleKey(article);
        if (key && article.fullText) fullTextStore.set(key, article.fullText);
      });
      buildStatsDashboard(articles);
    }

    let filteredArticles = articles;
    if (currentCategory !== 'all') {
      const allowedSources = CATEGORY_MAP[currentCategory] || [];
      filteredArticles = articles.filter(art => allowedSources.includes(art.source));
    }

    if (!Array.isArray(filteredArticles) || filteredArticles.length === 0) {
      searchFeedback.textContent = query ? `Ничего не найдено по запросу «${query}».` : 'Нет материалов в выбранной категории.';
      renderEmptyState(query, source);
      return;
    }

    searchFeedback.textContent = `Показаны ${filteredArticles.length} материалов.`;
    newsContainer.innerHTML = '';
    
    // Ensure memory set is loaded
    getFavoriteArticles();

    const fragment = document.createDocumentFragment();
    filteredArticles.forEach(article => {
      fragment.appendChild(createCard(article, highlightRegexes, translate));
    });
    newsContainer.appendChild(fragment);
    updateLayoutView();
  }

  function createCard(article, highlightRegexes, translate = true) {
    const col = document.createElement('div');
    col.className = 'news-grid-item';

    const articleKey = getArticleKey(article);
    const isFavorite = favoritesMemorySet.has(articleKey);
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

    const readingTime = getReadingTime(snippet, translate);

    col.innerHTML = `
      <article
        class="news-card${isFavorite ? ' news-card--bookmarked' : ''}"
        tabindex="0"
        role="button"
        data-article-key="${safeArticleKey}"
      >
        <div class="news-card-media">
          <button
            type="button"
            class="news-card-favorite"
            data-favorite-toggle="${safeArticleKey}"
            aria-pressed="${isFavorite}"
          ><span>${favoriteIcon}</span></button>
          <img src="${safeImage}" class="news-card-img" alt="${safeAlt}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${SVG_PLACEHOLDER}';">
          <span class="news-card-badge">${safeSourceTitle}</span>
        </div>
        <div class="news-card-body">
          <h3 class="news-card-title">${highlightedTitle}</h3>
          <p class="news-card-text">${highlightedSnippet}</p>
        </div>
        <footer class="news-card-meta">
          <span class="news-meta-source">${safeSourceTitle}</span>
          <div>
            <span>${readingTime} мин</span> · 
            <span title="${timeMeta.absolute}">${timeMeta.relative}</span>
          </div>
        </footer>
      </article>
    `;

    return col;
  }

  async function fetchAndDisplayNews(options = {}) {
    const { initial = false, refresh = false } = options;
    const query = sanitizeString(topicInput?.value).trim();
    const source = sanitizeString(sourceSelect?.value);
    const viewAll = isViewAllEnabled();
    const translate = isTranslateEnabled();

    updateSaveSearchButtonState();
    renderFavoritesPanel();

    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (source) params.set('source', source);
    if (viewAll) params.set('view_all', 'true');
    if (refresh) params.set('refresh', 'true');
    if (currentCategory !== 'all') params.set('category', currentCategory);

    syncUrlFromState({ query, source, translate, viewAll });

    if (activeSearchController) {
      activeSearchController.abort();
    }
    const requestController = new AbortController();
    activeSearchController = requestController;

    setLoading(true);
    searchFeedback.textContent = refresh ? 'Обновляем новости...' : 'Загрузка...';

    try {
      const response = await fetch(`/api/search?${params.toString()}`, {
        signal: requestController.signal
      });
      if (!response.ok) throw new Error(`Status ${response.status}`);
      const data = await response.json();
      if (!data?.ok || !Array.isArray(data.results)) {
        throw new Error(data?.error || 'Не удалось получить данные');
      }
      renderArticles(data.results, { query, source });
    } catch (error) {
      if (error.name === 'AbortError') return;
      searchFeedback.textContent = 'Ошибка соединения.';
      renderErrorState('Проверьте подключение к сети и попробуйте снова.');
    } finally {
      if (activeSearchController === requestController) {
        activeSearchController = null;
      }
      setLoading(false);
    }
  }

  function getArticleFromCard(card) {
    if (!card) return null;
    const key = sanitizeString(card.dataset.articleKey).trim();
    if (key) {
      const cached = clientArticlesCache.find(a => getArticleKey(a) === key);
      if (cached) return cached;
    }
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
    if (sourceSelect.value) {
      categoryTabs.forEach(t => t.classList.toggle('active', t.dataset.category === 'all'));
      currentCategory = 'all';
    }
    fetchAndDisplayNews();
  });

  quickTopicButtons.forEach(button => {
    button.addEventListener('click', () => {
      const quickTopic = sanitizeString(button.dataset.quickTopic).trim();
      if (!quickTopic || !topicInput) return;
      topicInput.value = quickTopic;
      fetchAndDisplayNews();
    });
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

  translateToggle?.addEventListener('change', () => {
    updateSaveSearchButtonState();
    if (clientArticlesCache.length > 0) {
      renderArticles(clientArticlesCache, {
        query: sanitizeString(topicInput?.value).trim(),
        source: sanitizeString(sourceSelect?.value).trim()
      });
    } else {
      fetchAndDisplayNews();
    }
  });

  viewAllToggle?.addEventListener('change', () => {
    updateSaveSearchButtonState();
    fetchAndDisplayNews();
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
    localStorage.setItem('news-aggregator.layout', 'grid');
    updateLayoutView();
  });

  layoutListBtn?.addEventListener('click', () => {
    currentLayout = 'list';
    localStorage.setItem('news-aggregator.layout', 'list');
    updateLayoutView();
  });

  statsToggleBtn?.addEventListener('click', () => {
    const isHidden = statsDashboard?.classList.toggle('d-none');
    statsToggleBtn?.classList.toggle('active', !isHidden);
  });

  statsCloseBtn?.addEventListener('click', () => {
    statsDashboard?.classList.add('d-none');
    statsToggleBtn?.classList.remove('active');
  });

  categoryTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      categoryTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentCategory = tab.dataset.category || 'all';

      if (currentCategory !== 'all' && sourceSelect) {
        sourceSelect.value = '';
      }

      if (clientArticlesCache && clientArticlesCache.length > 0) {
        renderArticles(clientArticlesCache, {
          query: sanitizeString(topicInput?.value).trim(),
          source: sanitizeString(sourceSelect?.value).trim()
        });
      } else {
        fetchAndDisplayNews();
      }
    });
  });

  syncStateFromUrl();
  renderSavedSearches();
  updateLayoutView();
  fetchAndDisplayNews({ initial: true });
});
