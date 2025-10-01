"""FastAPI implementation of the news pictogram aggregator for Vercel."""
from __future__ import annotations

import base64
import hashlib
import io
import os
import pathlib
import random
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from typing import Dict, Iterable, List, Optional

import feedparser
import requests
from bs4 import BeautifulSoup
from deep_translator import GoogleTranslator
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from jinja2 import Environment, FileSystemLoader, select_autoescape
from PIL import Image, ImageDraw, ImageFont
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ─── Configuration ─────────────────────────────────────────────────────────────
TARGET_LANG = os.environ.get("NEWS_TARGET_LANG", "ru")
CACHE_TTL = int(os.environ.get("NEWS_CACHE_TTL", 15 * 60))  # seconds
ITEMS_PER_SOURCE = int(os.environ.get("NEWS_ITEMS_PER_SOURCE", 8))
CACHE_DIR = pathlib.Path(os.environ.get("NEWS_CACHE_DIR", "/tmp/rss_cache"))
CACHE_DIR.mkdir(exist_ok=True)

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
}

ACCENT_COLORS = [
    "#d62828",
    "#003049",
    "#f77f00",
    "#2a9d8f",
    "#780116",
    "#0a2463",
]

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

# ─── Utility Helpers ───────────────────────────────────────────────────────────
@lru_cache(maxsize=512)
def translate_text(text: str, target_lang: str = TARGET_LANG) -> str:
    if not text:
        return ""
    try:
        return GoogleTranslator(source="auto", target=target_lang).translate(text[:4500])
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


class NewsCache:
    def __init__(self) -> None:
        self.timestamp = 0.0
        self.items: List[NewsItem] = []

    def refresh(self) -> None:
        aggregated: List[NewsItem] = []
        seen_links = set()
        for source, url in NEWS_SOURCES.items():
            feed_bytes = load_raw_rss(url)
            if not feed_bytes:
                continue
            parsed = feedparser.parse(feed_bytes)
            entries = parsed.entries[:ITEMS_PER_SOURCE]
            for entry in entries:
                link = getattr(entry, "link", "").split("?", 1)[0]
                if not link or link in seen_links:
                    continue
                seen_links.add(link)

                original_title = getattr(entry, "title", "")
                raw_summary = getattr(entry, "summary", "") or getattr(entry, "description", "")
                original_description = clean_html(raw_summary)

                published = datetime.now(timezone.utc)
                if getattr(entry, "published_parsed", None):
                    published = datetime.fromtimestamp(
                        time.mktime(entry.published_parsed), tz=timezone.utc
                    )

                aggregated.append(
                    NewsItem(
                        title=original_title,
                        description=original_description,
                        link=link,
                        source=source,
                        published=published,
                        image=first_image(entry),
                        orig_title=original_title,
                        orig_description=original_description,
                    )
                )
        aggregated.sort(key=lambda x: x.published, reverse=True)
        self.items = aggregated
        self.timestamp = time.time()

    def get_items(self) -> List[NewsItem]:
        if not self.items or (time.time() - self.timestamp) > CACHE_TTL:
            self.refresh()
        return self.items


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


def create_pictogram(title: str, summary: str, accent: str) -> str:
    width, height = 720, 360
    base = Image.new("RGB", (width, height), "#f4f1de")
    draw = ImageDraw.Draw(base)

    draw.rectangle([(0, 0), (width * 0.28, height)], fill=accent)
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


def filter_items(items: Iterable[NewsItem], query: str) -> List[NewsItem]:
    if not query:
        return list(items)
    q = query.lower().strip()
    result = []
    for item in items:
        haystacks = [item.title.lower(), item.description.lower(), item.source.lower()]
        if any(q in hay for hay in haystacks):
            result.append(item)
    return result


def prepare_view_models(items: Iterable[NewsItem], translate_enabled: bool) -> List[dict]:
    view_models = []
    for item in items:
        translated_title = translate_text(item.orig_title) if translate_enabled else item.orig_title
        translated_desc = translate_text(item.orig_description) if translate_enabled else item.orig_description
        accent = random.choice(ACCENT_COLORS)
        pictogram = create_pictogram(translated_title or item.orig_title, translated_desc or translated_title, accent)
        view_models.append(
            {
                "title_display": translated_title or item.orig_title,
                "summary_display": translated_desc or item.orig_description,
                "orig_title": item.orig_title,
                "orig_desc": item.orig_description,
                "link": item.link,
                "image": item.image,
                "source": item.source,
                "time": format_datetime(item.published),
                "relative_time": humanize_delta(item.published),
                "pictogram": pictogram,
                "accent": accent,
            }
        )
    return view_models


# ─── FastAPI App ───────────────────────────────────────────────────────────────
app = FastAPI(title="News pictogram aggregator")

templates = Environment(
    loader=FileSystemLoader(str(pathlib.Path(__file__).parent / "templates")),
    autoescape=select_autoescape(["html", "xml"]),
)


@app.get("/", response_class=HTMLResponse)
def index(request: Request, q: str = "", translate: Optional[str] = None) -> HTMLResponse:
    translate_values = request.query_params.getlist("translate")
    translate_enabled = True if not translate_values else translate_values[-1] != "off"
    items = NEWS_CACHE.get_items()
    filtered = filter_items(items, q)
    view_models = prepare_view_models(filtered, translate_enabled)
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
    )
    return HTMLResponse(rendered)


@app.get("/health", response_class=HTMLResponse)
def healthcheck() -> HTMLResponse:
    return HTMLResponse("ok")


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run("app:app", host="0.0.0.0", port=int(os.getenv("PORT", 8000)), reload=False)
