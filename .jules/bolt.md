## 2026-01-20 - Sequential Item Processing Bottleneck
**Learning:** The `prepare_view_models` function was processing news items sequentially. Since each item involves network I/O (translation, image fetching) and CPU work (image generation), this created a significant bottleneck (N * latency).
**Action:** Use `ThreadPoolExecutor` to process independent items in parallel, drastically reducing response time for the main feed.
