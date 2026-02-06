"""FastAPI implementation of the news pictogram aggregator for Vercel."""
from __future__ import annotations

import base64
import hashlib
import io
import os
import pathlib
import re
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import lru_cache, partial
from typing import Dict, Iterable, List, Optional, Tuple

import feedparser
import requests
from bs4 import BeautifulSoup
from deep_translator import GoogleTranslator
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from jinja2 import Environment, FileSystemLoader, select_autoescape
from PIL import Image, ImageDraw, ImageFont
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ─── Configuration ─────────────────────────────────────────────────────────────
TARGET_LANG = os.environ.get("NEWS_TARGET_LANG", "ru")
CACHE_TTL = int(os.environ.get("NEWS_CACHE_TTL", 15 * 60))  # seconds
ITEMS_PER_SOURCE = int(os.environ.get("NEWS_ITEMS_PER_SOURCE", 50))
VIEW_MODEL_WORKERS = int(os.environ.get("NEWS_VIEW_MODEL_WORKERS", 10))
CACHE_DIR = pathlib.Path(os.environ.get("NEWS_CACHE_DIR", "/tmp/rss_cache"))
CACHE_DIR.mkdir(exist_ok=True)

VIEW_MODEL_EXECUTOR = ThreadPoolExecutor(max_workers=VIEW_MODEL_WORKERS)

NEWS_SOURCES: Dict[str, str] = {
    "BBC News": "https://feeds.bbci.co.uk/news/world/rss.xml",
    "Al Jazeera": "https://www.aljazeera.com/xml/rss/all.xml",
    "Jerusalem Post": "https://www.jpost.com/rss/rssfeedsfrontpage.aspx",
    "Haaretz": "https://rsshub.app/haaretz/english",
    "Times of Israel": "https://www.timesofisrael.com/feed/",
    "Kyiv Independent": "https://kyivindependent.com/feed/",
    "Guardian World": "https://www.theguardian.com/world/rss",
    "Associated Press": "https://apnews.com/hub/ap-top-news?outputType=rss",
    "Deutsche Welle": "https://rss.dw.com/rdf/rss-en-all",
    "Sky News": "https://feeds.skynews.com/feeds/rss/world.xml",
    "France 24": "https://www.france24.com/en/rss",
    "The New York Times": "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
    "TASS": "https://tass.com/rss/v2.xml",
    "The Moscow Times": "https://www.themoscowtimes.com/rss/news",
    "CBC": "https://www.cbc.ca/cmlink/rss-topstories",
    "The Japan Times": "https://www.japantimes.co.jp/feed/",
}

ACCENT_COLORS = [
    "#d62828",
    "#003049",
    "#f77f00",
    "#2a9d8f",
    "#780116",
    "#0a2463",
]

TOKEN_PATTERN = re.compile(r"[\w\-]+", re.UNICODE)

CYRILLIC_TO_LATIN = {
    "а": "a",
    "б": "b",
    "в": "v",
    "г": "g",
    "д": "d",
    "е": "e",
    "ё": "e",
    "ж": "zh",
    "з": "z",
    "и": "i",
    "й": "i",
    "к": "k",
    "л": "l",
    "м": "m",
    "н": "n",
    "о": "o",
    "п": "p",
    "р": "r",
    "с": "s",
    "т": "t",
    "у": "u",
    "ф": "f",
    "х": "h",
    "ц": "ts",
    "ч": "ch",
    "ш": "sh",
    "щ": "shch",
    "ъ": "",
    "ы": "y",
    "ь": "",
    "э": "e",
    "ю": "yu",
    "я": "ya",
}

# ─── HTTP Session ─────────────────────────────────────────────────────────────
def _build_session() -> requests.Session:
    session = requests.Session()
    retry = Retry(total=3, backoff_factor=1, status_forcelist=(429, 500, 502, 503, 504))
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    session.headers.update(
        {
            "user-agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/118.0.0.0 Safari/537.36"
            )
        }
    )
    return session

SESSION = _build_session()


def tokenize(text: str) -> List[str]:
    if not text:
        return []
    return [token for token in TOKEN_PATTERN.findall(text.lower()) if token]


def transliterate_cyrillic(text: str) -> str:
    if not text:
        return ""
    return "".join(CYRILLIC_TO_LATIN.get(char, char) for char in text.lower())


def build_query_groups(query: str) -> List[Tuple[str, ...]]:
    tokens = tokenize(query)
    groups: List[Tuple[str, ...]] = []
    for token in tokens:
        variants = {token}
        transliterated = transliterate_cyrillic(token)
        if transliterated and transliterated != token:
            variants.add(transliterated)
        groups.append(tuple(sorted(variants)))
    return groups


@lru_cache(maxsize=8)
def _get_translator(target_lang: str) -> GoogleTranslator:
    return GoogleTranslator(source="auto", target=target_lang)


# ─── Utility Helpers ───────────────────────────────────────────────────────────
@lru_cache(maxsize=512)
def translate_text(text: str, target_lang: str = TARGET_LANG) -> str:
    if not text:
        return ""
    try:
        translator = _get_translator(target_lang)
        return translator.translate(text[:4500])
    except Exception:
        # If translation fails, return original text.
        return text


def clean_html(raw: str) -> str:
    if not raw:
        return ""
    text = BeautifulSoup(raw, "html.parser").get_text(" ", strip=True)
    text = re.sub(r"\s{2,}", " ", text)
    return text.strip()


def first_image(entry) -> Optional[str]:
    for attr in ("media_content", "media_thumbnail"):
        if attr in entry:
            for media in entry[attr]:
                if isinstance(media, dict) and media.get("url"):
                    return media["url"]
    for link in entry.get("links", []):
        if isinstance(link, dict) and link.get("type", "").startswith("image"):
            return link.get("href")
    summary = getattr(entry, "summary", None)
    if summary:
        match = re.search(r'<img[^>]+src="([^"]+)"', summary, re.I)
        if match:
            return match.group(1)
    return None


def load_raw_rss(url: str) -> Optional[bytes]:
    cache_file = CACHE_DIR / f"{hashlib.md5(url.encode()).hexdigest()}.bin"
    if cache_file.exists():
        try:
            ts_raw, payload = cache_file.read_bytes().split(b"\n", 1)
            timestamp = float(ts_raw)
        except ValueError:
            timestamp, payload = 0.0, b""
        if payload and (time.time() - timestamp) < CACHE_TTL:
            return payload
    try:
        response = SESSION.get(url, timeout=20)
        response.raise_for_status()
        payload = response.content
        cache_file.write_bytes(f"{time.time()}\n".encode() + payload)
        return payload
    except requests.RequestException:
        return None


def _select_accent(seed: str) -> str:
    digest = hashlib.sha1(seed.encode("utf-8", "ignore")).digest()
    return ACCENT_COLORS[digest[0] % len(ACCENT_COLORS)]


@dataclass
class NewsItem:
    title: str
    description: str
    link: str
    source: str
    published: datetime
    image: Optional[str]
    orig_title: str
    orig_description: str
    accent: str
    search_tokens: set[str] = field(default_factory=set, init=False, repr=False)
    _pictograms: Dict[Tuple[str, str], str] = field(default_factory=dict, init=False, repr=False)
    _translations: Dict[str, Tuple[str, str]] = field(default_factory=dict, init=False, repr=False)

    def update_search_tokens(self) -> None:
        tokens: set[str] = set()
        for value in (
            self.title,
            self.description,
            self.orig_title,
            self.orig_description,
            self.source,
        ):
            tokens.update(tokenize(value))
        self.search_tokens = tokens

    def translated(self, target_lang: str = TARGET_LANG) -> Tuple[str, str]:
        if target_lang not in self._translations:
            translated_title = translate_text(self.orig_title, target_lang)
            translated_desc = translate_text(self.orig_description, target_lang)
            self._translations[target_lang] = (translated_title, translated_desc)
        return self._translations[target_lang]

    def pictogram(self, title_text: str, summary_text: str) -> str:
        key = (title_text, summary_text)
        if key not in self._pictograms:
            self._pictograms[key] = create_pictogram(title_text, summary_text, self.accent, self.image)
        return self._pictograms[key]


class NewsCache:
    def __init__(self) -> None:
        self.timestamp = 0.0
        self.items: List[NewsItem] = []
        self._token_index: Dict[str, set[int]] = {}
        self._search_cache: Dict[Tuple[str, ...], List[int]] = {}

    def _rebuild_index(self) -> None:
        self._token_index = {}
        for idx, item in enumerate(self.items):
            if not item.search_tokens:
                item.update_search_tokens()
            for token in item.search_tokens:
                self._token_index.setdefault(token, set()).add(idx)
        self._search_cache.clear()

    def refresh(self) -> None:
        def _fetch_one_feed(feed_info: Tuple[str, str]) -> List[NewsItem]:
            source, url = feed_info
            feed_bytes = load_raw_rss(url)
            if not feed_bytes:
                return []
            parsed = feedparser.parse(feed_bytes)
            entries = parsed.entries[:ITEMS_PER_SOURCE]
            items: List[NewsItem] = []
            for entry in entries:
                link = getattr(entry, "link", "").split("?", 1)[0]
                if not link:
                    continue
                original_title = getattr(entry, "title", "")
                raw_summary = getattr(entry, "summary", "") or getattr(entry, "description", "")
                original_description = clean_html(raw_summary)
                published = datetime.now(timezone.utc)
                if getattr(entry, "published_parsed", None):
                    published = datetime.fromtimestamp(
                        time.mktime(entry.published_parsed), tz=timezone.utc
                    )
                item = NewsItem(
                    title=original_title,
                    description=original_description,
                    link=link,
                    source=source,
                    published=published,
                    image=first_image(entry),
                    orig_title=original_title,
                    orig_description=original_description,
                    accent=_select_accent(link or source),
                )
                items.append(item)
            return items

        with ThreadPoolExecutor() as executor:
            results = list(executor.map(_fetch_one_feed, NEWS_SOURCES.items()))

        aggregated: List[NewsItem] = []
        seen_links = set()

        # Flatten the list of lists
        all_items = [item for sublist in results for item in sublist]

        # Sort by date before deduplicating to keep the most recent ones if any source has duplicates
        all_items.sort(key=lambda x: x.published, reverse=True)

        for item in all_items:
            if item.link not in seen_links:
                aggregated.append(item)
                seen_links.add(item.link)

        # The list is already sorted by date
        self.items = aggregated
        self.timestamp = time.time()
        self._rebuild_index()

    def get_items(self) -> List[NewsItem]:
        if not self.items or (time.time() - self.timestamp) > CACHE_TTL:
            self.refresh()
        return self.items

    def search(self, query: str, items: Optional[List[NewsItem]] = None) -> List[NewsItem]:
        if items is None:
            items = self.get_items()
        token_groups = build_query_groups(query)
        if not token_groups:
            return list(items)

        cache_key = tuple(token_groups)
        cached_indexes = self._search_cache.get(cache_key)
        if cached_indexes is not None:
            return [items[idx] for idx in cached_indexes if idx < len(items)]

        if not self._token_index:
            self._rebuild_index()

        candidate_ids: Optional[set[int]] = None
        for variants in token_groups:
            variant_matches: set[int] = set()
            for token in variants:
                matches = self._token_index.get(token)
                if matches:
                    variant_matches.update(matches)
            if not variant_matches:
                candidate_ids = set()
                break
            candidate_ids = (
                variant_matches if candidate_ids is None else candidate_ids & variant_matches
            )

        if not candidate_ids:
            self._search_cache[cache_key] = []
            return []

        ordered_indexes = [idx for idx, _ in enumerate(items) if idx in candidate_ids]
        self._search_cache[cache_key] = ordered_indexes
        return [items[idx] for idx in ordered_indexes]


NEWS_CACHE = NewsCache()

# ─── Pictogram Rendering ───────────────────────────────────────────────────────
def _measure_text(font: ImageFont.FreeTypeFont, text: str) -> float:
    if hasattr(font, "getlength"):
        return font.getlength(text)
    return font.getsize(text)[0]


@lru_cache(maxsize=32)
def get_font(name: str, size: int) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(name, size)
    except OSError:
        return ImageFont.load_default()


def wrap_text(text: str, font: ImageFont.FreeTypeFont, max_width: int) -> List[str]:
    words = text.split()
    if not words:
        return []
    lines: List[str] = []
    current = words[0]
    for word in words[1:]:
        candidate = f"{current} {word}"
        if _measure_text(font, candidate) <= max_width:
            current = candidate
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


def create_pictogram(title: str, summary: str, accent: str, image_url: Optional[str] = None) -> str:
    key = (title, summary, accent, image_url or "")
    return _create_pictogram_cached(key)


@lru_cache(maxsize=128)
def _create_pictogram_cached(key: Tuple[str, str, str, str]) -> str:
    title, summary, accent, image_url = key
    """Create a pictogram image and optionally embed the original image (image_url) into the left accent panel.
    Returns base64-encoded PNG bytes as string.
    """
    width, height = 720, 360
    base = Image.new("RGB", (width, height), "#f4f1de")
    draw = ImageDraw.Draw(base)

    left_w = int(width * 0.28)
    draw.rectangle([(0, 0), (left_w, height)], fill=accent)

    # If there's an original image URL, try to fetch and paste it into the left panel
    if image_url:
        try:
            resp = SESSION.get(image_url, timeout=10)
            resp.raise_for_status()
            img_orig = Image.open(io.BytesIO(resp.content)).convert("RGB")

            # compute target area inside left panel with padding
            padding = 12
            target_w = left_w - padding * 2
            target_h = height - padding * 2

            ow, oh = img_orig.size
            ratio = min(target_w / ow, target_h / oh)
            new_size = (max(1, int(ow * ratio)), max(1, int(oh * ratio)))
            img_thumb = img_orig.resize(new_size, Image.LANCZOS)

            paste_x = padding + (target_w - new_size[0]) // 2
            paste_y = padding + (target_h - new_size[1]) // 2

            # create a rounded background for better contrast
            bg = Image.new("RGB", (target_w, target_h), accent)
            base.paste(bg, (padding, padding))
            base.paste(img_thumb, (paste_x, paste_y))
        except Exception:
            # if any error occurs while fetching/processing image, ignore and continue
            pass
    draw.polygon(
        [
            (width * 0.32, 0),
            (width * 0.62, height * 0.12),
            (width * 0.38, height * 0.42),
        ],
        fill="#1b1b1b",
    )
    draw.rectangle([(width * 0.35, height * 0.68), (width * 0.85, height * 0.82)], fill="#d62828")

    title_font = get_font("DejaVuSans-Bold.ttf", 38)
    summary_font = get_font("DejaVuSans.ttf", 22)

    title_area_x = int(width * 0.33)
    title_area_width = int(width * 0.62)

    title_lines = wrap_text(title.upper(), title_font, title_area_width)
    y = 36
    for line in title_lines[:3]:
        draw.text((title_area_x, y), line, fill="#0b090a", font=title_font)
        y += title_font.size + 6

    summary_lines = wrap_text(summary, summary_font, title_area_width)
    y += 14
    for line in summary_lines[:4]:
        draw.text((title_area_x, y), line, fill="#343a40", font=summary_font)
        y += summary_font.size + 4

    buffer = io.BytesIO()
    base.save(buffer, format="PNG", optimize=True)
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


# ─── Presentation Helpers ──────────────────────────────────────────────────────
def format_datetime(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%d %b %Y, %H:%M UTC")


def humanize_delta(dt: datetime) -> str:
    delta = datetime.now(timezone.utc) - dt
    seconds = int(delta.total_seconds())
    if seconds < 60:
        return "только что"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes} мин назад"
    hours = minutes // 60
    if hours < 24:
        return f"{hours} ч назад"
    days = hours // 24
    return f"{days} дн назад"


def _process_view_model_item(item: NewsItem, translate_enabled: bool) -> dict:
    if translate_enabled:
        translated_title, translated_desc = item.translated()
    else:
        translated_title, translated_desc = item.orig_title, item.orig_description

    title_display = translated_title or item.orig_title
    summary_display = translated_desc or item.orig_description or title_display
    pictogram = item.pictogram(title_display, summary_display)
    return {
        "title_display": title_display,
        "summary_display": summary_display,
        "orig_title": item.orig_title,
        "orig_desc": item.orig_description,
        "link": item.link,
        "image": item.image,
        "source": item.source,
        "time": format_datetime(item.published),
        "relative_time": humanize_delta(item.published),
        "pictogram": pictogram,
        "accent": item.accent,
    }


def prepare_view_models(items: Iterable[NewsItem], translate_enabled: bool) -> List[dict]:
    process_func = partial(_process_view_model_item, translate_enabled=translate_enabled)
    return list(VIEW_MODEL_EXECUTOR.map(process_func, items))


# ─── FastAPI App ───────────────────────────────────────────────────────────────
app = FastAPI(title="News pictogram aggregator")

templates = Environment(
    loader=FileSystemLoader(str(pathlib.Path(__file__).parent / "templates")),
    autoescape=select_autoescape(["html", "xml"]),
)


@app.get("/", response_class=HTMLResponse)
def index(
    request: Request,
    q: str = "",
    translate: Optional[str] = None,
    view_all: Optional[str] = None,
    action: Optional[str] = None,
    refreshed: Optional[str] = None,
) -> HTMLResponse:
    action = request.query_params.get("action") or action
    if action == "refresh":
        NEWS_CACHE.refresh()
        params = [
            (key, value)
            for key, value in request.query_params.multi_items()
            if key not in {"action", "refreshed"}
        ]
        params.append(("refreshed", "1"))
        query = urllib.parse.urlencode(params, doseq=True)
        target = request.url.path
        if query:
            target = f"{target}?{query}"
        return RedirectResponse(target, status_code=303)

    forced_refresh = (request.query_params.get("refreshed") or refreshed or "").lower() == "1"

    translate_values = request.query_params.getlist("translate")
    translate_enabled = True if not translate_values else translate_values[-1] != "off"

    view_all_values = request.query_params.getlist("view_all")
    view_all_enabled = any(val.lower() not in {"", "0", "off", "false"} for val in view_all_values)

    items = NEWS_CACHE.get_items()
    filtered = NEWS_CACHE.search(q or "", items)
    view_models = prepare_view_models(filtered, translate_enabled)

    all_news = None
    if view_all_enabled:
        all_news = [
            {
                "title": item.orig_title,
                "link": item.link,
                "source": item.source,
                "time": format_datetime(item.published),
                "relative_time": humanize_delta(item.published),
            }
            for item in items
        ]
    template = templates.get_template("index.html")
    updated_ts = NEWS_CACHE.timestamp or time.time()
    rendered = template.render(
        request=request,
        items=view_models,
        query=q,
        translate=translate_enabled,
        total=len(items),
        matches=len(filtered),
        updated_at=datetime.fromtimestamp(updated_ts, tz=timezone.utc).strftime("%H:%M:%S UTC"),
        forced_refresh=forced_refresh,
        view_all=view_all_enabled,
        all_news=all_news,
    )
    return HTMLResponse(rendered)


@app.get("/health", response_class=HTMLResponse)
def healthcheck() -> HTMLResponse:
    return HTMLResponse("ok")


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run("app:app", host="0.0.0.0", port=int(os.getenv("PORT", 8000)), reload=False)
