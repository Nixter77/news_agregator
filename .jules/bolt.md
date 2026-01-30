## 2026-01-30 - Parallelizing View Model Processing
**Learning:** `prepare_view_models` was performing sequential I/O (translation and image fetching) for each news item, leading to high latency proportional to the number of items. This blocked the request handler significantly.
**Action:** Use `ThreadPoolExecutor` to parallelize independent item processing in blocking paths, while ensuring thread safety of shared resources (like LRU caches and dicts).
