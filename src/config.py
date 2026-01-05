import os
import pathlib
import re

TARGET_LANG = os.environ.get("NEWS_TARGET_LANG", "ru")
CACHE_TTL = int(os.environ.get("NEWS_CACHE_TTL", 15 * 60))  # seconds
ITEMS_PER_SOURCE = int(os.environ.get("NEWS_ITEMS_PER_SOURCE", 50))
CACHE_DIR = pathlib.Path(os.environ.get("NEWS_CACHE_DIR", "/tmp/rss_cache"))
CACHE_DIR.mkdir(exist_ok=True)

NEWS_SOURCES = {
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
