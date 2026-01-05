import time
import asyncio
import httpx
import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

import feedparser

from .config import ITEMS_PER_SOURCE, NEWS_SOURCES, TARGET_LANG, CACHE_TTL
from .utils import (
    load_raw_rss_async,
    _build_async_client,
    clean_html,
    first_image,
    _select_accent,
    tokenize,
    build_query_groups,
)
from .translation import translate_text

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
    id: str = field(init=False)
    search_tokens: set[str] = field(default_factory=set, init=False, repr=False)
    _translations: Dict[str, Tuple[str, str]] = field(default_factory=dict, init=False, repr=False)

    def __post_init__(self):
        # Generate a unique ID based on the link
        self.id = hashlib.md5(self.link.encode("utf-8")).hexdigest()

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


class NewsCache:
    def __init__(self) -> None:
        self.timestamp = 0.0
        self.items: List[NewsItem] = []
        self._item_map: Dict[str, NewsItem] = {}
        self._token_index: Dict[str, set[int]] = {}
        self._search_cache: Dict[Tuple[str, ...], List[int]] = {}

    def _rebuild_index(self) -> None:
        self._token_index = {}
        self._item_map = {}
        for idx, item in enumerate(self.items):
            self._item_map[item.id] = item
            if not item.search_tokens:
                item.update_search_tokens()
            for token in item.search_tokens:
                self._token_index.setdefault(token, set()).add(idx)
        self._search_cache.clear()

    async def refresh(self) -> None:
        async with _build_async_client() as client:
            tasks = [
                self._fetch_one_feed(client, source, url)
                for source, url in NEWS_SOURCES.items()
            ]
            results = await asyncio.gather(*tasks)

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

    async def _fetch_one_feed(self, client: httpx.AsyncClient, source: str, url: str) -> List[NewsItem]:
        feed_bytes = await load_raw_rss_async(client, url)
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

    async def get_items(self) -> List[NewsItem]:
        if not self.items or (time.time() - self.timestamp) > CACHE_TTL:
            await self.refresh()
        return self.items

    def get_item(self, item_id: str) -> Optional[NewsItem]:
        return self._item_map.get(item_id)

    def search(self, query: str, items: Optional[List[NewsItem]] = None) -> List[NewsItem]:
        if items is None:
            items = self.items

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
