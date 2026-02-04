## 2026-02-04 - [Parallelizing View Model Generation]
**Learning:** Sequential processing of items involving network calls (translation, image fetch) inside a request handler causes massive latency. `ThreadPoolExecutor` is effective but must be instantiated globally to avoid overhead of thread creation per request.
**Action:** When parallelizing loops in FastAPI path operations, verify if operations are I/O bound. Use a global executor pattern. Ensure `partial` imports and other dependencies are at top level.
