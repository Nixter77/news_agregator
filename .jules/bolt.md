## 2025-02-18 - Missing Parallelization
**Learning:** The codebase documentation/memory described `prepare_view_models` as using `ThreadPoolExecutor`, but the actual code was sequential. This discrepancy suggests that previous optimizations might have been lost or reverted.
**Action:** When optimizing, verify if the code matches the expected "optimized" state described in documentation. If not, restoring the documented optimization is a low-hanging fruit.
