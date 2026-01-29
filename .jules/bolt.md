## 2026-01-29 - Parallelizing Sequential I/O in FastAPI
**Learning:** FastAPI handles path operations in a thread pool, but sequential network I/O within a single request (like translating 50 items) blocks that thread and results in high latency. Parallelizing these operations with `ThreadPoolExecutor` inside the request handler yielded a 10x speedup.
**Action:** Identify loops performing network calls or heavy CPU tasks in request handlers and parallelize them.
