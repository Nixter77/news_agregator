## 2026-01-24 - Parallelizing Blocking Calls in FastAPI
**Learning:** FastAPI runs path operations in a thread pool, but heavy sequential logic (like synchronous network I/O or CPU bound image processing) inside a single path operation blocks that thread. Using `ThreadPoolExecutor` to parallelize these tasks within a request can drastically improve response time.
**Action:** When handling collections of items that require independent blocking operations (like translation or image generation), use `concurrent.futures.ThreadPoolExecutor` to process them in parallel.
