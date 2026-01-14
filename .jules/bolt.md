## 2026-01-14 - Sequential IO Bottleneck in View Model Preparation
**Learning:** `prepare_view_models` executes IO-bound tasks (translation, image fetching) sequentially for each item. This limits throughput significantly (latency grows linearly with item count).
**Action:** Use `ThreadPoolExecutor` to parallelize these tasks. Even with Python's GIL, threads are effective for IO-bound operations. Ensure `NewsItem` methods are thread-safe (or stateless/idempotent).
