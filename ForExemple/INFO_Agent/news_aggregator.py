#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rss_aggregator.py
~~~~~~~~~~~~~~~~~
Асинхронный мини-агрегатор международных новостей
+ сохранение JSON/SQLite
+ печать заголовков в консоль
"""

# ------------------------------------------------------------------#
# 1. импорт
# ------------------------------------------------------------------#
import asyncio, json, logging, sqlite3, sys, textwrap, time, ssl
from datetime import datetime
from pathlib import Path
from typing import List, Dict

import aiohttp, feedparser

# ------------------------------------------------------------------#
# 2. ленты
# ------------------------------------------------------------------#
FEEDS: List[str] = [
    "https://feeds.bbci.co.uk/news/world/rss.xml",
    "https://www.theguardian.com/world/rss",
    "https://feeds.reuters.com/reuters/worldNews",
    "https://www.aljazeera.com/xml/rss/all.xml",
    "https://rss.cnn.com/rss/edition_world.rss",
]

FALLBACK: Dict[str, str] = {
    "https://feeds.reuters.com/reuters/worldNews":
        "https://news.google.com/rss/search?q=source:Reuters+when:7d&hl=en&gl=US&ceid=US:en"
}

MAX_RETRIES        = 3
RETRY_SLEEP_SEC    = 5
GLOBAL_CONCURRENCY = 4
PRINT_LIMIT        = 5     # сколько заголовков выводить в консоль

# ------------------------------------------------------------------#
# 3. окружение
# ------------------------------------------------------------------#
OUT_DIR = Path("./output"); OUT_DIR.mkdir(exist_ok=True)
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s | %(levelname)5s | %(message)s",
                    datefmt="%H:%M:%S")

def init_db(db_path: Path = Path("rss.db")) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.execute("""CREATE TABLE IF NOT EXISTS items (
                        id TEXT PRIMARY KEY,
                        feed_url TEXT, title TEXT, link TEXT,
                        published TEXT, crawled_at TEXT
                    )""")
    conn.commit()
    return conn

# ------------------------------------------------------------------#
# 4. HTTP-помощники
# ------------------------------------------------------------------#
HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"),
    "Accept": "application/rss+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer": "https://www.google.com/",
}

SEM = asyncio.Semaphore(GLOBAL_CONCURRENCY)

async def fetch(session: aiohttp.ClientSession, url: str) -> str:
    real = FALLBACK.get(url, url)
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            async with SEM:
                async with session.get(real, headers=HEADERS, timeout=25) as r:
                    r.raise_for_status()
                    if "html" in r.headers.get("Content-Type", "").lower():
                        raise aiohttp.ClientError("HTML вместо RSS")
                    return await r.text()
        except Exception as e:
            if attempt == MAX_RETRIES:
                raise
            logging.warning("↻  %s — %s (повтор %d/%d)",
                            url, e, attempt, MAX_RETRIES)
            await asyncio.sleep(RETRY_SLEEP_SEC)

async def grab_one(url: str, session: aiohttp.ClientSession, db: sqlite3.Connection):
    try:
        raw = await fetch(session, url)
    except Exception as e:
        logging.error("❌  %s — %s", url, e)
        return

    feed = feedparser.parse(raw)
    if not feed.entries:
        logging.warning("⚠️  %s — 0 записей", url)
        return

    host = aiohttp.helpers.URL(url).host
    utc_now = datetime.utcnow().isoformat(timespec="seconds")
    new_cnt = 0
    rows: List[Dict] = []

    for ent in feed.entries:
        item_id = ent.get("id") or ent.get("guid") or ent.get("link")
        if not item_id:
            continue
        rows.append({"id": item_id,
                     "title": ent.get("title", ""),
                     "link": ent.get("link", ""),
                     "published": ent.get("published", "")})
        try:
            db.execute("INSERT OR IGNORE INTO items VALUES (?,?,?,?,?,?)",
                       (item_id, url, ent.get("title", ""), ent.get("link", ""),
                        ent.get("published", ""), utc_now))
            new_cnt += db.total_changes
        except sqlite3.Error as exc:
            logging.error("SQLite: %s", exc)
    db.commit()

    # JSON-дамп
    json_path = OUT_DIR / f"{host}.json"
    json_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

    # ---- вывод в терминал -------------------------------------------------
    print(f"\n📰  {host}  —  {len(rows)} статей (новых {new_cnt})")
    for art in rows[:PRINT_LIMIT]:
        print(f"   • {art['title']}")
    if len(rows) > PRINT_LIMIT:
        print(f"   … и ещё {len(rows) - PRINT_LIMIT} шт.")

async def crawl_all():
    ssl_ctx = ssl.create_default_context()
    db = init_db()
    async with aiohttp.ClientSession(connector=aiohttp.TCPConnector(ssl=ssl_ctx)) as sess:
        await asyncio.gather(*(grab_one(u, sess, db) for u in FEEDS))

# ------------------------------------------------------------------#
# 5. точка входа
# ------------------------------------------------------------------#
def main():
    print(textwrap.dedent("""
        ┌─────────────────────────────────────────┐
        │  RSS Aggregator — вывод заголовков      │
        └─────────────────────────────────────────┘
    """).strip())
    t0 = time.perf_counter()
    try:
        asyncio.run(crawl_all())
    except KeyboardInterrupt:
        sys.exit(130)
    print(f"\nГотово за {time.perf_counter() - t0:0.1f} с. "
          f"JSON-файлы лежат в «{OUT_DIR.resolve()}»")

if __name__ == "__main__":
    main()