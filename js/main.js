import { CATEGORY_LABELS, DEFAULT_TOPIC_CHIPS, KNOWN_CATEGORIES, SECTION_CHIP_BLOCKLIST, STORAGE_KEYS } from './constants.js';
import { bindImageFallback } from './dom.js';
import { createFavorites } from './favorites.js';
import { createFeed } from './feed.js';
import { createSavedSearches } from './saved-searches.js';
import { createFullTextStore, rememberQuery, safeStorageGet, safeStorageSet, topQueries } from './storage.js';
import {
  articleKey,
  computeTimeMeta,
  escapeHtml,
  getReadingTime,
  isEditableTarget,
  parseBooleanParam,
  safeExternalUrl,
  sanitizeString,
} from './text.js';

document.addEventListener('DOMContentLoaded', () => {
  const searchForm = document.getElementById('search-form');
  const searchButton = document.getElementById('search-button');
  const refreshButton = document.getElementById('refresh-button');
  const newsContainer = document.getElementById('news-container');
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
  const quickChipsContainer = document.querySelector('.quick-chips-scroll');
  const favoritesListContainer = document.getElementById('favorites-list');
  const favoritesPanel = document.getElementById('favorites-panel');
  const panelsContainer = document.getElementById('panels-container');
  const favoritesCountElement = document.getElementById('favorites-count');
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
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

  const fullText = createFullTextStore();
  const feedState = { articles: [], byKey: new Map() };
  const sourceTitleById = new Map();
  const actions = {
    fetch() {},
    applyTopic() {},
    openArticle() {},
    currentQuery() {
      return topicInput?.value || '';
    },
  };

  let toastTimer = 0;
  let activeSearchController = null;
  let activeSearchToken = 0;
  let activeModalArticleKey = null;
  let currentCategory = 'all';
  let pendingSourceFromUrl = '';
  let currentLayout = 'grid';

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

  function isTranslateEnabled() {
    return translateToggle?.checked ?? true;
  }

  function isViewAllEnabled() {
    return viewAllToggle?.checked ?? false;
  }

  function isAllSourcesEnabled() {
    return allSourcesToggle?.checked ?? false;
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
      category: currentCategory,
    };
  }

  function canResetFilters(query, source) {
    return Boolean(query || source || currentCategory !== 'all' || isViewAllEnabled() || isAllSourcesEnabled());
  }

  function getSourceLabel(source) {
    if (!source) {
      return currentCategory !== 'all'
        ? (CATEGORY_LABELS[currentCategory] || 'По разделу')
        : 'По разделу';
    }
    if (sourceTitleById.has(source)) return sourceTitleById.get(source);
    const option = Array.from(sourceSelect?.options || []).find((item) => item.value === source);
    return sanitizeString(option?.textContent?.trim() || source);
  }

  function syncPanels() {
    const savedCount = saved.getAll().length;
    const favoriteCount = favorites.getAll().length;

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

  const saved = createSavedSearches({
    listEl: savedSearchesContainer,
    saveButton: saveSearchButton,
    storageKey: STORAGE_KEYS.savedSearches,
    showToast,
    syncPanels,
    getCurrentSearchState,
    getSourceLabel,
    setActiveCategory,
    form: { topicInput, sourceSelect, translateToggle, viewAllToggle, allSourcesToggle },
    actions,
  });

  const favorites = createFavorites({
    listEl: favoritesListContainer,
    countEl: favoritesCountElement,
    newsContainer,
    storageKey: STORAGE_KEYS.favorites,
    showToast,
    syncPanels,
    isTranslateEnabled,
    actions,
  });

  const feed = createFeed({
    newsContainer,
    searchFeedback,
    statsKeywords,
    statsSources,
    statsDashboard,
    feedState,
    fullText,
    favorites,
    articleKey,
    isTranslateEnabled,
    currentSearchToken: () => activeSearchToken,
    getSourceLabel,
    updateLayoutView,
    updateChipActiveState,
    canResetFilters,
    actions,
  });

  function preferredLayout() {
    const stored = safeStorageGet(STORAGE_KEYS.layout);
    if (stored === 'grid' || stored === 'list') return stored;
    return window.matchMedia('(max-width: 768px)').matches ? 'list' : 'grid';
  }

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
    safeStorageSet(STORAGE_KEYS.theme, theme);
    updateThemeIcons();
  }

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

  function updateLayoutView() {
    if (!newsContainer) return;
    const isList = currentLayout === 'list';
    newsContainer.classList.toggle('view-list', isList);
    layoutListBtn?.classList.toggle('active', isList);
    layoutGridBtn?.classList.toggle('active', !isList);
    layoutListBtn?.setAttribute('aria-pressed', String(isList));
    layoutGridBtn?.setAttribute('aria-pressed', String(!isList));
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

  function renderQuickChips() {
    if (!quickChipsContainer) return;
    const combined = [];
    const seen = new Set();

    const pushChip = (label, isTop) => {
      const lower = sanitizeString(label).trim().toLowerCase();
      if (!lower || seen.has(lower) || SECTION_CHIP_BLOCKLIST.has(lower)) return;
      seen.add(lower);
      combined.push({ label, isTop });
    };

    topQueries(STORAGE_KEYS.searchHistory, 3).forEach((query) => pushChip(query, true));
    DEFAULT_TOPIC_CHIPS.forEach((chip) => pushChip(chip, false));

    quickChipsContainer.innerHTML = combined.map((item) => `
      <button type="button" class="chip-btn${item.isTop ? ' chip-btn--top' : ''}" data-quick-topic="${escapeHtml(item.label)}">${escapeHtml(item.label)}</button>
    `).join('');
    updateChipActiveState();
  }

  function recordSearchQuery(query) {
    const result = rememberQuery(STORAGE_KEYS.searchHistory, sanitizeString(query).trim());
    if (result === 'skip') return;
    if (result === 'fail') showToast('Не удалось сохранить локально (хранилище недоступно).');
    renderQuickChips();
  }

  function setLoading(isLoading) {
    loadingIndicator?.classList.toggle('d-none', !isLoading);
    if (searchButton) searchButton.disabled = isLoading;
    if (refreshButton) refreshButton.disabled = isLoading;
    newsContainer?.setAttribute('aria-busy', String(isLoading));
    newsContainer?.classList.toggle('is-loading', isLoading);
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
    if (category && KNOWN_CATEGORIES.has(category)) setActiveCategory(category);
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

  async function translateViaApi(text) {
    const safeText = sanitizeString(text);
    if (!safeText) return '';

    try {
      const resp = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: safeText, to: 'ru' }),
      });
      const data = await resp.json();
      if (data?.ok && data.translated) return data.translated;
    } catch (error) {
      console.warn('Article translation failed', error);
    }

    return safeText;
  }

  async function openArticleModal(article) {
    if (!newsModal || !article) return;

    const key = articleKey(article);
    activeModalArticleKey = key;
    const sourceKey = sanitizeString(article?.source).trim();
    const idKey = sanitizeString(article?.id).trim();
    const translate = isTranslateEnabled();
    const stillThisArticle = () => activeModalArticleKey === key;

    const stored = fullText.get(key);
    let originalText = stored.original || sanitizeString(article?.fullText).trim();
    let translatedText = stored.ru || sanitizeString(article?.fullText_ru || article?.fullTextRu).trim();

    const title = translate
      ? sanitizeString(article?.title_ru || article?.titleRu || article?.title).trim()
      : sanitizeString(article?.title).trim();
    const displayTitle = title || 'Загрузка...';
    const sourceTitle = sanitizeString(article?.sourceTitle || article?.source).trim() || 'Источник';
    const timeMeta = computeTimeMeta(article?.publishedAt);
    const imageSrc = safeExternalUrl(article?.imageUrl || article?.imageSrc, '');
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
          fullText.store(key, { original: originalText, ru: translatedText });
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
        fullText.store(key, { original: originalText, ru: translatedText });
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

  async function fetchAndDisplayNews(options = {}) {
    const { initial = false, refresh = false } = options;
    window.clearTimeout(searchDebounce);
    const query = sanitizeString(topicInput?.value).trim();
    const source = getSelectedSource();
    const viewAll = isViewAllEnabled();
    const allSources = isAllSourcesEnabled();
    const translate = isTranslateEnabled();

    saved.updateButton();
    favorites.render();

    const hasRealCards = Boolean(newsContainer?.querySelector('.news-card:not(.news-card--skeleton)'));
    if (initial || !hasRealCards) feed.renderSkeletons();

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

    if (activeSearchController) activeSearchController.abort();
    const requestController = new AbortController();
    activeSearchController = requestController;
    const searchToken = ++activeSearchToken;

    setLoading(true);
    searchFeedback.textContent = refresh ? 'Обновляем новости...' : 'Загрузка...';

    try {
      const response = await fetch(`/api/search?${params.toString()}`, {
        signal: requestController.signal,
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
      if (query) recordSearchQuery(query);
      feed.renderArticles(data.results, { query, source }, searchToken);
      if (searchFeedback) {
        if (data.results.length > 0) {
          searchFeedback.textContent = feed.formatStatus(data);
        } else if (data.degraded) {
          searchFeedback.textContent = `${searchFeedback.textContent} ${feed.formatStatus(data)}`;
        }
      }
    } catch (error) {
      if (error.name === 'AbortError') return;
      const msg = error.message || 'Ошибка соединения.';
      searchFeedback.textContent = msg.includes('unavailable') || msg.includes('Status 503')
        ? 'Источники новостей временно недоступны.'
        : 'Ошибка соединения.';
      feed.renderErrorState(msg.includes('unavailable')
        ? 'Попробуйте обновить позже.'
        : 'Проверьте подключение к сети и попробуйте снова.');
    } finally {
      if (activeSearchController === requestController) {
        activeSearchController = null;
        setLoading(false);
      }
    }
  }

  function resetToHome() {
    if (topicInput) topicInput.value = '';
    if (sourceSelect) sourceSelect.value = '';
    pendingSourceFromUrl = '';
    if (viewAllToggle) viewAllToggle.checked = false;
    if (allSourcesToggle) allSourcesToggle.checked = false;
    setActiveCategory('all');
    fetchAndDisplayNews();
  }

  actions.fetch = fetchAndDisplayNews;
  actions.openArticle = openArticleModal;
  actions.applyTopic = (topic, { focus = false } = {}) => {
    if (!topic || !topicInput) return;
    topicInput.value = topic;
    if (focus) topicInput.focus();
    fetchAndDisplayNews();
  };

  let searchDebounce = 0;
  function scheduleSearch() {
    saved.updateButton();
    window.clearTimeout(searchDebounce);
    const q = sanitizeString(topicInput?.value).trim();
    if (q.length === 1) return;
    searchDebounce = window.setTimeout(() => {
      fetchAndDisplayNews();
    }, 650);
  }

  currentLayout = preferredLayout();
  updateThemeIcons();

  themeToggleBtn?.addEventListener('click', () => {
    applyTheme(isDarkTheme() ? 'light' : 'dark');
  });

  newsModalClose?.addEventListener('click', () => {
    newsModal?.close();
  });

  newsModal?.addEventListener('click', (event) => {
    if (event.target === newsModal) newsModal.close();
  });

  searchForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    fetchAndDisplayNews();
  });

  refreshButton?.addEventListener('click', (event) => {
    event.preventDefault();
    fetchAndDisplayNews({ refresh: true });
  });

  saveSearchButton?.addEventListener('click', (event) => {
    event.preventDefault();
    saved.saveCurrent();
  });

  topicInput?.addEventListener('input', scheduleSearch);

  sourceSelect?.addEventListener('change', () => {
    pendingSourceFromUrl = '';
    if (sourceSelect.value) setActiveCategory('all');
    fetchAndDisplayNews();
  });

  quickChipsContainer?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-quick-topic]');
    if (!button || !topicInput) return;
    const quickTopic = sanitizeString(button.dataset.quickTopic).trim();
    if (quickTopic) actions.applyTopic(quickTopic);
  });

  newsContainer?.addEventListener('click', async (event) => {
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
      if (card) favorites.toggle(feed.articleFromCard(card));
      return;
    }
    const card = event.target.closest('.news-card');
    if (card) await openArticleModal(feed.articleFromCard(card));
  });

  translateToggle?.addEventListener('change', () => {
    saved.updateButton();
    if (feedState.articles.length > 0) {
      feed.renderArticles(feedState.articles, {
        query: sanitizeString(topicInput?.value).trim(),
        source: sanitizeString(sourceSelect?.value).trim(),
      });
      return;
    }
    fetchAndDisplayNews();
  });

  viewAllToggle?.addEventListener('change', () => {
    saved.updateButton();
    fetchAndDisplayNews();
  });

  allSourcesToggle?.addEventListener('change', () => {
    if (isAllSourcesEnabled()) {
      setActiveCategory('all');
      if (sourceSelect) sourceSelect.value = '';
      pendingSourceFromUrl = '';
    }
    saved.updateButton();
    fetchAndDisplayNews();
  });

  brandHome?.addEventListener('click', (event) => {
    event.preventDefault();
    resetToHome();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !isEditableTarget(event.target)) {
      event.preventDefault();
      topicInput?.focus();
      topicInput?.select();
    }
  });

  layoutGridBtn?.addEventListener('click', () => {
    currentLayout = 'grid';
    safeStorageSet(STORAGE_KEYS.layout, 'grid');
    updateLayoutView();
  });

  layoutListBtn?.addEventListener('click', () => {
    currentLayout = 'list';
    safeStorageSet(STORAGE_KEYS.layout, 'list');
    updateLayoutView();
  });

  statsToggleBtn?.addEventListener('click', () => {
    const isHidden = statsDashboard?.classList.toggle('d-none');
    statsToggleBtn?.classList.toggle('active', !isHidden);
    statsToggleBtn?.setAttribute('aria-expanded', String(!isHidden));
    if (!isHidden && feedState.articles.length > 0) feed.buildStats(feedState.articles);
  });

  statsCloseBtn?.addEventListener('click', () => {
    statsDashboard?.classList.add('d-none');
    statsToggleBtn?.classList.remove('active');
    statsToggleBtn?.setAttribute('aria-expanded', 'false');
  });

  categoryTabs.forEach((tab) => {
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
  saved.render();
  renderQuickChips();
  updateLayoutView();
  feed.renderSkeletons();
  fetchAndDisplayNews({ initial: true });
  loadSourceCatalog();
});
