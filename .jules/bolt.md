## 2024-05-22 - Sequential Processing Bottleneck
**Learning:** FastAPI's default thread pool for synchronous path operations handles requests concurrently, but logic *within* a single request (like iterating over a list of items and making external calls) is executed sequentially. This creates a massive bottleneck when processing multiple items that require IO (network/image processing).
**Action:** Use `ThreadPoolExecutor` or `asyncio.gather` (if async) to parallelize item processing within a single request.
