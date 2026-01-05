"""FastAPI implementation of the news pictogram aggregator for Vercel."""
from __future__ import annotations

import os
import pathlib
import time
import urllib.parse
from datetime import datetime, timezone
from typing import Iterable, List, Optional
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from jinja2 import Environment, FileSystemLoader, select_autoescape

from src.feeds import NEWS_CACHE, NewsItem
from src.utils import format_datetime, humanize_delta
from src.pictogram import generate_pictogram_image, fetch_image_bytes

# ─── Presentation Helpers ──────────────────────────────────────────────────────
def prepare_view_models(items: Iterable[NewsItem], translate_enabled: bool) -> List[dict]:
    view_models = []
    for item in items:
        if translate_enabled:
            translated_title, translated_desc = item.translated()
        else:
            translated_title, translated_desc = item.orig_title, item.orig_description

        title_display = translated_title or item.orig_title
        summary_display = translated_desc or item.orig_description or title_display

        # We now generate a URL instead of the base64 content
        pictogram_url = f"/pictogram/{item.id}?title={urllib.parse.quote(title_display)}&summary={urllib.parse.quote(summary_display)}"

        view_models.append(
            {
                "title_display": title_display,
                "summary_display": summary_display,
                "orig_title": item.orig_title,
                "orig_desc": item.orig_description,
                "link": item.link,
                "image": item.image,
                "source": item.source,
                "time": format_datetime(item.published),
                "relative_time": humanize_delta(item.published),
                "pictogram_url": pictogram_url,
                "accent": item.accent,
            }
        )
    return view_models


# ─── FastAPI App ───────────────────────────────────────────────────────────────
app = FastAPI(title="News pictogram aggregator")

# Mount static directory for CSS
static_dir = pathlib.Path(__file__).parent / "static"
static_dir.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

templates = Environment(
    loader=FileSystemLoader(str(pathlib.Path(__file__).parent / "templates")),
    autoescape=select_autoescape(["html", "xml"]),
)

# Thread pool for CPU-bound image generation
thread_pool = ThreadPoolExecutor(max_workers=os.cpu_count() or 1)


@app.get("/", response_class=HTMLResponse)
async def index(
    request: Request,
    q: str = "",
    translate: Optional[str] = None,
    view_all: Optional[str] = None,
    action: Optional[str] = None,
    refreshed: Optional[str] = None,
) -> HTMLResponse:
    action = request.query_params.get("action") or action
    if action == "refresh":
        await NEWS_CACHE.refresh()
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

    items = await NEWS_CACHE.get_items()
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


@app.get("/pictogram/{item_id}")
async def get_pictogram(item_id: str, title: str, summary: str):
    item = NEWS_CACHE.get_item(item_id)
    # If item is not found, we can't get the image URL to fetch the original image,
    # but we can still generate a text-only pictogram using the provided query params.
    # However, for accent color, we need the item or we derive it.

    accent = "#000000"
    image_bytes = None

    if item:
        accent = item.accent
        if item.image:
            image_bytes = await fetch_image_bytes(item.image)

    # Run the CPU-bound image generation in a separate thread
    loop = asyncio.get_running_loop()
    png_bytes = await loop.run_in_executor(
        thread_pool,
        generate_pictogram_image,
        title,
        summary,
        accent,
        image_bytes
    )

    return Response(content=png_bytes, media_type="image/png")


@app.get("/health", response_class=HTMLResponse)
async def healthcheck() -> HTMLResponse:
    return HTMLResponse("ok")


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run("app:app", host="0.0.0.0", port=int(os.getenv("PORT", 8000)), reload=False)
