# PLAN.md — Улучшения news_agregator

**Фокус:** скорость · дизайн · производительность  
**Дата аудита:** 2026-07-21  
**Стек:** Express + static frontend (HTML/CSS/JS) · деплой Vercel

---

## 1. Краткий аудит текущего состояния

### Что уже хорошо
- LRU-кэш RSS (5 мин) + переводов (24 ч), dedup pending-запросов
- Ограничение concurrency (10 фидов / 5 переводов)
- Фоновый pre-fetch / pre-translate (локально)
- AbortController на клиенте, debounce 220 ms на ввод
- Клиентский кэш статей для смены категории / языка без повторного запроса
- Скелетоны, empty/error states, a11y-базисы (`prefers-reduced-motion`, focus-visible)
- Rate limit, CSP, валидация query/source

### Главные проблемы

| Область | Проблема | Влияние |
|--------|----------|---------|
| **Скорость API** | Cold search тянет до **28 RSS** (батчи по 10) + перевод запроса + до 10×2 перевода | TTFB 3–15+ с на cold cache |
| **Vercel** | In-memory cache **не шарится** между инстансами; `startBackgroundJobs` **не работает** в serverless | Каждый cold start = полный обход фидов |
| **Перевод** | Неофициальный Google `gtx`; очередь 5; только top‑10 title/snippet; модалка ждёт перевод fullText | Латентность + хрупкость |
| **Фронт payload** | Bootstrap CSS+JS CDN + Google Fonts (2 семьи) + `style.css` 42 KB + `main.js` 53 KB | Медленный FCP/LCP |
| **Рендер** | Нет `loading="lazy"` на карточках; fallback `picsum.photos`; много `backdrop-filter` | Лишние запросы, jank на mobile |
| **UX/дизайн** | Hero + search + saved + favorites + tabs + stats = перегруженный first screen; нет dark mode; Bootstrap почти не нужен | Визуальный шум, «не Apple» |
| **Мёртвый вес** | `fonts/Montserrat*`, `montserrat.zip` не используются | +~250 KB в репо, путаница |

---

## 2. Целевые метрики (после улучшений)

| Метрика | Сейчас (оценка) | Цель |
|---------|-----------------|------|
| First Contentful Paint | 1.5–3 s (CDN fonts) | **< 1.0 s** |
| `/api/search` warm (без query) | 50–300 ms | **< 150 ms** |
| `/api/search` cold (все источники) | 5–15 s | **< 2.5 s** (stale-while-revalidate) |
| Largest Contentful Paint | 3–6 s | **< 2.5 s** |
| CLS | низкий | **< 0.1** (фиксированные aspect-ratio уже есть) |
| JS на critical path | ~Bootstrap bundle + 53 KB | **< 40 KB** gzip app JS, Bootstrap optional/removed |

---

## 3. Производительность бэкенда (P0–P1)

### 3.1 Stale-while-revalidate для RSS  **[P0, скорость]**
Сейчас: cache miss → ждать все фиды.

**План:**
1. Хранить `{ value, expires, staleUntil }` в `LRUCache`.
2. На miss с истёкшим TTL, но `now < staleUntil` — **сразу отдать stale**, в фоне обновить.
3. TTL: fresh 5 мин, stale window +15–30 мин.
4. На `refresh=true` — принудительный revalidate (как сейчас), но ответ можно стримить/отдавать partial.

**Файлы:** `server.js` (`LRUCache`, `RSSService.fetchFeed`, `SearchService.search`)

### 3.2 Кэш результата поиска  **[P0]**
Ключ: `search:${source||'all'}:${normalizedQuery}:${viewAll}`.

- TTL 60–120 с (короче RSS).
- Не кэшировать при `refresh=true`.
- Снижает повторные score/dedup/translate на один и тот же запрос.

### 3.3 Параллельный поиск без полного wait  **[P1]**
Сейчас: 3 последовательных батча по 10 фидов.

**Варианты (выбрать один):**
- **A.** Поднять `MAX_CONCURRENT_FEEDS` до 15–20 + timeout 6–8 s (проще).
- **B.** Progressive response: SSE/`Transfer-Encoding` chunks — сначала быстрые фиды (BBC, HN), потом остальные (сложнее, лучший UX).
- **C.** Tiered sources: «быстрый набор» (8–10 ключевых) для default view, full set только при `view_all` / category.

**Рекомендация:** C + A — default path = top tier, `view_all` = all.

### 3.4 Перевод: не блокировать выдачу  **[P0]**
Сейчас API ждёт перевод top‑10 title+snippet.

**План:**
1. Отдавать статьи **сразу** с `title`/`snippet`; поля `*_ru` — если уже в translation cache.
2. Клиент: если `translate` on и нет `title_ru` — lazy `POST /api/translate` batch или per-card (с лимитом concurrency 3).
3. Модалка: skeleton текста → async translate (уже почти так, добавить skeleton UI).
4. Опционально: batch endpoint `POST /api/translate/batch` `{ texts: string[] }` → меньше round-trips.

### 3.5 Serverless-aware cache  **[P1, Vercel]**
In-memory на Vercel ephemeral.

**План (поэтапно):**
1. **MVP:** document that warm cache works only on long-lived Node (`npm start`); for Vercel use longer client cache + aggressive SWR.
2. **Next:** optional Redis/Upstash или Vercel KV для RSS + translations.
3. Background job: вынести в cron (`vercel.json` crons) `GET /api/cron/warmup` с secret header — pre-fetch tier sources.

### 3.6 Мелкие backend win  **[P2]**
- Заменить `node-fetch@2` на **native `fetch`** (Node ≥18) — меньше deps.
- `compression` middleware (или Vercel edge compression) для JSON.
- `Cache-Control` на static: `/css`, `/js`, `/fonts` → `public, max-age=604800, immutable` (+ content hash или query version).
- ETag / short cache на `/api/sources`.
- Уменьшить `fullText` в JSON (сейчас до 4 KB × N) — отдавать только по запросу `/api/article/:id` или при open modal; **сэкономит payload 30–70%**.
- Fail-soft: partial results если часть фидов упала (уже `[]` per feed) — добавить в response `meta.sourcesFailed`.

---

## 4. Производительность и скорость фронтенда (P0–P1)

### 4.1 Critical path / assets  **[P0]**
1. **Убрать Bootstrap JS**, если modal можно на 30–40 строках native dialog / custom modal (Bootstrap используется в основном для Modal + `d-none` / grid helpers).
2. **Убрать Bootstrap CSS** или оставить только utility subset; сейчас кастомный `style.css` перекрывает почти всё.
3. Google Fonts → **self-host 2 woff2** (Manrope 500/700 + Space Grotesk 700) с `font-display: swap` + `preload`.
4. Удалить неиспользуемые `fonts/Montserrat*`, `montserrat.zip`.
5. `main.js`: `defer` (уже в конце body OK); рассмотреть split: `app-core.js` + lazy `favorites/stats` не критично при 53 KB.
6. CSS: убрать избыточные `will-change`, сократить `backdrop-filter` (см. дизайн).

### 4.2 Рендер ленты  **[P0]**
1. `loading="lazy"` + `decoding="async"` на всех card images.
2. `fetchpriority="high"` только для первых 2–3 visible cards.
3. Заменить **picsum.photos** fallback на локальный SVG/CSS gradient placeholder (нет внешнего RTT, нет layout jump).
4. Virtualize при `view_all` (100 items) — простой windowing или «показать ещё 20» вместо 100 DOM-карточек сразу.
5. Не пересоздавать весь DOM при toggle translate, если можно swap text nodes (опционально; re-render fragment уже приемлем).

### 4.3 Сетевые запросы UX  **[P1]**
1. Client response cache (Map + sessionStorage) по URL search params, TTL 60 s.
2. Debounce input: 220 ms → **400–500 ms**; Enter / chip / select — immediate.
3. Prefetch: при hover на quick-topic / saved-search — `fetch` в idle.
4. Stale UI: при re-search показывать предыдущую ленту semi-opaque + top progress bar вместо полного skeleton wipe (меньше «мигания»).
5. Service Worker (optional P2): cache shell + last feed offline.

### 4.4 JS-гигиена  **[P2]**
- `getFavoriteArticles()` читает localStorage на **каждый** card / sync — кэшировать в памяти, invalidate on write.
- `clientArticlesCache.find` → `Map` по article key (O(1)).
- Event listeners на stats badges — event delegation вместо N listeners.

---

## 5. Дизайн и UX (P0–P2)

### 5.1 Информационная архитектура first screen  **[P0]**
Сейчас вертикальный стек слишком длинный до новостей:

```
Hero → Search → Quick topics → Saved searches → Categories → Favorites → Feedback → Cards
```

**Предлагаемая иерархия:**
1. **Compact header** (logo + title в одну строку, subtitle hide on scroll/mobile).
2. **Search bar sticky** (source + query + primary button).
3. **Chips row:** quick topics + category tabs в одной линии (scroll-x mobile).
4. **Secondary row:** translate · view all · layout · stats · refresh.
5. **Лента сразу.**
6. Saved searches / Favorites — **collapsible** («Сохранённое ▾») или drawer/sheet; default collapsed если empty.

### 5.2 Визуальная система  **[P1]**
Уже есть Apple-like tokens — довести consistency:

| Тема | Действие |
|------|----------|
| **Dark mode** | `prefers-color-scheme` + toggle; CSS variables invert |
| **Glassmorphism** | Оставить blur **только** на sticky header / modal; убрать с body, surface, favorites (GPU) |
| **Карточки** | Единый radius 20px; source badge color per source hash; image placeholder brand-tint |
| **Типографика** | Title 1.05–1.1 line-height; meta tabular-nums; меньше uppercase labels |
| **Плотность** | List view = default на mobile; grid на desktop |
| **Motion** | Stagger max 6 items; `content-visibility: auto` на offscreen cards |
| **Empty favorites** | Не показывать большую панель — одна строка «☆ Избранное» |

### 5.3 Состояния и feedback  **[P1]**
- Top thin progress bar при fetch (вместо/вместе со spinner block).
- Toast для «добавлено в избранное» (auto-dismiss 2 s) вместо замены search-feedback.
- Modal: image skeleton + text skeleton пока translate.
- Offline banner (`navigator.onLine`).
- Показать `count` + время ответа / «обновлено N мин назад» из cache meta.

### 5.4 Контент-дизайн  **[P2]**
- Favicon + Open Graph + apple-touch-icon.
- Source logos (optional sprite) вместо text-only badge.
- Reading progress в modal.
- Share button (Web Share API).

### 5.5 A11y polish  **[P2]**
- `aria-busy` на feed region.
- Skip link «к ленте».
- Modal focus trap если уходим с Bootstrap.
- Contrast check gray-on-gray labels.

---

## 6. Дорожная карта PR (рекомендуемый порядок)

### PR1 — Quick wins (1–2 дня) · скорость + perf
- [ ] lazy images, local image placeholder (no picsum)
- [ ] Cache-Control static assets
- [ ] memory Map для favorites + article keys
- [ ] debounce 450 ms; keep previous feed while loading
- [ ] remove dead Montserrat assets
- [ ] preload self-hosted fonts (или system stack first)

**Ожидаемый эффект:** −30–50% LCP, меньше layout thrash.

### PR2 — API latency (2–3 дня) · скорость
- [ ] SWR RSS cache
- [ ] search-result cache
- [ ] tiered sources for default path
- [ ] non-blocking translations (return EN first, fill RU async)
- [ ] strip `fullText` from list payload

**Ожидаемый эффект:** warm <150 ms; cold perceived <1 s (stale) / real cold <3 s.

### PR3 — UI densification (2–3 дня) · дизайн
- [ ] compact sticky header + search
- [ ] collapse favorites/saved
- [ ] merge chips + categories
- [ ] reduce backdrop-filter surfaces
- [ ] dark mode tokens
- [ ] mobile list-default

**Ожидаемый эффект:** новости выше fold; «чище» Apple-feel.

### PR4 — Bootstrap exit + modal (1–2 дня) · perf + дизайн
- [ ] native modal / dialog
- [ ] drop Bootstrap CSS/JS
- [ ] slim utility classes in style.css
- [ ] CSP simplify (no cdn.jsdelivr)

**Ожидаемый эффект:** −150–250 KB network; быстрее parse.

### PR5 — Platform (optional) · production
- [ ] Upstash/Redis shared cache
- [ ] Vercel cron warmup
- [ ] batch translate endpoint
- [ ] optional SW offline shell
- [ ] metrics: `/health` + search latency histogram log

---

## 7. Детализация ключевых изменений (спека)

### 7.1 SWR cache (псевдокод)
```js
get(key) {
  const item = map.get(key);
  if (!item) return { status: 'miss' };
  if (item.expires > now) return { status: 'fresh', value: item.value };
  if (item.staleUntil > now) return { status: 'stale', value: item.value };
  map.delete(key);
  return { status: 'miss' };
}
// fetchFeed: if stale → return value, trigger background refresh once
```

### 7.2 Response shape (list without fullText)
```json
{
  "ok": true,
  "count": 30,
  "cached": true,
  "generatedAt": "ISO",
  "results": [{
    "id": "...",
    "title": "...",
    "title_ru": null,
    "snippet": "...",
    "snippet_ru": null,
    "link": "...",
    "imageUrl": null,
    "source": "bbc",
    "sourceTitle": "BBC News",
    "publishedAt": "...",
    "publishedAtMs": 0
  }]
}
```
`fullText` → `GET /api/article?source=&id=` или клиентский fetch original (если RSS-only snippet).

### 7.3 CSS tokens dark
```css
@media (prefers-color-scheme: dark) {
  :root {
    --text-primary: #F5F5F7;
    --bg-primary: #1C1C1E;
    --canvas-mid: #000;
    --border-color: #38383A;
  }
}
```

### 7.4 Layout wire (mobile)
```
┌─────────────────────────┐
│  Новостной Агрегатор    │  sticky compact
│  [источник▾][поиск…][↗] │
│  Все Тех Биз Мир …  →   │  horizontal tabs
│  🌐ru  ⊞grid  ↻         │
├─────────────────────────┤
│  ▦ card / list item     │
│  ▦                      │
└─────────────────────────┘
```

---

## 8. Риски и ограничения

| Риск | Митигация |
|------|-----------|
| Google Translate `gtx` rate-limit / ToS | Очередь, cache, optional official API key later |
| SWR отдаёт устаревшие новости | Badge «кэш · N мин»; refresh button clear |
| Drop Bootstrap ломает modal a11y | Тесты focus trap + keyboard |
| Redis добавляет ops cost | Feature-flag; in-memory fallback |
| Progressive/SSE сложнее Vercel | Начать с tiered sources, SSE later |

---

## 9. Проверка (acceptance)

После PR1–PR3:
1. `npm test` — зелёный; добавить тесты SWR + search cache + payload без fullText.
2. Lighthouse mobile: Perf ≥ 85, a11y ≥ 90.
3. Cold `/api/search` (tier) p95 < 3 s; warm p95 < 200 ms.
4. Визуально: лента видна без скролла &gt;1 viewport на 390×844.
5. Dark mode без «белых вспышек» на карточках.
6. Нет запросов к `picsum.photos` / `fonts.googleapis.com` (после self-host).

---

## 10. Итог приоритетов (одна страница)

**Сделать в первую очередь (максимум impact / effort):**
1. Non-blocking translate + strip fullText from list  
2. SWR RSS + search cache + tiered sources  
3. Lazy images + local placeholders  
4. Compact UI: sticky search, collapse secondary panels  
5. Drop Bootstrap + self-host fonts  
6. Dark mode + lighter glass effects  
7. Shared cache / cron warmup for Vercel  

Это превращает «красивый, но тяжёлый агрегатор» в **быстрый reader**: мгновенная warm-выдача, предсказуемый cold path, чистый first screen.
