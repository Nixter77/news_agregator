## 2024-05-22 - [Parallelization of News Item Processing]
**Learning:** Sequential processing of news items (translation and pictogram generation) in `prepare_view_models` caused significant latency (~5s for 50 items) due to blocking network calls, even with `lru_cache`. The bottleneck was the cumulative delay of synchronous I/O.
**Action:** Use `ThreadPoolExecutor` to map a processing function over the items. This reduced execution time by ~10x (to ~0.5s) with 10 workers. Ensure global configuration for worker count to avoid parsing env vars on every request.
