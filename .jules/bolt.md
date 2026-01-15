## 2024-05-23 - Parallelizing View Model Preparation
**Learning:** The `prepare_view_models` function was a major bottleneck because it sequentially executed I/O-bound tasks (translation and image fetching) for each news item. Refactoring this to use a `ThreadPoolExecutor` resulted in a ~9x performance improvement (2.0s -> 0.22s for 20 items).
**Action:** When processing lists of items that require independent I/O operations (like external API calls or fetching resources), always prefer parallel execution using `ThreadPoolExecutor` over sequential loops.
