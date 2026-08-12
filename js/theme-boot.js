/**
 * Apply stored theme before first paint.
 * Kept as an external file so CSP script-src 'self' allows it.
 */
(function bootTheme() {
  try {
    var stored = window.localStorage.getItem('news-aggregator.theme');
    if (stored === 'dark' || stored === 'light') {
      document.documentElement.setAttribute('data-theme', stored);
    }
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var isDark = stored === 'dark' || (stored !== 'light' && prefersDark);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', isDark ? '#1C1C1E' : '#007AFF');
    }
  } catch (err) {
    /* private mode / blocked storage */
  }
})();
