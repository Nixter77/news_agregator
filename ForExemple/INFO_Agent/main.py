import sys
from PyQt6.QtWidgets import QApplication, QWidget, QVBoxLayout, QPushButton, QListWidget, QLabel, QMessageBox
import feedparser
from translate import Translator
from datetime import datetime, timedelta

# Список RSS-лент мировых СМИ
RSS_FEEDS = [
    'http://feeds.bbci.co.uk/news/rss.xml',
    'http://rss.cnn.com/rss/edition.rss',
    'http://feeds.reuters.com/reuters/topNews',
    'https://www.aljazeera.com/xml/rss/all.xml',
]

class NewsAggregator(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle('Агрегатор новостей (мировые СМИ)')
        self.resize(800, 600)
        self.layout = QVBoxLayout()
        self.news_list = QListWidget()
        self.refresh_btn = QPushButton('Обновить новости')
        self.status_label = QLabel('')
        self.layout.addWidget(self.refresh_btn)
        self.layout.addWidget(self.news_list)
        self.layout.addWidget(self.status_label)
        self.setLayout(self.layout)
        self.refresh_btn.clicked.connect(self.load_news)
        self.translator = Translator(to_lang='ru')
        self.load_news()

    def load_news(self):
        self.news_list.clear()
        self.status_label.setText('Загрузка...')
        today = datetime.now().date()
        three_days_ago = today - timedelta(days=3)
        count = 0
        try:
            for url in RSS_FEEDS:
                feed = feedparser.parse(url)
                for entry in feed.entries:
                    pub_date = None
                    if hasattr(entry, 'published_parsed') and entry.published_parsed:
                        pub_date = datetime(*entry.published_parsed[:6]).date()
                    elif hasattr(entry, 'updated_parsed') and entry.updated_parsed:
                        pub_date = datetime(*entry.updated_parsed[:6]).date()
                    print(f'URL: {url} | Title: {entry.title} | pub_date: {pub_date}')  # Для отладки
                    if pub_date is None or pub_date >= three_days_ago:
                        title = entry.title
                        summary = entry.summary if hasattr(entry, 'summary') else ''
                        try:
                            title_ru = self.translator.translate(title)
                            summary_ru = self.translator.translate(summary)
                        except Exception:
                            title_ru = title
                            summary_ru = summary
                        self.news_list.addItem(f'{title_ru}\n{summary_ru}\n')
                        count += 1
            self.status_label.setText(f'Показано новостей: {count}')
        except Exception as e:
            QMessageBox.critical(self, 'Ошибка', str(e))
            self.status_label.setText('Ошибка загрузки новостей')

def main():
    app = QApplication(sys.argv)
    window = NewsAggregator()
    window.show()
    sys.exit(app.exec())

if __name__ == '__main__':
    main()
