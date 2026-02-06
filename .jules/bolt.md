## 2024-05-22 - [Parallel View Model Processing]
**Learning:** Sequential processing of view models (`prepare_view_models`) was a significant bottleneck due to IO-bound translation and CPU/IO-bound image generation.
**Action:** Used `ThreadPoolExecutor` to parallelize `prepare_view_models`.
**Impact:** Reduced processing time for 50 items from ~7.5s to ~0.76s (approx 10x speedup with 10 workers).
**Lesson:** Even with async frameworks (FastAPI), synchronous blocking calls inside path operations block the thread. Offloading to a thread pool is essential for blocking IO/CPU tasks.
