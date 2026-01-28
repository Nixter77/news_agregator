## 2025-05-22 - Sequential I/O in Request Handler
**Learning:** `prepare_view_models` was performing sequential network requests (image fetching, translation) for every item in the list, leading to massive latency (5s+ for 10 items). FastAPI's async nature doesn't help if the code inside the route is synchronous and blocking.
**Action:** Always check loop bodies in request handlers for blocking I/O. Use `ThreadPoolExecutor` to parallelize these operations, especially when they are independent per item.
