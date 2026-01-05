from functools import lru_cache
from deep_translator import GoogleTranslator
from .config import TARGET_LANG

@lru_cache(maxsize=8)
def _get_translator(target_lang: str) -> GoogleTranslator:
    return GoogleTranslator(source="auto", target=target_lang)


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
