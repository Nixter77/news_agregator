import base64
import io
import httpx
from typing import List, Tuple, Optional, Union
from functools import lru_cache
from PIL import Image, ImageDraw, ImageFont

from .utils import _build_async_client

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

async def fetch_image_bytes(url: str) -> Optional[bytes]:
    if not url:
        return None
    try:
        async with _build_async_client() as client:
            resp = await client.get(url)
            resp.raise_for_status()
            return resp.content
    except Exception:
        return None

def generate_pictogram_image(title: str, summary: str, accent: str, image_bytes: Optional[bytes] = None) -> bytes:
    """Synchronous function to generate the PIL image bytes."""
    width, height = 720, 360
    base = Image.new("RGB", (width, height), "#f4f1de")
    draw = ImageDraw.Draw(base)

    left_w = int(width * 0.28)
    draw.rectangle([(0, 0), (left_w, height)], fill=accent)

    if image_bytes:
        try:
            img_orig = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            padding = 12
            target_w = left_w - padding * 2
            target_h = height - padding * 2

            ow, oh = img_orig.size
            ratio = min(target_w / ow, target_h / oh)
            new_size = (max(1, int(ow * ratio)), max(1, int(oh * ratio)))
            img_thumb = img_orig.resize(new_size, Image.LANCZOS)

            paste_x = padding + (target_w - new_size[0]) // 2
            paste_y = padding + (target_h - new_size[1]) // 2

            bg = Image.new("RGB", (target_w, target_h), accent)
            base.paste(bg, (padding, padding))
            base.paste(img_thumb, (paste_x, paste_y))
        except Exception:
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
    return buffer.getvalue()
