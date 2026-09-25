import { bindImageFallback } from './dom.js';
import {
  computeTimeMeta,
  displayFields,
  escapeHtml,
  highlightHtml,
  highlightRegexes,
  isDisplayableSnippet,
  safeExternalUrl,
  sanitizeString,
} from './text.js';

export function createFeed({
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
  currentSearchToken,
  getSourceLabel,
  updateLayoutView,
  updateChipActiveState,
  canResetFilters,
  actions,
}) {
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
            <div class="skeleton-line skeleton-line--title"></div>
            <div class="skeleton-line skeleton-line--text"></div>
          </div>
        </article>
      `;
      fragment.appendChild(item);
    }

    newsContainer.innerHTML = '';
    newsContainer.appendChild(fragment);
  }

  function renderEmptyState(query, source, canReset) {
    if (!newsContainer) return;
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

  function formatStatus(data) {
    const count = Array.isArray(data?.results) ? data.results.length : 0;
    const parts = [`Показаны ${count} материалов`];

    if (data?.generatedAt) {
      const timeMeta = computeTimeMeta(data.generatedAt);
      if (timeMeta.relative && timeMeta.relative !== 'Дата не указана') {
        parts.push(data.cached ? `кэш · ${timeMeta.relative}` : `обновлено ${timeMeta.relative}`);
      }
    }

    if (data?.deadlineHit) {
      parts.push('часть источников не успела ответить');
    }

    if (data?.degraded) {
      const failed = Array.isArray(data.sourcesFailed) ? data.sourcesFailed : [];
      if (failed.length) {
        const labels = failed.slice(0, 4).map((id) => getSourceLabel(id) || id);
        const extra = failed.length > 4 ? ` и ещё ${failed.length - 4}` : '';
        parts.push(`недоступны: ${labels.join(', ')}${extra}`);
      } else if (!data.deadlineHit) {
        parts.push('часть источников недоступна');
      }
    }

    return `${parts.join('. ')}.`;
  }

  function buildStats(articles) {
    if (!statsKeywords || !statsSources) return;
    if (!Array.isArray(articles) || articles.length === 0) return;

    const excludeWords = new Set(['это', 'как', 'для', 'что', 'или', 'этот', 'эта', 'эти', 'все', 'под', 'над', 'the', 'and', 'for', 'with', 'about', 'from']);
    const wordFreq = {};
    articles.forEach((art) => {
      const text = `${art.title} ${art.snippet} ${art.title_ru || ''}`.toLowerCase();
      const tokens = text.split(/[\s,.;:!?"'()\[\]{}<>/@#%^&*+=|~`\-_]+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 4 && !excludeWords.has(token));
      tokens.forEach((token) => { wordFreq[token] = (wordFreq[token] || 0) + 1; });
    });

    const topKeywords = Object.entries(wordFreq).sort((a, b) => b[1] - a[1]).slice(0, 10);
    statsKeywords.innerHTML = topKeywords.map(([word, count]) => `
      <button type="button" class="trend-keyword-badge" data-quick-topic="${escapeHtml(word)}">
        #${escapeHtml(word)} <span>${count}</span>
      </button>
    `).join('');

    const sourceCount = {};
    articles.forEach((art) => {
      const src = art.sourceTitle || art.source || 'Другие';
      sourceCount[src] = (sourceCount[src] || 0) + 1;
    });

    const sortedSources = Object.entries(sourceCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
    statsSources.innerHTML = sortedSources.map(([src, count]) => `
      <div class="stats-source-row">
        <span>${escapeHtml(src)}</span>: <strong>${count}</strong>
      </div>
    `).join('');
  }

  function patchCard(article) {
    const key = articleKey(article);
    if (!newsContainer || !key) return;
    const card = newsContainer.querySelector(`.news-card[data-article-key="${CSS.escape(key)}"]`);
    if (!card) return;

    const translate = isTranslateEnabled();
    const { title, snippet } = displayFields(article, translate);
    const regexes = highlightRegexes(sanitizeString(actions.currentQuery()).trim());
    const titleEl = card.querySelector('.news-card-open') || card.querySelector('.news-card-title');
    let textEl = card.querySelector('.news-card-text');
    if (titleEl) titleEl.innerHTML = highlightHtml(title, regexes);
    if (snippet) {
      if (!textEl) {
        textEl = document.createElement('p');
        textEl.className = 'news-card-text';
        card.querySelector('.news-card-body')?.appendChild(textEl);
      }
      textEl.innerHTML = highlightHtml(snippet, regexes);
    } else if (textEl) {
      textEl.remove();
    }

    if (isDisplayableSnippet(article.title_ru) || isDisplayableSnippet(article.snippet_ru)) {
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
      body: JSON.stringify({ texts, to: 'ru' }),
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

  async function ensureTranslated(articles, searchToken = currentSearchToken()) {
    if (!isTranslateEnabled() || !Array.isArray(articles) || articles.length === 0) return;

    const missingTexts = [];
    const seen = new Set();
    articles.forEach((article) => {
      if (article.title && !article.title_ru && isDisplayableSnippet(article.title) && !seen.has(article.title)) {
        seen.add(article.title);
        missingTexts.push(article.title);
      }
      if (article.snippet && !article.snippet_ru && isDisplayableSnippet(article.snippet) && !seen.has(article.snippet)) {
        seen.add(article.snippet);
        missingTexts.push(article.snippet);
      }
    });

    if (missingTexts.length === 0) return;

    const BATCH = 20;
    try {
      for (let offset = 0; offset < missingTexts.length; offset += BATCH) {
        if (currentSearchToken() !== searchToken || !isTranslateEnabled()) return;
        const map = await translateBatchChunk(missingTexts.slice(offset, offset + BATCH));
        if (currentSearchToken() !== searchToken) return;

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
          if (patched && isTranslateEnabled() && currentSearchToken() === searchToken) {
            patchCard(article);
          }
        });
      }
    } catch (err) {
      console.warn('Failed client-side batch translation', err);
    }
  }

  function createCard(article, regexes, translate, index) {
    const col = document.createElement('div');
    col.className = 'news-grid-item';

    const key = articleKey(article);
    const isFavorite = favorites.has(key);
    const { title, snippet, isTranslated } = displayFields(article, translate);
    const timeMeta = computeTimeMeta(article.publishedAt);
    const sourceTitle = sanitizeString(article.sourceTitle || article.source);
    const image = safeExternalUrl(article.imageUrl, '');
    const hasImage = Boolean(image);
    const highlightedTitle = highlightHtml(title, regexes);
    const highlightedSnippet = snippet ? highlightHtml(snippet, regexes) : '';
    const eager = index < 2;
    const langBadge = isTranslated
      ? '<span class="news-card-badge news-card-badge--lang" title="Переведено на русский">RU</span>'
      : '';
    const mediaImg = hasImage
      ? `<img src="${escapeHtml(image)}" class="news-card-img" alt="${escapeHtml(title)}" loading="${eager ? 'eager' : 'lazy'}" decoding="async"${eager ? ' fetchpriority="high"' : ''}>`
      : '';
    const safeKey = escapeHtml(key);

    col.innerHTML = `
      <article
        class="news-card${isFavorite ? ' news-card--bookmarked' : ''}${hasImage ? '' : ' news-card--no-media'}"
        data-article-key="${safeKey}"
      >
        <div class="news-card-media">
          <button
            type="button"
            class="news-card-favorite"
            data-favorite-toggle="${safeKey}"
            aria-pressed="${isFavorite}"
            aria-label="${isFavorite ? 'Убрать из избранного' : 'Добавить в избранное'}"
          ><span aria-hidden="true">${isFavorite ? '★' : '☆'}</span></button>
          ${mediaImg}
          <div class="news-card-badges">
            ${langBadge}
          </div>
        </div>
        <div class="news-card-body">
          <h3 class="news-card-title">
            <button type="button" class="news-card-open">${highlightedTitle}</button>
          </h3>
          ${highlightedSnippet ? `<p class="news-card-text">${highlightedSnippet}</p>` : ''}
        </div>
        <footer class="news-card-meta">
          <span class="news-meta-source">${escapeHtml(sourceTitle)}</span>
          <span title="${escapeHtml(timeMeta.absolute)}">${escapeHtml(timeMeta.relative)}</span>
        </footer>
      </article>
    `;

    bindImageFallback(col);
    return col;
  }

  function renderArticles(articles, { query, source }, searchToken = currentSearchToken()) {
    const list = Array.isArray(articles) ? articles : [];
    const regexes = highlightRegexes(query);
    const translate = isTranslateEnabled();

    feedState.articles = list;
    feedState.byKey = new Map();
    list.forEach((article) => {
      const key = articleKey(article);
      if (!key) return;
      feedState.byKey.set(key, article);
      if (article.fullText || article.fullText_ru) {
        fullText.store(key, { original: article.fullText, ru: article.fullText_ru });
      }
    });

    if (list.length > 0 && statsDashboard && !statsDashboard.classList.contains('d-none')) {
      buildStats(list);
    }

    if (list.length === 0) {
      searchFeedback.textContent = query
        ? `Ничего не найдено по запросу «${query}».`
        : 'Нет материалов в выбранном разделе.';
      renderEmptyState(query, source, canResetFilters(query, source));
      return;
    }

    searchFeedback.textContent = `Показаны ${list.length} материалов.`;
    newsContainer.innerHTML = '';
    favorites.getAll();

    const fragment = document.createDocumentFragment();
    list.forEach((article, index) => {
      fragment.appendChild(createCard(article, regexes, translate, index));
    });
    newsContainer.appendChild(fragment);
    updateLayoutView();
    updateChipActiveState();

    if (translate) ensureTranslated(list, searchToken);
  }

  function articleFromCard(card) {
    if (!card) return null;
    const key = sanitizeString(card.dataset.articleKey).trim();
    if (key && feedState.byKey.has(key)) return feedState.byKey.get(key);
    return null;
  }

  statsKeywords?.addEventListener('click', (event) => {
    const badge = event.target.closest('[data-quick-topic]');
    if (!badge) return;
    actions.applyTopic(sanitizeString(badge.dataset.quickTopic).trim(), { focus: true });
  });

  return {
    renderSkeletons,
    renderErrorState,
    renderArticles,
    formatStatus,
    buildStats,
    articleFromCard,
  };
}
