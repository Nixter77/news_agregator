## 2024-05-22 - Codebase Duality and Python Performance
**Learning:** The codebase contains two distinct applications: a Node.js/Express app (`server.js`) configured for Vercel deployment, and a Python/FastAPI app (`app.py`) which implements the unique "pictogram" feature. Optimizations should target `app.py` for the core feature, despite `vercel.json` pointing to Node.
**Action:** Always verify which application logic corresponds to the user's feature description (`app.py` for pictograms) vs deployment config.

## 2024-05-22 - Sequential I/O Bottleneck
**Learning:** `prepare_view_models` in `app.py` processes news items sequentially. Each item requires translation (network) and pictogram generation (image fetch + processing), causing massive latency (O(N) * latency).
**Action:** Parallelize independent item processing using `ThreadPoolExecutor` to unblock the main thread and reduce total time to roughly `max(item_latency)`.
