## 2026-01-22 - Sequential Processing in prepare_view_models
**Learning:** The `prepare_view_models` function was processing items sequentially, causing high latency due to blocking network calls (translation and image fetching) in the loop.
**Action:** Always check for opportunities to parallelize independent I/O-bound tasks using `ThreadPoolExecutor`, especially when processing lists of items.
