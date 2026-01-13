## 2024-05-22 - Parallelization of I/O Bound Tasks in FastAPI

**Learning:** When processing a list of items where each item requires independent I/O operations (like external API calls or image fetching), processing them sequentially in a single thread is a major bottleneck. Python's `ThreadPoolExecutor` is highly effective here, even with the GIL, because the threads release the GIL during I/O wait times.

**Action:** In `app.py`, we replaced the sequential loop in `prepare_view_models` with a parallel map using `ThreadPoolExecutor`. This reduced the processing time for 20 items from ~6.0s to ~0.3s in a simulated environment. We also learned that creating a `ThreadPoolExecutor` inside the request handler adds overhead and risks resource exhaustion; a global executor instance is preferred for controlling concurrency limits across the application.
