## 2024-05-22 - [Parallelizing View Model Preparation]
**Learning:** Sequential processing of items involving I/O (translation, image fetching) in a FastAPI endpoint drastically increases latency.
**Action:** Use `ThreadPoolExecutor` to parallelize independent item processing tasks, especially when they involve external API calls or blocking I/O.
