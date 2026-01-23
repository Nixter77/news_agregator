
import pytest
from unittest.mock import MagicMock, patch
from datetime import datetime, timezone
import app
from app import prepare_view_models, NewsItem

@pytest.fixture
def mock_news_item():
    return NewsItem(
        title="Test Title",
        description="Test Description",
        link="http://example.com/test",
        source="Test Source",
        published=datetime.now(timezone.utc),
        image=None,
        orig_title="Original Title",
        orig_description="Original Description",
        accent="#000000"
    )

def test_prepare_view_models_parallel(mock_news_item):
    items = [mock_news_item] * 5

    # Mock methods to avoid network/image processing
    with patch.object(NewsItem, 'translated', return_value=("Trans Title", "Trans Desc")) as mock_trans:
        with patch.object(NewsItem, 'pictogram', return_value="base64img") as mock_pic:

            results = prepare_view_models(items, translate_enabled=True)

            assert len(results) == 5
            assert results[0]["title_display"] == "Trans Title"
            assert results[0]["summary_display"] == "Trans Desc"
            assert results[0]["pictogram"] == "base64img"

            # Verify methods were called
            assert mock_trans.call_count == 5
            assert mock_pic.call_count == 5

def test_prepare_view_models_no_translate(mock_news_item):
    items = [mock_news_item]

    with patch.object(NewsItem, 'translated') as mock_trans:
        with patch.object(NewsItem, 'pictogram', return_value="base64img") as mock_pic:

            results = prepare_view_models(items, translate_enabled=False)

            assert len(results) == 1
            assert results[0]["title_display"] == "Original Title"
            assert results[0]["summary_display"] == "Original Description"

            # Translated should not be called
            mock_trans.assert_not_called()
            mock_pic.assert_called_once()
