import { CATEGORY_LABELS, LIMITS } from './constants.js';
import { generateId, readJsonList, writeJsonList } from './storage.js';
import {
  escapeHtml,
  hasSavableSearchState,
  normalizeSavedSearchState,
  sameSavedSearch,
  sanitizeString,
  savedSearchTimeFormatter,
} from './text.js';

const STORAGE_FAIL = 'Не удалось сохранить локально (хранилище недоступно).';

export function createSavedSearches({
  listEl,
  saveButton,
  storageKey,
  showToast,
  syncPanels,
  getCurrentSearchState,
  getSourceLabel,
  setActiveCategory,
  form,
  actions,
}) {
  function persist(value) {
    const ok = writeJsonList(storageKey, value);
    if (!ok) showToast(STORAGE_FAIL);
    return ok;
  }

  function getAll() {
    return readJsonList(storageKey)
      .map((item) => ({
        id: sanitizeString(item?.id).trim() || generateId('search'),
        ...normalizeSavedSearchState(item),
        savedAt: sanitizeString(item?.savedAt).trim() || new Date().toISOString(),
      }))
      .sort((left, right) => new Date(right.savedAt).getTime() - new Date(left.savedAt).getTime());
  }

  function findMatch(state = getCurrentSearchState()) {
    const normalized = normalizeSavedSearchState(state);
    return getAll().find((item) => sameSavedSearch(item, normalized));
  }

  function formatTitle(savedSearch) {
    const query = sanitizeString(savedSearch?.query).trim();
    if (query) return query;
    return getSourceLabel(savedSearch?.source);
  }

  function formatMeta(savedSearch) {
    const parts = [getSourceLabel(savedSearch?.source)];
    if (savedSearch?.viewAll) parts.push('Больше карточек');
    if (savedSearch?.allSources) parts.push('Все источники');
    if (savedSearch?.category && savedSearch.category !== 'all') {
      parts.push(CATEGORY_LABELS[savedSearch.category] || savedSearch.category);
    }
    parts.push(savedSearch?.translate ? 'Перевод' : 'Оригинал');
    return parts.join(' · ');
  }

  function formatTooltip(savedSearch) {
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

  function updateButton() {
    if (!saveButton) return;
    const currentState = getCurrentSearchState();
    const matchingSearch = findMatch(currentState);
    const canSave = hasSavableSearchState(currentState);

    saveButton.disabled = !canSave;
    saveButton.textContent = matchingSearch ? 'Обновить сохранённый поиск' : 'Сохранить текущий поиск';
    saveButton.title = canSave
      ? 'Сохранить текущее сочетание запроса, источника и переключателей'
      : 'Введите запрос или выберите фильтры, чтобы сохранить поиск';
  }

  function render() {
    if (!listEl) return;
    const savedSearches = getAll();
    updateButton();
    syncPanels();

    if (!savedSearches.length) {
      listEl.innerHTML = '';
      return;
    }

    listEl.innerHTML = savedSearches.map((savedSearch) => {
      const title = escapeHtml(formatTitle(savedSearch));
      const meta = escapeHtml(formatMeta(savedSearch));
      const tooltip = escapeHtml(formatTooltip(savedSearch));
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

  function saveCurrent() {
    const currentState = normalizeSavedSearchState(getCurrentSearchState());
    if (!hasSavableSearchState(currentState)) {
      showToast('Сначала введите запрос или выберите фильтры, которые хотите сохранить.');
      updateButton();
      return;
    }

    const savedSearches = getAll();
    const matchingIndex = savedSearches.findIndex((item) => sameSavedSearch(item, currentState));
    const nextSavedSearch = {
      id: matchingIndex >= 0 ? savedSearches[matchingIndex].id : generateId('search'),
      ...currentState,
      savedAt: new Date().toISOString(),
    };

    const nextSavedSearches = [
      nextSavedSearch,
      ...savedSearches.filter((_, index) => index !== matchingIndex),
    ].slice(0, LIMITS.savedSearches);

    persist(nextSavedSearches);
    render();
    showToast('Поиск сохранён.');
  }

  function apply(savedSearch) {
    if (form.topicInput) form.topicInput.value = savedSearch.query || '';
    if (form.sourceSelect) form.sourceSelect.value = savedSearch.source || '';
    if (form.translateToggle) form.translateToggle.checked = Boolean(savedSearch.translate);
    if (form.viewAllToggle) form.viewAllToggle.checked = Boolean(savedSearch.viewAll);
    if (form.allSourcesToggle) form.allSourcesToggle.checked = Boolean(savedSearch.allSources);
    setActiveCategory(savedSearch.category || 'all');

    form.topicInput?.focus();
    form.topicInput?.select();
    render();
    actions.fetch({ refresh: true });
  }

  function remove(savedSearchId) {
    persist(getAll().filter((item) => item.id !== savedSearchId));
    render();
    showToast('Сохранённый поиск удалён.');
  }

  listEl?.addEventListener('click', (event) => {
    const applyBtn = event.target.closest('[data-saved-search-apply]');
    if (applyBtn) {
      const id = sanitizeString(applyBtn.dataset.savedSearchApply).trim();
      const savedSearch = getAll().find((item) => item.id === id);
      if (savedSearch) apply(savedSearch);
      return;
    }
    const removeBtn = event.target.closest('[data-saved-search-remove]');
    if (removeBtn) {
      const id = sanitizeString(removeBtn.dataset.savedSearchRemove).trim();
      if (id) remove(id);
    }
  });

  return { getAll, render, saveCurrent, updateButton };
}
