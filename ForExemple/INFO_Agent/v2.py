# ──────────────────────────────────────────────────────────────
#  news_aggregator.py   (v3: run-button, clean UI, minor fixes)
# ──────────────────────────────────────────────────────────────
import os, re, time, pickle, hashlib, logging, pathlib, html
from datetime import datetime, timezone
from collections import defaultdict

import requests, feedparser, streamlit as st
from bs4 import BeautifulSoup
from deep_translator import GoogleTranslator
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ─── RSS-источники ────────────────────────────────────────────
NEWS_SOURCES = {
    "BBC News"        : "https://feeds.bbci.co.uk/news/world/rss.xml",
    "Reuters"         : "https://feeds.reuters.com/reuters/worldNews",
    "Al Jazeera"      : "https://www.aljazeera.com/xml/rss/all.xml",
    "Jerusalem Post"  : "https://www.jpost.com/rss/rssfeedsfrontpage.aspx",
    "Haaretz"         : "https://rsshub.app/haaretz/english",
    "Times of Israel" : "https://www.timesofisrael.com/feed/",
    "Kyiv Independent": "https://kyivindependent.com/feed/",
    "Ukrinform"       : "https://www.ukrinform.net/block-lastnews?format=feed",
    "CNN World"       : "https://rss.cnn.com/rss/edition_world.rss",
    "Guardian World"  : "https://www.theguardian.com/world/rss",
    "Associated Press": "https://apnews.com/hub/ap-top-news?outputType=rss",
    "DW"              : "https://rss.dw.com/rdf/rss-en-all",
    "Sky News"        : "https://feeds.skynews.com/feeds/rss/world.xml",
}

# ─── ключевые слова (теги) ───────────────────────────────────
KEYWORDS = [
    "israel", "israeli", "gaza", "hamas", "idf",
    "ukraine", "russia", "russian", "war", "invasion",
    "израиль", "израильский", "газа", "хамас",
    "украина", "россия", "война", "вторжение",
]
_PATTERNS = [(kw, re.compile(rf"\b{re.escape(kw)}\b", re.I)) for kw in KEYWORDS]

def find_tags(*texts: str) -> set[str]:
    joined = " ".join(texts)
    return {kw for kw, pat in _PATTERNS if pat.search(joined)}

# ─── настройки/пути ───────────────────────────────────────────
TARGET_LANG = "ru"
RAW_TTL     = 15 * 60                       # 15 минут
LOG_FILE    = "news_debug.log"
CACHE_DIR   = pathlib.Path(".rss_cache"); CACHE_DIR.mkdir(exist_ok=True)

# ─── логгер ───────────────────────────────────────────────────
def init_logger(path):
    log = logging.getLogger("NewsAgg")
    if not log.handlers:
        log.setLevel(logging.DEBUG)
        fh = logging.FileHandler(path, encoding="utf-8")
        fh.setFormatter(logging.Formatter("%(asctime)s | %(levelname)s | %(message)s"))
        log.addHandler(fh)
    return log
logger = init_logger(LOG_FILE)

# ─── перевод с кешем ──────────────────────────────────────────
@st.cache_data(ttl=24*3600, show_spinner=False)
def translate_cached(txt, target):
    return GoogleTranslator(source="auto", target=target).translate(txt)

def translate(txt: str, enabled=True):
    if not enabled or not txt:
        return txt
    try:
        # ограничим 4500 символами (лимит Google ≈5000)
        return translate_cached(txt[:4500], TARGET_LANG)
    except Exception as e:
        logger.error("Translate error: %s", e)
        return txt

# ─── утилиты ──────────────────────────────────────────────────
def clean_html(raw: str) -> str:
    if not raw:
        return ""
    txt = BeautifulSoup(raw, "lxml").get_text(" ", strip=True)
    txt = html.unescape(txt)
    return re.sub(r"\s{2,}", " ", txt).strip()

def first_image(entry) -> str | None:
    for attr in ("media_content", "media_thumbnail"):
        if attr in entry:
            for m in entry[attr]:
                if "url" in m:
                    return m["url"]
    for link in entry.get("links", []):
        if link.get("type", "").startswith("image"):
            return link.get("href")
    if "summary" in entry:
        m = re.search(r'<img .*?src="([^"]+)"', entry.summary, re.I)
        if m:
            return m.group(1)
    return None

# ─── HTTP-сессия с retry & backoff ───────────────────────────
def make_session() -> requests.Session:
    sess = requests.Session()
    retry = Retry(
        total=4, backoff_factor=1,
        status_forcelist=[401,403,404,429,500,502,503,504],
        allowed_methods=("GET", "HEAD")
    )
    adapter = HTTPAdapter(max_retries=retry)
    sess.mount("http://",  adapter)
    sess.mount("https://", adapter)
    return sess
SESSION = make_session()

SPECIAL_HEADERS = {
    "Times of Israel": {
        "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
        "accept": "application/rss+xml,application/xml;q=0.9,*/*;q=0.8",
    },
}

def proxy_url(orig: str) -> str:
    return f"https://r.jina.ai/http://{orig}"

# ─── загрузка RSS с файловым кешем ───────────────────────────
def load_raw_rss(url: str) -> bytes | None:
    fn = CACHE_DIR / (hashlib.md5(url.encode()).hexdigest() + ".pkl")
    now = time.time()

    try:
        if fn.exists():
            ts, data = pickle.loads(fn.read_bytes())
            if now - ts < RAW_TTL:
                return data

        src_name = next((k for k, v in NEWS_SOURCES.items() if v == url), "")
        headers  = {"user-agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) "
                    "Gecko/20100101 Firefox/123.0"}
        headers.update(SPECIAL_HEADERS.get(src_name, {}))

        verify = not url.startswith("https://www.aljazeera.com")

        try:
            resp = SESSION.get(url, headers=headers, timeout=20, verify=verify)
            resp.raise_for_status()
        except requests.exceptions.HTTPError:
            p_url = proxy_url(url)
            logger.warning("Retry via proxy: %s", p_url)
            resp = SESSION.get(p_url, headers=headers, timeout=20)
            resp.raise_for_status()

        data = resp.content
        fn.write_bytes(pickle.dumps((now, data)))
        return data

    except Exception as e:
        logger.error("HTTP error %s → %s", url, e)
        return None

# ─── сбор новостей ───────────────────────────────────────────
def collect_news(need_translate: bool):
    news, stats = [], defaultdict(lambda: {"total": 0, "matched": 0})
    seen = set()

    for src, url in NEWS_SOURCES.items():
        xml = load_raw_rss(url)
        if xml is None:
            continue

        feed = feedparser.parse(xml)
        stats[src]["total"] = len(feed.entries)
        logger.info("%s → %s entries", src, len(feed.entries))

        for e in feed.entries:
            link_clean = e.link.split("?", 1)[0].split("#", 1)[0]
            if link_clean in seen:
                continue
            seen.add(link_clean)

            title_o = e.title
            desc_o  = clean_html(getattr(e, "summary", "") or getattr(e, "description", ""))

            tags = find_tags(title_o, desc_o)
            if not tags:
                continue
            stats[src]["matched"] += 1

            title_t = translate(title_o, need_translate)
            desc_t  = translate(desc_o, need_translate)
            tags |= find_tags(title_t, desc_t)

            if getattr(e, "published_parsed", None):
                ts = time.mktime(e.published_parsed)
                dt = datetime.fromtimestamp(ts, tz=timezone.utc)
            else:
                dt = datetime.utcnow().replace(tzinfo=timezone.utc)

            news.append({
                "title"     : title_t,
                "orig_title": title_o,
                "desc"      : desc_t,
                "orig_desc" : desc_o,
                "image"     : first_image(e),
                "link"      : link_clean,
                "source"    : src,
                "time"      : dt,
                "tags"      : sorted(tags),
            })

    news.sort(key=lambda x: x["time"], reverse=True)
    return news, stats

# ─── UI ───────────────────────────────────────────────────────
st.set_page_config("News Aggregator", layout="wide")
st.title("🌍 Агрегатор международных новостей")

# --- SIDEBAR ---
with st.sidebar:
    st.header("⚙️ Параметры")

    # перевод
    st.checkbox("Переводить контент (ru)", True, key="tr_flag")

    # источники (ничего не выбрано по умолчанию)
    selected_sources = st.multiselect(
        "Выберите источники:",
        options=list(NEWS_SOURCES.keys()),
        default=[],
        help="Нажмите, чтобы выбрать ленты"
    )

    # теги
    selected_tags = st.multiselect(
        "Фильтр по тегам:",
        options=sorted(set(KEYWORDS)),
        default=[],
        help="Выберите ключевые слова (опционально)"
    )
    filter_mode = st.radio(
        "Режим фильтра:",
        ["OR (любой тег)", "AND (все теги)"],
        horizontal=True,
        key="filter_mode"
    )

    st.markdown("---")
    # run-button
    run_btn = st.button("🚀 Собрать новости")

    # техническая кнопка чистки кеша
    if st.button("♻️ Очистить кеш + перезапуск"):
        for f in CACHE_DIR.glob("*.pkl"):
            f.unlink(missing_ok=True)
        open(LOG_FILE, "w", encoding="utf-8").close()
        st.session_state.clear()
        st.experimental_rerun()

# --- ЛОГИКА ЗАПУСКА ---
translate_flag = st.session_state.get("tr_flag", True)

# при первом заходе, блоки в session_state инициализируем
st.session_state.setdefault("_all_news", [])
st.session_state.setdefault("_all_stats", {})
st.session_state.setdefault("_filters", {})

if run_btn:
    # забираем все новости
    news_all, stats_all = collect_news(translate_flag)

    # сохраняем в сессию
    st.session_state["_all_news"]  = news_all
    st.session_state["_all_stats"] = stats_all
    st.session_state["_filters"]   = {
        "sources": selected_sources,
        "tags"   : selected_tags,
        "mode"   : filter_mode,
    }

# --- ВЫВОД С РАНЕЕ СОБРАННЫМИ ДАННЫМИ ---
if not st.session_state["_all_news"]:
    st.info("Сначала выберите параметры и нажмите «Собрать новости».")
    st.stop()

news  = st.session_state["_all_news"]
stats = st.session_state["_all_stats"]
fset  = st.session_state["_filters"]

# фильтрация по источникам
if fset["sources"]:
    news  = [n for n in news if n["source"] in fset["sources"]]
    stats = {s: d for s, d in stats.items() if s in fset["sources"]}

# фильтрация по тегам
if fset["tags"]:
    if fset["mode"].startswith("OR"):
        news = [n for n in news if set(n["tags"]) & set(fset["tags"])]
    else:
        news = [n for n in news if set(fset["tags"]).issubset(n["tags"])]

# --- СТАТИСТИКА ---
st.subheader("📊 Статистика по лентам")
st.dataframe(
    [{"Источник": s, "Всего статей": d["total"], "Совпало": d["matched"]}
     for s, d in stats.items()],
    use_container_width=True
)

# --- ВЫВОД НОВОСТЕЙ ---
if not news:
    st.warning("Ничего не найдено под выбранные параметры.")
else:
    st.success(f"Показано новостей: {len(news)}")

    for n in news:
        st.subheader(n["title"])

        cols = st.columns([2, 5])
        with cols[0]:
            if n["image"]:
                st.image(n["image"], use_column_width=True)
        with cols[1]:
            st.write(f"**Источник:** {n['source']}")
            if n["time"]:
                st.write(f"**Дата (UTC):** {n['time'].strftime('%Y-%m-%d %H:%M')}")
            st.markdown(f"[Читать далее]({n['link']})")
            if n["tags"]:
                tag_str = "  ".join(f":blue[{t}]" for t in n["tags"])
                st.write(tag_str)

        if n["desc"]:
            st.write(n["desc"])

        with st.expander("Подробнее / оригинал"):
            if n["orig_desc"]:
                st.write(n["orig_desc"])
            st.write(f"Оригинальный заголовок: _{n['orig_title']}_")

        st.divider()