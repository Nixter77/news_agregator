import { LIMITS } from './constants.js';
import { bindImageFallback } from './dom.js';
import { readJsonList, writeJsonList } from './storage.js';
import {
  articleKey,
  computeTimeMeta,
  escapeHtml,
  normalizeFavoriteArticle,
  safeExternalUrl,
  sanitizeString,
} from './text.js';

const STORAGE_FAIL = 'Не удалось сохранить локально (хранилище недоступно).';

export function createFavorites({
  listEl,
  countEl,
  newsContainer,
  storageKey,
  showToast,
  syncPanels,
  isTranslateEnabled,
  actions,
}) {
  let memoryList = null;
  let memorySet = new Set();

  function persist(favoriteArticles) {
    const next = favoriteArticles.slice(0, LIMITS.favorites);
    const ok = writeJsonList(storageKey, next);
    if (!ok) showToast(STORAGE_FAIL);
    memoryList = next;
    memorySet = new Set(next.map((item) => item.key));
    return next;
  }

  function getAll() {
    if (memoryList) return memoryList;

    const list = readJsonList(storageKey)
      .map((item) => normalizeFavoriteArticle(item))
      .filter((item) => item.key)
      .sort((left, right) => new Date(right.savedAt).getTime() - new Date(left.savedAt).getTime());

    memoryList = list;
    memorySet = new Set(list.map((item) => item.key));
    return list;
  }

  function has(key) {
    getAll();
    return memorySet.has(key);
  }

  function find(key) {
    return getAll().find((item) => item.key === key) || null;
  }

  function titleOf(favoriteArticle) {
    if (isTranslateEnabled() && favoriteArticle?.titleRu) return favoriteArticle.titleRu;
    return favoriteArticle?.title || favoriteArticle?.titleRu || 'Без названия';
  }

  function metaOf(favoriteArticle) {
    const sourceTitle = sanitizeString(favoriteArticle?.sourceTitle || favoriteArticle?.source).trim() || 'Источник не указан';
    const timeMeta = computeTimeMeta(favoriteArticle?.publishedAt);
    const parts = [sourceTitle];
    if (timeMeta.relative && timeMeta.relative !== 'Дата не указана') {
      parts.push(timeMeta.relative);
    }
    return parts.join(' · ');
  }

  function updateButton(cardElement, isFavorite) {
    if (!cardElement) return;
    cardElement.classList.toggle('news-card--bookmarked', isFavorite);
    const button = cardElement.querySelector('[data-favorite-toggle]');
    if (!button) return;

    button.setAttribute('aria-pressed', String(isFavorite));
    button.setAttribute('aria-label', isFavorite ? 'Убрать из избранного' : 'Добавить в избранное');
    button.title = isFavorite ? 'Убрать из избранного' : 'Добавить в избранное';
    button.innerHTML = isFavorite ? '<span aria-hidden="true">★</span>' : '<span aria-hidden="true">☆</span>';
  }

  function syncCard(key) {
    if (!newsContainer || !key) return;
    const card = newsContainer.querySelector(`.news-card[data-article-key="${CSS.escape(key)}"]`);
    if (!card) return;
    updateButton(card, memorySet.has(key));
  }

  function render() {
    if (!listEl) return;
    const favoriteArticles = getAll();
    if (countEl) countEl.textContent = String(favoriteArticles.length);
    syncPanels();

    if (!favoriteArticles.length) {
      listEl.innerHTML = '';
      return;
    }

    listEl.innerHTML = favoriteArticles.map((favoriteArticle) => {
      const key = escapeHtml(favoriteArticle.key);
      const title = escapeHtml(titleOf(favoriteArticle));
      const meta = escapeHtml(metaOf(favoriteArticle));
      const image = safeExternalUrl(favoriteArticle.imageUrl, '');
      const thumb = image
        ? `<img src="${escapeHtml(image)}" class="favorite-item__thumb" alt="${title}" loading="lazy" decoding="async">`
        : '';

      return `
        <div class="favorite-item${image ? '' : ' favorite-item--no-media'}" data-favorite-key="${key}">
          <button
            type="button"
            class="favorite-item__preview"
            data-favorite-open="${key}"
          >
            ${thumb}
            <span class="favorite-item__content">
              <span class="favorite-item__title">${title}</span>
              <span class="favorite-item__meta">${meta}</span>
            </span>
          </button>
          <button
            type="button"
            class="favorite-item__remove"
            data-favorite-remove="${key}"
            aria-label="Удалить «${title}»"
            title="Удалить из избранного"
          >×</button>
        </div>
      `;
    }).join('');
    bindImageFallback(listEl);
  }

  function remove(key, feedbackMessage = 'Статья удалена из избранного.') {
    persist(getAll().filter((item) => item.key !== key));
    syncCard(key);
    render();
    if (feedbackMessage) showToast(feedbackMessage);
  }

  function toggle(article) {
    if (!article) return;
    const key = articleKey(article);
    if (!key) return;

    if (has(key)) {
      remove(key, 'Статья удалена из избранного.');
      return;
    }

    const nextFavorite = normalizeFavoriteArticle({ ...article, savedAt: new Date().toISOString() });
    persist([nextFavorite, ...getAll().filter((item) => item.key !== key)]);
    syncCard(key);
    render();
    showToast('Статья добавлена в избранное.');
  }

  listEl?.addEventListener('click', async (event) => {
    const openBtn = event.target.closest('[data-favorite-open]');
    if (openBtn) {
      const key = sanitizeString(openBtn.dataset.favoriteOpen).trim();
      const favorite = find(key);
      if (favorite) await actions.openArticle(favorite);
      return;
    }
    const removeBtn = event.target.closest('[data-favorite-remove]');
    if (removeBtn) {
      const key = sanitizeString(removeBtn.dataset.favoriteRemove).trim();
      if (key) remove(key);
    }
  });

  return { getAll, has, render, toggle };
}
