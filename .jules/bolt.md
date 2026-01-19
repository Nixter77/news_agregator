## 2024-05-23 - Parallel Execution for View Model Preparation
**Learning:** Python's `ThreadPoolExecutor` is highly effective for I/O-bound tasks like translation (external API) and mixed tasks like image generation (CPU + I/O). Sequential processing in `prepare_view_models` was a major bottleneck (2s vs 0.2s for 10 items).
**Action:** Always look for independent per-item processing loops in list preparations and consider parallelizing them if they involve I/O or heavy computation. Use `functools.partial` to handle fixed arguments in `executor.map`.
