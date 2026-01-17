## 2024-05-23 - ThreadPoolExecutor for I/O bound view generation
**Learning:** Sequential processing of view models with external dependencies (translation, image fetching) creates massive latency. Parallelizing with ThreadPoolExecutor yielded a 10x speedup (6s -> 0.6s) for 20 items.
**Action:** Always verify if list comprehensions or loops over items with network calls can be parallelized. Use `functools.partial` to pass constant arguments to the worker function.
