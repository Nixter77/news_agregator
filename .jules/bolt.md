## 2026-01-18 - Sequential Processing of News Items
**Learning:** The application processes news items (translation and pictogram generation) sequentially within the main request handler. This significantly impacts response time as the number of items grows or external services (translation API) are slow.
**Action:** Use `ThreadPoolExecutor` to parallelize `prepare_view_models`. Future improvements could involve background processing or async/await if the architecture permits (e.g. fully async FastAPI), but `ThreadPoolExecutor` is a low-risk retrofit for the current synchronous code.
