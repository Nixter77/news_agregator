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

  const relativeTimeFormatter = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' });
  const absoluteTimeFormatter = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit'
  });

  function sanitizeString(str) {
    return typeof str === 'string' ? str : '';
  }

  function escapeHtml(str) {
    return sanitizeString(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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

  function setLoading(isLoading) {
    if (!loadingIndicator) return;
    loadingIndicator.classList.toggle('d-none', !isLoading);
    if (isLoading) {
      loadingIndicator.setAttribute('aria-busy', 'true');
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

    try {
      const resp = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: safeText, to: 'ru' })
      });
      const data = await resp.json();
      if (data?.ok && data.translated) {
        return data.translated;
      }
    } catch (error) {
      console.warn('Translation API failed', error);
    }

    return safeText;
  }

  function renderArticles(articles, { query, source }) {
    newsContainer.innerHTML = '';
    const messageParts = [];
    const highlightTokens = splitIntoTokens(query);
    const translate = isTranslateEnabled();

    if (!Array.isArray(articles) || articles.length === 0) {
      if (query) {
        searchFeedback.textContent = `Мы не нашли материалов по запросу «${query}». Попробуйте переформулировать или выбрать другой источник.`;
      } else {
        searchFeedback.textContent = 'Пока свежих новостей нет. Попробуйте выбрать конкретный источник или обновите позже.';
      }
      document.title = 'Новостной Агрегатор';
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

    const fragment = document.createDocumentFragment();
    articles.forEach(article => {
      fragment.appendChild(createCard(article, highlightTokens, translate));
    });
    newsContainer.appendChild(fragment);
  }

  function createCard(article, highlightTokens, translate = true) {
    const col = document.createElement('div');
    col.className = 'news-grid-item';

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
    const image = sanitizeString(article.imageUrl) || fallbackImage;

    const highlightedTitle = highlightMatches(title, highlightTokens);
    const highlightedSnippet = highlightMatches(snippet, highlightTokens);
    const safeImage = escapeHtml(image);
    const safeLink = escapeHtml(article.link || '#');
    const safeId = escapeHtml(article.id || '');
    const safeSource = escapeHtml(article.source || '');
    const safeSourceTitle = escapeHtml(sourceTitle);
    const safePublished = escapeHtml(article.publishedAt || '');
    const safeAlt = escapeHtml(title);

    const safeFallback = escapeHtml(fallbackImage);

    col.innerHTML = `
      <a href="${safeLink}" target="_blank" rel="noopener noreferrer" class="news-card-link">
        <article
          class="news-card"
          data-id="${safeId}"
          data-fulltext="${encodeURIComponent(sanitizeString(article.fullText))}"
          data-source="${safeSource}"
          data-source-title="${safeSourceTitle}"
          data-link="${safeLink}"
          data-published="${safePublished}"
        >
          <div class="news-card-media">
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
      </a>
    `;

    return col;
  }

  async function fetchAndDisplayNews(options = {}) {
    const { initial = false, refresh = false } = options;
    const query = sanitizeString(topicInput.value).trim();
    const source = sanitizeString(sourceSelect.value);
    const viewAll = isViewAllEnabled();

    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (source) params.set('source', source);
    if (viewAll) params.set('view_all', 'true');
    if (refresh) params.set('refresh', 'true');

    setLoading(true);
    if (refresh) {
      searchFeedback.textContent = 'Обновляем ленту новостей...';
    } else {
      searchFeedback.textContent = initial ? 'Подбираем актуальные материалы...' : 'Ищем новости...';
    }

    try {
      const response = await fetch(`/api/search?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }
      const data = await response.json();
      if (!data?.ok || !Array.isArray(data.results)) {
        throw new Error(data?.error || 'Не удалось получить данные');
      }
      renderArticles(data.results, { query, source });
    } catch (error) {
      console.warn('Search API failed', error);
      searchFeedback.textContent = 'Не удалось загрузить новости. Проверьте соединение и попробуйте еще раз.';
    } finally {
      setLoading(false);
    }
  }

  async function handleCardClick(event) {
    const card = event.target.closest('.news-card');
    if (!card || !newsModal) return;
    event.preventDefault();

    const rawFull = decodeURIComponent(card.dataset.fulltext || '');
    const link = card.dataset.link || '#';
    const sourceTitle = card.dataset.sourceTitle || card.dataset.source || 'Источник не указан';
    const publishedAt = card.dataset.published;
    const timeMeta = computeTimeMeta(publishedAt);
    const title = card.querySelector('.news-card-title')?.textContent || '';

    const translate = isTranslateEnabled();
    const translatedFull = (rawFull && translate)
      ? await translateViaApi(rawFull)
      : (rawFull || 'Полный текст недоступен для этой заметки.');
    const imageSrc = card.querySelector('.news-card-img')?.src;

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

  const throttledFetch = (() => {
    let timeoutId = null;
    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        fetchAndDisplayNews();
      }, 350);
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

  topicInput?.addEventListener('input', throttledFetch);
  topicInput?.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      fetchAndDisplayNews();
    }
  });

  sourceSelect?.addEventListener('change', () => fetchAndDisplayNews());
  newsContainer?.addEventListener('click', handleCardClick);

  // Toggle handlers - re-render with new translation setting
  translateToggle?.addEventListener('change', () => {
    // Re-fetch to apply translation preference
    fetchAndDisplayNews();
  });

  viewAllToggle?.addEventListener('change', () => {
    fetchAndDisplayNews();
  });

  fetchAndDisplayNews({ initial: true });
});
