## 2026-01-12 - Parallelization of view model preparation
**Learning:** In FastAPI synchronous path operations, CPU/IO-bound loop iterations (like generating images or fetching translations) block the thread. `ThreadPoolExecutor` within the path operation can significantly speed up these tasks (e.g., 17x speedup observed).
**Action:** Always check for `for` loops in hot paths that do I/O or heavy computation and consider parallelizing them.
