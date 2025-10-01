# ──────────────────────────────────────────────────────────────
#  News Pictogram Aggregator
# ──────────────────────────────────────────────────────────────
import os, re, time, pickle, hashlib, logging, pathlib, html
from datetime import datetime, timezone
from collections import defaultdict

import requests, feedparser, streamlit as st
from bs4 import BeautifulSoup
from deep_translator import GoogleTranslator
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from PIL import Image, ImageDraw, ImageFont

# ─── RSS Sources ──────────────────────────────────────────────
# Note: Some feeds may be unreliable. They are kept here for demonstration.
NEWS_SOURCES = {
    "BBC News"        : "https://feeds.bbci.co.uk/news/world/rss.xml",
    "Al Jazeera"      : "https://www.aljazeera.com/xml/rss/all.xml",
    "Jerusalem Post"  : "https://www.jpost.com/rss/rssfeedsfrontpage.aspx",
    "Haaretz"         : "https://rsshub.app/haaretz/english",
    "Times of Israel" : "https://www.timesofisrael.com/feed/",
    "Kyiv Independent": "https://kyivindependent.com/feed/",
    "Guardian World"  : "https://www.theguardian.com/world/rss",
    "Associated Press": "https://apnews.com/hub/ap-top-news?outputType=rss",
    "DW"              : "https://rss.dw.com/rdf/rss-en-all",
    "Sky News"        : "https://feeds.skynews.com/feeds/rss/world.xml",
}

# ─── Configuration ───────────────────────────────────────────
TARGET_LANG = "ru"
RAW_TTL     = 15 * 60  # Cache raw RSS data for 15 minutes
LOG_FILE    = "news_debug.log"
CACHE_DIR   = pathlib.Path(".rss_cache"); CACHE_DIR.mkdir(exist_ok=True)
FONT_DIR    = pathlib.Path("fonts")
FONT_BOLD_PATH = FONT_DIR / "Montserrat-Bold.woff"
FONT_REGULAR_PATH = FONT_DIR / "Montserrat-Regular.woff"


# ─── Logger ───────────────────────────────────────────────────
def init_logger(path):
    log = logging.getLogger("NewsAgg")
    if not log.handlers:
        log.setLevel(logging.INFO)
        fh = logging.FileHandler(path, encoding="utf-8")
        fh.setFormatter(logging.Formatter("%(asctime)s | %(levelname)s | %(message)s"))
        log.addHandler(fh)
    return log
logger = init_logger(LOG_FILE)

# ─── Translation ──────────────────────────────────────────
@st.cache_data(ttl=24*3600, show_spinner=False)
def translate(txt: str, enabled=True):
    """Translate text to Russian, with caching."""
    if not enabled or not txt:
        return txt
    try:
        return GoogleTranslator(source="auto", target=TARGET_LANG).translate(txt[:4500])
    except Exception as e:
        logger.error("Translate error: %s", e)
        return txt

# ─── HTML & Image Utilities ──────────────────────────────────────────────────
def clean_html(raw: str) -> str:
    if not raw: return ""
    txt = BeautifulSoup(raw, "lxml").get_text(" ", strip=True)
    return html.unescape(re.sub(r"\s{2,}", " ", txt).strip())

def first_image(entry) -> str | None:
    for attr in ("media_content", "media_thumbnail"):
        if attr in entry:
            for m in entry[attr]:
                if "url" in m: return m["url"]
    for link in entry.get("links", []):
        if link.get("type", "").startswith("image"): return link.get("href")
    if "summary" in entry:
        m = re.search(r'<img .*?src="([^"]+)"', entry.summary, re.I)
        if m: return m.group(1)
    return None

# ─── HTTP Session ───────────────────────────
def make_session() -> requests.Session:
    sess = requests.Session()
    retry = Retry(total=3, backoff_factor=1, status_forcelist=[429, 500, 502, 503, 504])
    adapter = HTTPAdapter(max_retries=retry)
    sess.mount("https://", adapter)
    sess.mount("http://", adapter)
    return sess
SESSION = make_session()

def proxy_url(orig: str) -> str:
    """Use a proxy for problematic URLs."""
    return f"https://r.jina.ai/{orig}"

# ─── RSS Fetching ───────────────────────────
def load_raw_rss(url: str) -> bytes | None:
    fn = CACHE_DIR / (hashlib.md5(url.encode()).hexdigest() + ".pkl")
    if fn.exists():
        ts, data = pickle.loads(fn.read_bytes())
        if time.time() - ts < RAW_TTL:
            return data
    try:
        headers = {"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"}
        try:
            resp = SESSION.get(url, headers=headers, timeout=20)
            resp.raise_for_status()
        except requests.exceptions.RequestException:
            p_url = proxy_url(url)
            logger.warning("Retry via proxy: %s", p_url)
            resp = SESSION.get(p_url, headers=headers, timeout=25)
            resp.raise_for_status()
        data = resp.content
        fn.write_bytes(pickle.dumps((time.time(), data)))
        return data
    except Exception as e:
        logger.error("HTTP error %s → %s", url, e)
        return None

# ─── News Collection ───────────────────────────────────────────
def collect_news(sources: dict, need_translate: bool):
    news, stats = [], defaultdict(lambda: {"total": 0, "matched": 0})
    seen = set()
    for src, url in sources.items():
        xml = load_raw_rss(url)
        if not xml: continue
        feed = feedparser.parse(xml)
        stats[src]["total"] = len(feed.entries)
        logger.info("%s → %s entries", src, len(feed.entries))
        for e in feed.entries:
            link_clean = e.link.split("?", 1)[0]
            if link_clean in seen: continue
            seen.add(link_clean)

            title_o = e.title
            desc_o = clean_html(getattr(e, "summary", "") or getattr(e, "description", ""))

            title_t = translate(title_o, need_translate)
            desc_t = translate(desc_o, need_translate)

            dt = datetime.utcnow().replace(tzinfo=timezone.utc)
            if hasattr(e, "published_parsed") and e.published_parsed:
                dt = datetime.fromtimestamp(time.mktime(e.published_parsed), tz=timezone.utc)

            news.append({
                "title": title_t, "orig_title": title_o,
                "desc": desc_t, "orig_desc": desc_o,
                "image": first_image(e), "link": link_clean,
                "source": src, "time": dt,
            })
    news.sort(key=lambda x: x["time"], reverse=True)
    return news, stats

# ─── Pictogram Generation ───────────────────────────────────
@st.cache_resource
def get_font(font_path, size):
    """Load a font and cache it."""
    if not font_path.exists():
        logger.error(f"Font not found: {font_path}")
        return ImageFont.load_default()
    return ImageFont.truetype(str(font_path), size)

def wrap_text(text: str, font, max_width: int):
    """Wrap text to fit within a specified width."""
    lines = []
    if not text: return lines
    for line in text.split('\n'):
        words = line.split(' ')
        current_line = ''
        for word in words:
            if font.getlength(current_line + word) <= max_width:
                current_line += word + ' '
            else:
                lines.append(current_line.strip())
                current_line = word + ' '
        lines.append(current_line.strip())
    return lines

@st.cache_data(show_spinner=False)
def create_pictogram(title: str, summary: str, width=800, height=400):
    """Generate a constructivist-style pictogram for a news item."""
    BG_COLOR, RECT_COLOR, TEXT_COLOR = "white", "#D32F2F", "black"

    title_font = get_font(FONT_BOLD_PATH, 42)
    summary_font = get_font(FONT_REGULAR_PATH, 22)

    img = Image.new("RGB", (width, height), color=BG_COLOR)
    draw = ImageDraw.Draw(img)

    draw.rectangle([0, 0, width // 3, height], fill=RECT_COLOR)

    text_x = width // 3 + 20
    text_width = width - text_x - 20

    title_lines = wrap_text(title, title_font, text_width)
    y = 40
    for line in title_lines[:3]: # Limit title lines
        draw.text((text_x, y), line, font=title_font, fill=TEXT_COLOR)
        y += 50

    y += 10
    summary_lines = wrap_text(summary, summary_font, text_width)
    for line in summary_lines[:5]: # Limit summary lines
        draw.text((text_x, y), line, font=summary_font, fill=TEXT_COLOR)
        y += 30
        if y > height - 40: break

    return img

# ─── UI ───────────────────────────────────────────────────────
st.set_page_config("News Pictogram Aggregator", layout="wide")
st.title("📰 Новости в плакатах")

# --- Sidebar ---
with st.sidebar:
    st.header("⚙️ Настройки")
    st.checkbox("Переводить на русский", True, key="tr_flag")

    selected_sources = st.multiselect(
        "Выберите источники:",
        options=list(NEWS_SOURCES.keys()),
        default=list(NEWS_SOURCES.keys())[:3]
    )

    if st.button("♻️ Очистить кеш"):
        st.cache_data.clear()
        st.cache_resource.clear()
        st.experimental_rerun()

# --- Main Logic ---
if not selected_sources:
    st.info("Пожалуйста, выберите хотя бы один источник в боковой панели.")
    st.stop()

sources_to_fetch = {k: v for k, v in NEWS_SOURCES.items() if k in selected_sources}

with st.spinner("Загрузка и обработка новостей..."):
    news_items, stats = collect_news(sources_to_fetch, st.session_state.tr_flag)

# --- Display News ---
if not news_items:
    st.warning("Не удалось найти новости по выбранным источникам.")
else:
    st.success(f"Найдено новостей: {len(news_items)}")
    for n in news_items:
        pictogram_img = create_pictogram(n["title"], n["desc"])
        st.image(pictogram_img, use_column_width=True)

        with st.expander(f"Подробнее: {n['orig_title']}"):
            st.write(f"**Источник:** {n['source']}")
            st.write(f"**Время:** {n['time'].strftime('%Y-%m-%d %H:%M UTC')}")
            st.markdown(f"**Ссылка:** [{n['link']}]({n['link']})")
            if n["image"]:
                st.image(n["image"], caption="Original Image")
            st.markdown(f"--- \n **Оригинал описания:** \n {n['orig_desc']}")
        st.divider()