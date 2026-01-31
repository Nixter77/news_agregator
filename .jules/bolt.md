## 2024-05-23 - Synchronous View Model Processing
**Learning:** The application was processing news items sequentially in `prepare_view_models`, executing blocking I/O (translation, image fetch) for each item. This caused response time to increase linearly.
**Action:** Parallelized item processing using a global `ThreadPoolExecutor` to handle I/O-bound tasks concurrently without incurring thread creation overhead per request.
