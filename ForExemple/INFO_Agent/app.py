#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Streamlit RSS Aggregator
Запуск:  streamlit run app.py
"""

import asyncio, logging, re
from typing import Dict, List

import aiohttp
import feedparser
import streamlit as st

# ---------------------------------------------------------------------------------
# 1) Константы
# ---------------------------------------------------------------------------------
FEEDS = {
    "BBC":          "https://feeds.bbci.co.uk/news/world/rss.xml",
    "Guardian":     "https://www.theguardian.com/world/rss",
    "Reuters":      "https://feeds.reuters.com/reuters/worldNews",
    "Al-Jazeera":   "https://www.aljazeera.com/xml/rss/all.xml",
    "CNN":          "https://rss.cnn.com/rss/edition_world.rss",
}

FALLBACK: Dict[str, str] = {
    FEEDS["Reuters"]:
        "https://news.google.com/rss/search?q=source:Reuters+when:7d&hl=en&gl=US&ceid=US:en"
}

HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"),
    "Accept": "application/rss+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer": "https://www.google.com/",
}

MAX_RETRIES, RETRY_SLEEP = 3, 4
CONCURRENCY              = 5

logging.getLogger("asyncio").setLevel(logging.CRITICAL)  # тишина от aiohttp

# ---------------------------------------------------------------------------------
# 2) Асинхронная загрузка ленты
# ---------------------------------------------------------------------------------
SEM = asyncio.Semaphore(CONCURRENCY)
RX_HTML = re.compile(r"html", re.I)

async def _fetch(session: aiohttp.ClientSession, url: str) -> str:
    real = FALLBACK.get(url, url)
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            async with SEM:
                async with session.get(real, headers=HEADERS, timeout=25) as r:
                    r.raise_for_status()
                    if RX_HTML.search(r.headers.get("Content-Type", "")):
                        raise aiohttp.ClientError("HTML вместо RSS")
                    return await r.text()
        except Exception as e:
            if attempt == MAX_RETRIES:
                raise
            await asyncio.sleep(RETRY_SLEEP)

async def _grab_one(session: aiohttp.ClientSession, name: str, url: str) -> List[Dict]:
    try:
        raw = await _fetch(session, url)
    except Exception as e:
        return [{"title": f"🚫 Ошибка: {e}", "link": "", "published": ""}]

    feed = feedparser.parse(raw)
    return [
        {
            "title":      e.get("title", "—"),
            "link":       e.get("link", ""),
            "published":  e.get("published", ""),
        }
        for e in feed.entries
    ]

async def _collect(feeds_subset: Dict[str, str]) -> Dict[str, List[Dict]]:
    async with aiohttp.ClientSession() as sess:
        tasks = [_grab_one(sess, name, url) for name, url in feeds_subset.items()]
        results = await asyncio.gather(*tasks)
    return dict(zip(feeds_subset.keys(), results))

# ---------------------------------------------------------------------------------
# 3) Streamlit-обёртка
# ---------------------------------------------------------------------------------
@st.cache_data(ttl=600, show_spinner=False)   # 10 минут кэш
def load_feeds(feeds_subset: Dict[str, str]) -> Dict[str, List[Dict]]:
    return asyncio.run(_collect(feeds_subset))

# ---------------------------------------------------------------------------------
# 4) UI
# ---------------------------------------------------------------------------------
st.set_page_config(page_title="🌍 RSS Aggregator", layout="wide")
st.title("🌍 RSS-агрегатор международных новостей")

st.sidebar.header("⚙️  Параметры")
selected = st.sidebar.multiselect(
    "Какие источники тянуть?",
    list(FEEDS.keys()),
    default=list(FEEDS.keys())[:3],
)
n_show = st.sidebar.slider("Сколько статей показывать на источник?",
                           3, 50, 10, step=1)
refresh = st.sidebar.button("🔄 Обновить (обойти кэш)")

if not selected:
    st.info("Выберите хотя бы одну ленту слева.")
    st.stop()

subset = {name: FEEDS[name] for name in selected}

# ––––– загрузка –––––
with st.spinner("Загружаем новости..."):
    if refresh:
        st.cache_data.clear()
    data = load_feeds(subset)

# ––––– вывод –––––
for name, items in data.items():
    st.subheader(f"🗞️ {name}  —  {len(items)} статей")
    if items and items[0].get("link") == "":
        st.error(items[0]["title"])           # сообщение об ошибке
        continue

    for art in items[:n_show]:
        published = f" ({art['published']})" if art["published"] else ""
        st.markdown(f"- [{art['title']}]({art['link']}){published}")

    if len(items) > n_show:
        with st.expander("Показать больше"):
            for art in items[n_show:]:
                published = f" ({art['published']})" if art["published"] else ""
                st.markdown(f"- [{art['title']}]({art['link']}){published}")