import hashlib
import re
import httpx
import time
from typing import List, Optional, Tuple
from bs4 import BeautifulSoup
from datetime import datetime, timezone

from .config import TOKEN_PATTERN, CYRILLIC_TO_LATIN, CACHE_DIR, CACHE_TTL, ACCENT_COLORS

def _build_async_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        headers={
            "user-agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/118.0.0.0 Safari/537.36"
            )
        },
        timeout=20.0,
        follow_redirects=True,
    )

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

async def load_raw_rss_async(client: httpx.AsyncClient, url: str) -> Optional[bytes]:
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
        response = await client.get(url)
        response.raise_for_status()
        payload = response.content
        cache_file.write_bytes(f"{time.time()}\n".encode() + payload)
        return payload
    except httpx.HTTPError:
        return None

def _select_accent(seed: str) -> str:
    digest = hashlib.sha1(seed.encode("utf-8", "ignore")).digest()
    return ACCENT_COLORS[digest[0] % len(ACCENT_COLORS)]

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
