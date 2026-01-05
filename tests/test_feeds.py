import pytest
from src.feeds import NewsItem
from datetime import datetime, timezone

def test_news_item_creation():
    item = NewsItem(
        title="Test Title",
        description="Test Description",
        link="http://example.com",
        source="Test Source",
        published=datetime.now(timezone.utc),
        image=None,
        orig_title="Original Title",
        orig_description="Original Description",
        accent="#000000"
    )
    assert item.title == "Test Title"
    assert item.accent == "#000000"

def test_news_item_search_tokens():
    item = NewsItem(
        title="Test Title",
        description="Test Description",
        link="http://example.com",
        source="Test Source",
        published=datetime.now(timezone.utc),
        image=None,
        orig_title="Original Title",
        orig_description="Original Description",
        accent="#000000"
    )
    item.update_search_tokens()
    assert "test" in item.search_tokens
    assert "title" in item.search_tokens
    assert "source" in item.search_tokens
