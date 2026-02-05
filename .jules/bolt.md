## 2024-05-23 - Parallelizing CPU/Network Bound Request Processing

**Learning:** When a synchronous HTTP request handler performs multiple independent I/O-bound (network requests) or heavy CPU-bound operations (image generation) for a list of items, processing them sequentially blocks the response significantly. Even with caching, cache misses cause long delays. Using `ThreadPoolExecutor` to process these items in parallel within the synchronous handler provides a massive speedup (5x in this case).

**Action:** Look for loops in request handlers that call external APIs or perform heavy computations. If the iterations are independent, use `ThreadPoolExecutor` (or `asyncio.gather` if the code is async-native) to parallelize them.
