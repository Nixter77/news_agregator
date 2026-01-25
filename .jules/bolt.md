## 2026-01-25 - Sequential Processing in View Models
**Learning:** `prepare_view_models` was processing items sequentially, blocking on network calls (translation/images) despite `refresh` being parallel. Memory was misleading about existing parallelization.
**Action:** Always verify "known" performance features in code. Parallelize IO-heavy view model preparation using `ThreadPoolExecutor`.
