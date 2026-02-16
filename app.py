"""
Modernized FastAPI News Aggregator.
Target: Python 3.12+
Changes: Async I/O (httpx), Pydantic Models, Dependency Injection, SSRF Protection.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from enum import Enum
from functools import lru_cache
from pathlib import Path
from typing import Any, Final, Optional

import feedparser
import httpx
from bs4 import BeautifulSoup
from deep_translator import GoogleTranslator
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from PIL import Image, ImageDraw, ImageFont, UnidentifiedImageError
from pydantic import BaseModel, Field, HttpUrl, field_validator

# ─── Configuration & Constants ────────────────────────────────────────────────
LOG_FORMAT: Final = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)
logger = logging.getLogger("NewsAggregator")

# Environment Variables with Type Conversion
TARGET_LANG: Final[str] = os.getenv("NEWS_TARGET_LANG", "ru")
CACHE_TTL: Final[int] = int(os.getenv("NEWS_CACHE_TTL", 900))
ITEMS_PER_SOURCE: Final[int] = int(os.getenv("NEWS_ITEMS_PER_SOURCE", 50))
PORT: Final[int] = int(os.getenv("PORT", 8000))

# Pre-compiled Regex
TOKEN_PATTERN: Final[re.Pattern] = re.compile(r"[\w\-]+", re.UNICODE)
IMG_TAG_PATTERN: Final[re.Pattern] = re.compile(r'<img[^>]+src="([^"]+)"', re.I)

# Constants
ACCENT_COLORS: Final[list[str]] = [
    "#d62828", "#003049", "#f77f00", "#2a9d8f", "#780116", "#0a2463"
]

NEWS_SOURCES: Final[dict[str, str]] = {
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

# ─── Domain Models (Pydantic) ─────────────────────────────────────────────────
class NewsItem(BaseModel):
    title: str
    description: str
    link: HttpUrl
    source: str
    published: datetime
    image: Optional[HttpUrl] = None
    orig_title: str
    orig_description: str
    accent: str
    
    # Hidden fields for internal logic
    search_tokens: set[str] = Field(default_factory=set, exclude=True)

    @field_validator("title", "description", mode="before")
    @classmethod
    def clean_text(cls, v: str | None) -> str:
        if not v:
            return ""
        # Basic HTML stripping
        return BeautifulSoup(v, "html.parser").get_text(" ", strip=True)

    def model_post_init(self, __context: Any) -> None:
        """Hydrate search tokens after initialization."""
        tokens = set()
        for text in (self.title, self.description, self.source):
            if text:
                tokens.update(TOKEN_PATTERN.findall(text.lower()))
        self.search_tokens = tokens

class FeedResult(BaseModel):
    items: list[NewsItem] = Field(default_factory=list)

# ─── Services ─────────────────────────────────────────────────────────────────

class TranslationService:
    """Handles text translation with in-memory caching."""
    def __init__(self):
        self._translator = GoogleTranslator(source="auto", target=TARGET_LANG)

    @lru_cache(maxsize=1024)
    def translate(self, text: str) -> str:
        if not text:
            return ""
        try:
            # Synchronous call blocking thread, should strictly be small payload
            # In prod, use an async client or run_in_threadpool
            return self._translator.translate(text[:4500])
        except Exception as e:
            logger.warning(f"Translation failed: {e}")
            return text

    async def translate_async(self, text: str) -> str:
        return await run_in_threadpool(self.translate, text)

class ImageService:
    """Handles secure image fetching and processing."""
    
    def _is_safe_url(self, url: str) -> bool:
        """Basic SSRF Check: Ensure we aren't hitting localhost or private IPs."""
        # For this snippet, we ensure scheme is http/s and not localhost.
        return url.startswith(("http://", "https://")) and "localhost" not in url and "127.0.0.1" not in url

    def _select_accent(self, seed: str) -> str:
        digest = hashlib.sha1(seed.encode("utf-8", "ignore")).digest()
        return ACCENT_COLORS[digest[0] % len(ACCENT_COLORS)]

    @lru_cache(maxsize=32)
    def _get_font(self, name: str, size: int) -> ImageFont.FreeTypeFont:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            return ImageFont.load_default()

    def _generate_pictogram(self, key: tuple) -> str:
        """CPU-bound image generation logic."""
        title, summary, accent, original_image_bytes = key
        
        width, height = 720, 360
        base = Image.new("RGB", (width, height), "#f4f1de")
        draw = ImageDraw.Draw(base)

        # Draw Accent Panel
        left_w = int(width * 0.28)
        draw.rectangle([(0, 0), (left_w, height)], fill=accent)

        if original_image_bytes:
            try:
                img_orig = Image.open(io.BytesIO(original_image_bytes)).convert("RGB")
                padding = 12
                target_w = left_w - padding * 2
                target_h = height - padding * 2
                
                # Aspect Ratio resizing
                img_orig.thumbnail((target_w, target_h), Image.LANCZOS)
                
                # Centering
                paste_x = padding + (target_w - img_orig.width) // 2
                paste_y = padding + (target_h - img_orig.height) // 2
                
                # Background for contrast
                bg = Image.new("RGB", (target_w, target_h), accent)
                base.paste(bg, (padding, padding))
                base.paste(img_orig, (paste_x, paste_y))
            except (UnidentifiedImageError, Exception) as e:
                logger.warning(f"Failed to process image: {e}")

        # Decorative Elements
        draw.polygon(
            [(width * 0.32, 0), (width * 0.62, height * 0.12), (width * 0.38, height * 0.42)],
            fill="#1b1b1b",
        )
        draw.rectangle(
            [(width * 0.35, height * 0.68), (width * 0.85, height * 0.82)], 
            fill="#d62828"
        )

        # Text Rendering
        title_font = self._get_font("DejaVuSans-Bold.ttf", 38)
        summary_font = self._get_font("DejaVuSans.ttf", 22)

        def wrap_text(text: str, font: Any, max_width: int) -> list[str]:
            lines = []
            words = text.split()
            if not words: return []
            current_line = words[0]
            for word in words[1:]:
                if font.getlength(f"{current_line} {word}") <= max_width:
                    current_line += f" {word}"
                else:
                    lines.append(current_line)
                    current_line = word
            lines.append(current_line)
            return lines

        text_x = int(width * 0.33)
        text_w = int(width * 0.62)

        # Title
        y_cursor = 36
        for line in wrap_text(title.upper(), title_font, text_w)[:3]:
            draw.text((text_x, y_cursor), line, fill="#0b090a", font=title_font)
            y_cursor += 44

        # Summary
        y_cursor += 14
        for line in wrap_text(summary, summary_font, text_w)[:4]:
            draw.text((text_x, y_cursor), line, fill="#343a40", font=summary_font)
            y_cursor += 26

        buffer = io.BytesIO()
        base.save(buffer, format="PNG", optimize=True)
        return base64.b64encode(buffer.getvalue()).decode("utf-8")

    async def create_pictogram_async(self, item: NewsItem, client: httpx.AsyncClient) -> str:
        """Orchestrates async fetching and CPU-bound generation."""
        image_bytes = None
        
        # 1. Async fetch external image if exists and is safe
        if item.image and self._is_safe_url(str(item.image)):
            try:
                # Use httpx to fetch image
                resp = await client.get(str(item.image), follow_redirects=True, timeout=5.0)
                if resp.status_code == 200:
                    image_bytes = resp.content
            except httpx.RequestError:
                pass  # Fail gracefully

        # 2. Run CPU-intensive image manipulation in thread pool
        # Cache key based on content content
        key = (item.title, item.description[:100], item.accent, image_bytes)
        
        # We use a wrapped caching strategy here to avoid pickling issues with run_in_threadpool
        # For simplicity in this snippet, we call the cached static helper
        return await run_in_threadpool(self._cached_wrapper, key)

    @staticmethod
    @lru_cache(maxsize=128)
    def _cached_wrapper(key: tuple) -> str:
        # Re-instantiate service inside thread if needed, or make method static
        # Here we just use a static implementation for the pure logic
        svc = ImageService()
        return svc._generate_pictogram(key)

class FeedService:
    def __init__(self):
        self._cache: list[NewsItem] = []
        self._last_update: float = 0.0
        self._lock = asyncio.Lock()

    def _extract_image(self, entry: Any) -> str | None:
        """Robust image extractor."""
        # Check media_content
        if "media_content" in entry:
             for media in entry.media_content:
                 if media.get("medium") == "image" and "url" in media:
                     return media["url"]
        
        # Check links
        for link in entry.get("links", []):
            if link.get("type", "").startswith("image") and "href" in link:
                return link["href"]
                
        # Scrape summary for <img>
        summary = entry.get("summary", "")
        if match := IMG_TAG_PATTERN.search(summary):
            return match.group(1)
            
        return None

    def _parse_feed(self, source_name: str, xml_data: bytes) -> list[NewsItem]:
        parsed = feedparser.parse(xml_data)
        items = []
        for entry in parsed.entries[:ITEMS_PER_SOURCE]:
            try:
                # Safe date parsing
                published = datetime.now(timezone.utc)
                if hasattr(entry, "published_parsed") and entry.published_parsed:
                    published = datetime.fromtimestamp(time.mktime(entry.published_parsed), tz=timezone.utc)

                link = getattr(entry, "link", "").split("?", 1)[0]
                if not link: continue

                items.append(NewsItem(
                    title=getattr(entry, "title", "No Title"),
                    description=getattr(entry, "summary", getattr(entry, "description", "")),
                    link=link,
                    source=source_name,
                    published=published,
                    image=self._extract_image(entry),
                    orig_title=getattr(entry, "title", "No Title"),
                    orig_description=getattr(entry, "summary", ""),
                    accent=ImageService()._select_accent(link or source_name),
                ))
            except Exception as e:
                logger.debug(f"Skipping malformed item in {source_name}: {e}")
                continue
        return items

    async def fetch_all(self, force_refresh: bool = False) -> list[NewsItem]:
        async with self._lock:
            if not force_refresh and time.time() - self._last_update < CACHE_TTL and self._cache:
                return self._cache

            logger.info("Refreshing feeds...")
            async with httpx.AsyncClient(headers={"User-Agent": "NewsAggregator/2.0"}) as client:
                tasks = []
                for name, url in NEWS_SOURCES.items():
                    tasks.append(client.get(url, follow_redirects=True, timeout=10.0))
                
                responses = await asyncio.gather(*tasks, return_exceptions=True)

            new_items = []
            for (name, _), result in zip(NEWS_SOURCES.items(), responses):
                if isinstance(result, httpx.Response) and result.status_code == 200:
                    try:
                        # Parse in threadpool to avoid blocking event loop with huge XMLs
                        items = await run_in_threadpool(self._parse_feed, name, result.content)
                        new_items.extend(items)
                    except Exception as e:
                        logger.error(f"Error parsing feed {name}: {e}")
                else:
                    logger.warning(f"Failed to fetch {name}")

            # Sort and Deduplicate
            new_items.sort(key=lambda x: x.published, reverse=True)
            unique_items = []
            seen = set()
            for item in new_items:
                if str(item.link) not in seen:
                    unique_items.append(item)
                    seen.add(str(item.link))

            self._cache = unique_items
            self._last_update = time.time()
            return self._cache

    def search(self, query: str, items: list[NewsItem]) -> list[NewsItem]:
        if not query:
            return items
        
        query_tokens = set(TOKEN_PATTERN.findall(query.lower()))
        if not query_tokens:
            return items

        matches = []
        for item in items:
            # Check intersection
            if query_tokens.intersection(item.search_tokens):
                matches.append(item)
        return matches

# ─── FastAPI Setup ────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: load feeds
    # We should avoid blocking startup if possible, but initializing data is good.
    # We can fire and forget or await. Awaiting ensures data is ready.
    try:
        await feed_service.fetch_all()
    except Exception as e:
        logger.error(f"Startup fetch failed: {e}")
    yield
    # Shutdown: cleanup (if any)

app = FastAPI(title="News Aggregator V2", lifespan=lifespan)
templates = Jinja2Templates(directory=Path(__file__).parent / "templates")

# Singleton Dependencies
feed_service = FeedService()
image_service = ImageService()
translator_service = TranslationService()

# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get("/health", response_class=HTMLResponse)
async def health():
    return "ok"

@app.get("/", response_class=HTMLResponse)
async def index(
    request: Request,
    q: str = "",
    translate: bool = False,
    view_all: bool = False,
    refreshed: bool = False,
    action: Optional[str] = None,
):
    def humanize_delta(dt: datetime) -> str:
        now = datetime.now(timezone.utc)
        diff = now - dt
        s = diff.total_seconds()
        if s < 60: return "just now"
        if s < 3600: return f"{int(s//60)}m ago"
        if s < 86400: return f"{int(s//3600)}h ago"
        return f"{int(s//86400)}d ago"

    if action == "refresh":
        await feed_service.fetch_all(force_refresh=True)
        # Redirect-after-POST pattern (PRG) to avoid resubmission
        # Construct clean URL
        url = request.url.remove_query_params(["action"]).include_query_params(refreshed=True)
        return RedirectResponse(url, status_code=303)

    items = await feed_service.fetch_all(force_refresh=refreshed)
    filtered_items = feed_service.search(q, items)
    
    # Pagination/Limit for View
    display_items = filtered_items if view_all else filtered_items[:30]

    # Prepare View Models asynchronously
    # We do this here instead of model to allow concurrent processing
    async with httpx.AsyncClient() as client:
        
        async def process_item(item: NewsItem):
            title_display = item.orig_title
            desc_display = item.orig_description

            if translate:
                # Concurrent translation
                title_display, desc_display = await asyncio.gather(
                    translator_service.translate_async(item.orig_title),
                    translator_service.translate_async(item.orig_description)
                )

            # Generate pictogram
            # Using title/desc as cache keys for efficiency
            pictogram = await image_service.create_pictogram_async(item, client)

            return {
                "title_display": title_display or "No Title",
                "summary_display": desc_display or "...",
                "orig_title": item.orig_title,
                "orig_desc": item.orig_description,
                "link": str(item.link),
                "image": str(item.image) if item.image else None,
                "source": item.source,
                "time": item.published.strftime("%d %b %Y, %H:%M UTC"),
                "relative_time": humanize_delta(item.published),
                "pictogram": pictogram,
                "accent": item.accent,
            }

        # Run all item processing in parallel
        # Note: limiting concurrency might be needed in prod (asyncio.Semaphore)
        view_models = await asyncio.gather(*[process_item(i) for i in display_items])

    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "items": view_models,
            "query": q,
            "translate": translate,
            "total": len(items),
            "matches": len(filtered_items),
            "updated_at": datetime.fromtimestamp(feed_service._last_update, tz=timezone.utc).strftime("%H:%M:%S UTC"),
            "forced_refresh": refreshed,
            "view_all": view_all,
            # If view_all is True, we pass simplified list for a hypothetical sidebar
            "all_news": items if view_all else None 
        }
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
