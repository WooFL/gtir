from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Callable, Iterable, TypeVar

T = TypeVar("T")
R = TypeVar("R")


def map_parallel(
    fn: Callable[[T], R],
    items: Iterable[T],
    max_workers: int = 8,
    timeout: float | None = None,
) -> list[R]:
    """Apply fn to each item in parallel using a thread pool; preserve input order."""
    items = list(items)
    results: list[R] = [None] * len(items)  # type: ignore[assignment]
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(fn, item): i for i, item in enumerate(items)}
        for fut in as_completed(futures, timeout=timeout):
            results[futures[fut]] = fut.result()
    return results


def run_with_retries(fn: Callable[[], R], max_retries: int = 3, backoff: float = 0.5) -> R:
    """Call fn up to max_retries times with exponential backoff on exception."""
    import time
    for attempt in range(max_retries):
        try:
            return fn()
        except Exception:
            if attempt == max_retries - 1:
                raise
            time.sleep(backoff * 2 ** attempt)
    raise RuntimeError("unreachable")
