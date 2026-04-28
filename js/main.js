document.addEventListener('DOMContentLoaded', () => {
  const searchForm = document.getElementById('search-form');
  const searchButton = document.getElementById('search-button');
  const refreshButton = document.getElementById('refresh-button');
  const newsContainer = document.getElementById('news-container');
  const newsModalElement = document.getElementById('news-modal');
  const newsModal = newsModalElement ? new bootstrap.Modal(newsModalElement) : null;
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

    if (savedSearch?.query) {
      parts.push(sourceLabel);
    } else if (savedSearch?.source || sourceLabel) {
      parts.push(sourceLabel);
    }

    if (savedSearch?.viewAll) {
      parts.push('Все материалы');
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

    if (savedAtLabel) {
      parts.push(`Сохранено: ${savedAtLabel}`);
    }
    if (savedSearch?.query) {
      parts.push(`Запрос: ${savedSearch.query}`);
    }
    if (savedSearch?.source) {
      parts.push(`Источник: ${getSourceLabel(savedSearch.source)}`);
    }
    parts.push(savedSearch?.translate ? 'Перевод на русский' : 'Оригинал');
    if (savedSearch?.viewAll) {
      parts.push('Показаны все материалы');
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

    if (!savedSearches.length) {
      savedSearchesContainer.innerHTML = `
        <p class="saved-searches__empty">Пока ничего не сохранено. Нажмите кнопку справа, чтобы закрепить текущий поиск и возвращаться к нему одним кликом.</p>
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
    searchFeedback.textContent = 'Поиск сохранён. Он доступен в блоке ниже.';
  }

  function applySavedSearch(savedSearch) {
    if (topicInput) {
      topicInput.value = savedSearch.query || '';
    }
    if (sourceSelect) {
      sourceSelect.value = savedSearch.source || '';
    }
    if (translateToggle) {
      translateToggle.checked = Boolean(savedSearch.translate);
    }
    if (viewAllToggle) {
      viewAllToggle.checked = Boolean(savedSearch.viewAll);
    }

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

    if (id) return id;
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
      imageUrl: safeExternalUrl(article?.imageUrl, ''),
      source: sanitizeString(article?.source).trim(),
      sourceTitle: sanitizeString(article?.sourceTitle || article?.source).trim(),
      publishedAt: sanitizeString(article?.publishedAt).trim(),
      fullText: sanitizeString(article?.fullText).trim(),
      savedAt: sanitizeString(article?.savedAt).trim() || new Date().toISOString()
    };
  }

  function getFavoriteArticles() {
    return readJsonList(favoritesStorageKey)
      .map(item => normalizeFavoriteArticle(item))
      .filter(item => item.key)
      .sort((left, right) => new Date(right.savedAt).getTime() - new Date(left.savedAt).getTime());
  }

  function storeFavoriteArticles(favoriteArticles) {
    writeJsonList(favoritesStorageKey, favoriteArticles.slice(0, maxFavorites));
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

  function getFavoriteArticleTooltip(favoriteArticle) {
    const savedAt = sanitizeString(favoriteArticle?.savedAt).trim();
    const savedAtLabel = savedAt && !Number.isNaN(new Date(savedAt).getTime())
      ? savedSearchTimeFormatter.format(new Date(savedAt))
      : '';
    const parts = [];

    if (savedAtLabel) {
      parts.push(`Добавлено: ${savedAtLabel}`);
    }
    if (favoriteArticle?.sourceTitle || favoriteArticle?.source) {
      parts.push(`Источник: ${sanitizeString(favoriteArticle.sourceTitle || favoriteArticle.source)}`);
    }
    if (favoriteArticle?.publishedAt) {
      parts.push(`Опубликовано: ${computeTimeMeta(favoriteArticle.publishedAt).absolute || favoriteArticle.publishedAt}`);
    }
    return parts.join(' · ');
  }

  function updateFavoriteCount(count) {
    if (!favoritesCountElement) return;

    favoritesCountElement.textContent = `${count} ${formatRussianCount(count, ['статья', 'статьи', 'статей'])}`;
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

    updateFavoriteButton(card, Boolean(findFavoriteArticle(articleKey)));
  }

  function renderFavoritesPanel() {
    if (!favoritesListContainer) return;

    const favoriteArticles = getFavoriteArticles();
    updateFavoriteCount(favoriteArticles.length);

    if (!favoriteArticles.length) {
      favoritesListContainer.innerHTML = `
        <p class="favorites-empty">Нажмите на ☆ в карточке новости, чтобы добавить ее в избранное и открыть позже.</p>
      `;
      return;
    }

    favoritesListContainer.innerHTML = favoriteArticles.map(favoriteArticle => {
      const articleKey = escapeHtml(favoriteArticle.key);
      const title = escapeHtml(getFavoriteArticleTitle(favoriteArticle));
      const meta = escapeHtml(getFavoriteArticleMeta(favoriteArticle));
      const tooltip = escapeHtml(getFavoriteArticleTooltip(favoriteArticle));
      const sourceSeed = sanitizeString(favoriteArticle.source || 'news');
      const fallbackImage = `https://picsum.photos/seed/${encodeURIComponent(`${sourceSeed}-favorite`)}/160/160`;
      const image = escapeHtml(safeExternalUrl(favoriteArticle.imageUrl, fallbackImage));
      const safeFallback = escapeHtml(fallbackImage);

      return `
        <div class="favorite-item" data-favorite-key="${articleKey}">
          <button
            type="button"
            class="favorite-item__preview"
            data-favorite-open="${articleKey}"
            title="${tooltip}"
          >
            <img src="${image}" class="favorite-item__thumb" alt="${title}" onerror="this.onerror=null;this.src='${safeFallback}';">
            <span class="favorite-item__content">
              <span class="favorite-item__title">${title}</span>
              <span class="favorite-item__meta">${meta}</span>
            </span>
          </button>
          <button
            type="button"
            class="favorite-item__remove"
            data-favorite-remove="${articleKey}"
            aria-label="Удалить из избранного «${title}»"
            title="Удалить из избранного"
          >×</button>
        </div>
      `;
    }).join('');
  }

  function buildFavoriteSnapshot(article) {
    return normalizeFavoriteArticle({
      ...article,
      savedAt: new Date().toISOString()
    });
  }

  function toggleFavoriteArticle(article) {
    const articleKey = getArticleKey(article);
    if (!articleKey) return;

    const existingFavorite = findFavoriteArticle(articleKey);
    if (existingFavorite) {
      removeFavoriteArticle(articleKey, 'Статья удалена из избранного.');
      return;
    }

    const favorites = getFavoriteArticles();
    const nextFavorite = buildFavoriteSnapshot(article);
    const nextFavorites = [
      nextFavorite,
      ...favorites.filter(item => item.key !== articleKey)
    ].slice(0, maxFavorites);

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
    if (feedbackMessage) {
      searchFeedback.textContent = feedbackMessage;
    }
  }

  async function openArticleModal(article) {
    if (!newsModal) return;

    const fullText = sanitizeString(article?.fullText).trim();
    const translate = isTranslateEnabled();
    const translatedFull = (fullText && translate)
      ? await translateViaApi(fullText)
      : (fullText || 'Полный текст недоступен для этой заметки.');
    const title = sanitizeString(article?.title || article?.titleRu).trim() || 'Без названия';
    const sourceTitle = sanitizeString(article?.sourceTitle || article?.source).trim() || 'Источник не указан';
    const publishedAt = sanitizeString(article?.publishedAt).trim();
    const timeMeta = computeTimeMeta(publishedAt);
    const imageSrc = safeExternalUrl(article?.imageSrc || article?.imageUrl, '');
    const link = safeExternalUrl(article?.link, '#');

    newsModalLabel.textContent = title;
    const safeImageSrc = escapeHtml(imageSrc || '');
    const safeSourceTitle = escapeHtml(sourceTitle);
    const safeAbsolute = escapeHtml(timeMeta.absolute);
    const safeRelative = escapeHtml(timeMeta.relative);
    const safeTranslatedFull = escapeHtml(translatedFull);
    const safeLink = escapeHtml(link);
    const safeAltTitle = escapeHtml(title);

    newsModalBody.innerHTML = `
      <div class="modal-article">
        <div class="modal-article-media mb-3">
          <img src="${safeImageSrc}" class="img-fluid modal-article-img" alt="${safeAltTitle}" loading="lazy">
        </div>
        <div class="modal-article-meta mb-3">
          <span class="modal-article-source badge text-bg-dark">${safeSourceTitle}</span>
          <span class="modal-article-time" title="${safeAbsolute}">${safeRelative}</span>
        </div>
        <p class="modal-article-text">${safeTranslatedFull}</p>
        <p><a href="${safeLink}" target="_blank" rel="noopener noreferrer">Читать в оригинале</a></p>
      </div>
    `;

    newsModal.show();
  }

  function syncStateFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q');
    const source = params.get('source');

    if (topicInput && q !== null) {
      topicInput.value = q;
    }

    if (sourceSelect && source !== null) {
      sourceSelect.value = source;
    }

    if (translateToggle) {
      translateToggle.checked = parseBooleanParam(params.get('translate'), true);
    }

    if (viewAllToggle) {
      viewAllToggle.checked = parseBooleanParam(params.get('view_all'), false);
    }
  }

  function syncUrlFromState({ query, source, translate, viewAll }) {
    const url = new URL(window.location.href);

    if (query) {
      url.searchParams.set('q', query);
    } else {
      url.searchParams.delete('q');
    }

    if (source) {
      url.searchParams.set('source', source);
    } else {
      url.searchParams.delete('source');
    }

    if (translate) {
      url.searchParams.delete('translate');
    } else {
      url.searchParams.set('translate', 'false');
    }

    if (viewAll) {
      url.searchParams.set('view_all', 'true');
    } else {
      url.searchParams.delete('view_all');
    }

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

  function decodeURIComponentSafe(value) {
    const safeValue = sanitizeString(value);
    if (!safeValue) return '';

    try {
      return decodeURIComponent(safeValue);
    } catch (error) {
      return safeValue;
    }
  }

  function renderSkeletons(count = 6) {
    if (!newsContainer) return;

    const fragment = document.createDocumentFragment();

    for (let index = 0; index < count; index += 1) {
      const item = document.createElement('div');
      item.className = 'news-grid-item';
      item.innerHTML = `
        <article class="news-card news-card--skeleton skeleton-card" aria-hidden="true">
          <div class="news-card-media skeleton-block skeleton-media"></div>
          <div class="news-card-body">
            <span class="skeleton-pill"></span>
            <span class="skeleton-line skeleton-line--title"></span>
            <span class="skeleton-line"></span>
            <span class="skeleton-line skeleton-line--short"></span>
          </div>
          <footer class="news-card-meta skeleton-footer">
            <span class="skeleton-pill" style="width: 92px;"></span>
            <span class="skeleton-pill" style="width: 68px;"></span>
          </footer>
        </article>
      `;
      fragment.appendChild(item);
    }

    newsContainer.innerHTML = '';
    newsContainer.appendChild(fragment);
  }

  function renderStateCard({ eyebrow, title, text, actions = [] }) {
    if (!newsContainer) return;

    const actionsHtml = actions
      .map(action => `<button type="button" class="state-action" data-state-action="${escapeHtml(action.id)}">${escapeHtml(action.label)}</button>`)
      .join('');

    newsContainer.innerHTML = `
      <div class="news-grid-item news-grid-item--full">
        <section class="news-state">
          <p class="news-state__eyebrow">${escapeHtml(eyebrow)}</p>
          <h3 class="news-state__title">${escapeHtml(title)}</h3>
          <p class="news-state__text">${escapeHtml(text)}</p>
          ${actionsHtml ? `<div class="news-state__actions">${actionsHtml}</div>` : ''}
        </section>
      </div>
    `;
  }

  function renderEmptyState(query, source) {
    const hasFilters = Boolean(query || source);
    const title = hasFilters
      ? 'По текущему запросу пока ничего не найдено'
      : 'Пока нет новостей для показа';
    const text = hasFilters
      ? 'Попробуйте более широкий запрос, смените источник или выберите одну из быстрых тем выше.'
      : 'Выберите тему, источник или нажмите на быстрый запрос, чтобы начать.';

    const actions = [];
    if (hasFilters) {
      actions.push({ id: 'clear-filters', label: 'Сбросить фильтры' });
    }
    actions.push({ id: 'refresh-feed', label: 'Обновить ленту' });

    renderStateCard({
      eyebrow: 'Пустая выдача',
      title,
      text,
      actions
    });
  }

  function renderErrorState(message) {
    renderStateCard({
      eyebrow: 'Ошибка загрузки',
      title: 'Не удалось получить новости',
      text: message,
      actions: [
        { id: 'retry-search', label: 'Повторить' },
        { id: 'clear-filters', label: 'Сбросить фильтры' }
      ]
    });
  }

  function splitIntoTokens(query) {
    return sanitizeString(query)
      .toLowerCase()
      .split(/[\s,.;:!?"'()\[\]{}<>/@#%^&*+=|~`]+/)
      .map(token => token.trim())
      .filter(token => token.length > 2);
  }

  function highlightMatches(text, tokens) {
    const safeText = escapeHtml(text);
    if (!safeText || !tokens.length) return safeText;
    return tokens.reduce((acc, token) => {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(${escaped})`, 'gi');
      return acc.replace(regex, '<mark class="news-highlight">$1</mark>');
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

    return {
      relative,
      absolute: absoluteTimeFormatter.format(parsed)
    };
  }

  function setLoading(isLoading, skeletonCount = 6) {
    if (!loadingIndicator) return;
    loadingIndicator.classList.toggle('d-none', !isLoading);
    if (isLoading) {
      loadingIndicator.setAttribute('aria-busy', 'true');
      renderSkeletons(skeletonCount);
    } else {
      loadingIndicator.removeAttribute('aria-busy');
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
    if (!safeText) return 'Полный текст недоступен для этой заметки.';

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 8000);

    try {
      const resp = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: safeText, to: 'ru' }),
        signal: controller.signal
      });
      const data = await resp.json();
      if (data?.ok && data.translated) {
        return data.translated;
      }
    } catch (error) {
      console.warn('Translation API failed', error);
    } finally {
      window.clearTimeout(timeoutId);
    }

    return safeText;
  }

  function renderArticles(articles, { query, source }) {
    const messageParts = [];
    const highlightTokens = splitIntoTokens(query);
    const translate = isTranslateEnabled();

    if (!Array.isArray(articles) || articles.length === 0) {
      if (query) {
        searchFeedback.textContent = `Мы не нашли материалов по запросу «${query}». Попробуйте переформулировать или выбрать другой источник.`;
      } else {
        searchFeedback.textContent = 'Пока свежих новостей нет. Попробуйте выбрать конкретный источник или обновите позже.';
      }
      renderEmptyState(query, source);
      document.title = query ? `«${query}» — Новостной Агрегатор` : 'Новостной Агрегатор';
      return;
    }

    messageParts.push(`Показаны ${articles.length} материалов`);
    if (source) {
      const selectedOption = sourceSelect?.selectedOptions?.[0]?.textContent?.trim();
      if (selectedOption) {
        messageParts.push(`из «${selectedOption}»`);
      }
    } else {
      messageParts.push('из разных источников');
    }
    if (query) {
      messageParts.push(`по запросу «${query}»`);
    }
    searchFeedback.textContent = `${messageParts.join(' ')}.`;
    document.title = query ? `«${query}» — Новостной Агрегатор` : 'Новостной Агрегатор';

    newsContainer.innerHTML = '';
    const favoriteArticles = getFavoriteArticles();
    const fragment = document.createDocumentFragment();
    articles.forEach(article => {
      fragment.appendChild(createCard(article, highlightTokens, translate, favoriteArticles));
    });
    newsContainer.appendChild(fragment);
  }

  function createCard(article, highlightTokens, translate = true, favoriteArticles = []) {
    const col = document.createElement('div');
    col.className = 'news-grid-item';

    const articleKey = getArticleKey(article);
    const isFavorite = favoriteArticles.some(item => item.key === articleKey);
    const title = translate
      ? sanitizeString(article.title_ru || article.title)
      : sanitizeString(article.title);
    const snippet = translate
      ? sanitizeString(article.snippet_ru || article.snippet)
      : sanitizeString(article.snippet);
    const timeMeta = computeTimeMeta(article.publishedAt);
    const sourceTitle = sanitizeString(article.sourceTitle || article.source);
    const imageSeed = sanitizeString(article.source || 'news');
    const fallbackImage = `https://picsum.photos/seed/${encodeURIComponent(imageSeed)}/800/500`;
    const image = safeExternalUrl(article.imageUrl, fallbackImage);

    const highlightedTitle = highlightMatches(title, highlightTokens);
    const highlightedSnippet = highlightMatches(snippet, highlightTokens);
    const safeImage = escapeHtml(image);
    const safeId = escapeHtml(article.id || '');
    const safeSource = escapeHtml(article.source || '');
    const safeSourceTitle = escapeHtml(sourceTitle);
    const safePublished = escapeHtml(article.publishedAt || '');
    const safeAlt = escapeHtml(title);
    const safeLink = escapeHtml(safeExternalUrl(article.link, '#'));
    const safeArticleKey = escapeHtml(articleKey);
    const safeTitle = escapeHtml(sanitizeString(article.title).trim());
    const safeTitleRu = escapeHtml(sanitizeString(article.title_ru).trim());
    const safeSnippet = escapeHtml(sanitizeString(article.snippet).trim());
    const safeSnippetRu = escapeHtml(sanitizeString(article.snippet_ru).trim());
    const safeFallback = escapeHtml(fallbackImage);
    const favoriteLabel = isFavorite ? 'Убрать из избранного' : 'Добавить в избранное';
    const favoriteIcon = isFavorite ? '★' : '☆';

    col.innerHTML = `
      <article
        class="news-card${isFavorite ? ' news-card--bookmarked' : ''}"
        tabindex="0"
        role="button"
        aria-label="${safeAlt}. Открыть полную новость"
        data-article-key="${safeArticleKey}"
        data-id="${safeId}"
        data-title="${safeTitle}"
        data-title-ru="${safeTitleRu}"
        data-snippet="${safeSnippet}"
        data-snippet-ru="${safeSnippetRu}"
        data-fulltext="${encodeURIComponent(sanitizeString(article.fullText))}"
        data-source="${safeSource}"
        data-source-title="${safeSourceTitle}"
        data-link="${safeLink}"
        data-image-url="${safeImage}"
        data-published="${safePublished}"
      >
        <div class="news-card-media">
          <button
            type="button"
            class="news-card-favorite"
            data-favorite-toggle="${safeArticleKey}"
            aria-pressed="${isFavorite ? 'true' : 'false'}"
            aria-label="${favoriteLabel}"
            title="${favoriteLabel}"
          ><span aria-hidden="true">${favoriteIcon}</span></button>
          <img src="${safeImage}" class="news-card-img" alt="${safeAlt}" onerror="this.onerror=null;this.src='${safeFallback}';">
          <span class="news-card-badge">${safeSourceTitle}</span>
        </div>
        <div class="news-card-body">
          <h3 class="news-card-title">${highlightedTitle}</h3>
          <p class="news-card-text">${highlightedSnippet}</p>
        </div>
        <footer class="news-card-meta">
          <span class="news-meta-source">${safeSourceTitle}</span>
          <span class="news-meta-time" title="${timeMeta.absolute}">${timeMeta.relative}</span>
        </footer>
      </article>
    `;

    return col;
  }

  async function fetchAndDisplayNews(options = {}) {
    const { initial = false, refresh = false } = options;
    const query = sanitizeString(topicInput.value).trim();
    const source = sanitizeString(sourceSelect.value);
    const viewAll = isViewAllEnabled();
    const translate = isTranslateEnabled();

    updateSaveSearchButtonState();
    renderFavoritesPanel();

    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (source) params.set('source', source);
    if (viewAll) params.set('view_all', 'true');
    if (refresh) params.set('refresh', 'true');

    syncUrlFromState({ query, source, translate, viewAll });

    if (activeSearchController) {
      activeSearchController.abort();
    }
    const requestController = new AbortController();
    activeSearchController = requestController;

    setLoading(true, viewAll ? 8 : 6);
    if (refresh) {
      searchFeedback.textContent = 'Обновляем ленту новостей...';
    } else {
      searchFeedback.textContent = initial ? 'Подбираем актуальные материалы...' : 'Ищем новости...';
    }

    try {
      const response = await fetch(`/api/search?${params.toString()}`, {
        signal: requestController.signal
      });
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }
      const data = await response.json();
      if (!data?.ok || !Array.isArray(data.results)) {
        throw new Error(data?.error || 'Не удалось получить данные');
      }
      renderArticles(data.results, { query, source });
    } catch (error) {
      if (error.name === 'AbortError') {
        return;
      }
      console.warn('Search API failed', error);
      searchFeedback.textContent = 'Не удалось загрузить новости. Проверьте соединение и попробуйте еще раз.';
      renderErrorState('Проверьте соединение и попробуйте еще раз. Если проблема повторяется, нажмите "Обновить ленту".');
    } finally {
      if (activeSearchController === requestController) {
        activeSearchController = null;
      }
      setLoading(false);
    }
  }

  function getArticleFromCard(card) {
    if (!card) return null;

    return {
      key: sanitizeString(card.dataset.articleKey).trim(),
      id: sanitizeString(card.dataset.id).trim(),
      title: decodeURIComponentSafe(card.dataset.title) || sanitizeString(card.querySelector('.news-card-title')?.textContent).trim() || '',
      titleRu: decodeURIComponentSafe(card.dataset.titleRu) || '',
      snippet: decodeURIComponentSafe(card.dataset.snippet) || '',
      snippetRu: decodeURIComponentSafe(card.dataset.snippetRu) || '',
      fullText: decodeURIComponentSafe(card.dataset.fulltext),
      source: sanitizeString(card.dataset.source).trim(),
      sourceTitle: sanitizeString(card.dataset.sourceTitle).trim(),
      link: sanitizeString(card.dataset.link).trim(),
      imageUrl: sanitizeString(card.dataset.imageUrl).trim(),
      publishedAt: sanitizeString(card.dataset.published).trim()
    };
  }

  async function handleCardClick(event) {
    const card = event.target.closest('.news-card');
    if (!card || !newsModal || card.classList.contains('news-card--skeleton')) return;
    event.preventDefault();
    await openArticleModal(getArticleFromCard(card));
  }

  const throttledFetch = (() => {
    let timeoutId = null;
    return () => {
      updateSaveSearchButtonState();
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        fetchAndDisplayNews();
      }, 220);
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

  sourceSelect?.addEventListener('change', () => fetchAndDisplayNews());
  quickTopicButtons.forEach(button => {
    button.addEventListener('click', () => {
      const quickTopic = sanitizeString(button.dataset.quickTopic).trim();
      if (!quickTopic || !topicInput) return;

      topicInput.value = quickTopic;
      topicInput.focus();
      topicInput.select();
      fetchAndDisplayNews();
    });
  });

  savedSearchesContainer?.addEventListener('click', event => {
    const applyButton = event.target.closest('[data-saved-search-apply]');
    if (applyButton) {
      const savedSearchId = sanitizeString(applyButton.dataset.savedSearchApply).trim();
      const savedSearch = getSavedSearches().find(item => item.id === savedSearchId);
      if (savedSearch) {
        applySavedSearch(savedSearch);
      }
      return;
    }

    const removeButton = event.target.closest('[data-saved-search-remove]');
    if (removeButton) {
      const savedSearchId = sanitizeString(removeButton.dataset.savedSearchRemove).trim();
      if (savedSearchId) {
        removeSavedSearch(savedSearchId);
      }
    }
  });

  newsContainer?.addEventListener('click', async event => {
    const favoriteToggle = event.target.closest('[data-favorite-toggle]');
    if (favoriteToggle) {
      const card = favoriteToggle.closest('.news-card');
      if (card) {
        toggleFavoriteArticle(getArticleFromCard(card));
      }
      return;
    }

    const stateAction = event.target.closest('[data-state-action]');
    if (stateAction) {
      const action = stateAction.dataset.stateAction;

      if (action === 'clear-filters') {
        if (topicInput) topicInput.value = '';
        if (sourceSelect) sourceSelect.value = '';
        if (viewAllToggle) viewAllToggle.checked = false;
        fetchAndDisplayNews({ refresh: true });
        return;
      }

      if (action === 'retry-search' || action === 'refresh-feed') {
        fetchAndDisplayNews({ refresh: true });
        return;
      }
    }

    await handleCardClick(event);
  });

  newsContainer?.addEventListener('keydown', async event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target instanceof Element && event.target.closest('button, a, input, textarea, select')) return;

    const card = event.target.closest('.news-card');
    if (!card || card.classList.contains('news-card--skeleton')) return;

    event.preventDefault();
    await openArticleModal(getArticleFromCard(card));
  });

  favoritesListContainer?.addEventListener('click', async event => {
    const openButton = event.target.closest('[data-favorite-open]');
    if (openButton) {
      const favoriteKey = sanitizeString(openButton.dataset.favoriteOpen).trim();
      const favorite = findFavoriteArticle(favoriteKey);
      if (favorite) {
        await openArticleModal(favorite);
      }
      return;
    }

    const removeButton = event.target.closest('[data-favorite-remove]');
    if (removeButton) {
      const favoriteKey = sanitizeString(removeButton.dataset.favoriteRemove).trim();
      if (favoriteKey) {
        removeFavoriteArticle(favoriteKey);
      }
    }
  });

  // Toggle handlers - re-render with new translation setting
  translateToggle?.addEventListener('change', () => {
    updateSaveSearchButtonState();
    fetchAndDisplayNews();
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
      return;
    }

    if (event.key === 'Escape' && document.activeElement === topicInput && topicInput?.value) {
      event.preventDefault();
      topicInput.value = '';
      fetchAndDisplayNews();
    }
  });

  window.addEventListener('popstate', () => {
    syncStateFromUrl();
    updateSaveSearchButtonState();
    fetchAndDisplayNews();
  });

  syncStateFromUrl();
  renderSavedSearches();
  fetchAndDisplayNews({ initial: true });
});
