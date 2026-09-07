"""Round-robin selection for video post-processing service endpoints."""

from __future__ import annotations

from itertools import count
from threading import Lock
from typing import Iterable, List, TypeVar

T = TypeVar("T")

_counter = count()
_counter_lock = Lock()


def round_robin_order(candidates: Iterable[T]) -> List[T]:
    """Return candidates rotated to the next balanced starting endpoint."""
    values = list(candidates)
    if len(values) < 2:
        return values
    with _counter_lock:
        start = next(_counter) % len(values)
    return values[start:] + values[:start]
