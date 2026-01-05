import pytest
from src.utils import tokenize, clean_html, transliterate_cyrillic

def test_tokenize():
    text = "Hello, World! 123"
    tokens = tokenize(text)
    assert tokens == ["hello", "world", "123"]
    assert tokenize("") == []

def test_clean_html():
    raw = "<p>Hello <b>World</b></p>"
    assert clean_html(raw) == "Hello World"
    assert clean_html("") == ""

def test_transliterate_cyrillic():
    assert transliterate_cyrillic("Привет") == "privet"
    assert transliterate_cyrillic("Hello") == "hello"
    assert transliterate_cyrillic("") == ""
