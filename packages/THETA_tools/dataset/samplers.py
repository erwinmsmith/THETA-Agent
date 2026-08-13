from __future__ import annotations

import hashlib
import json
import random
from typing import Any


def deterministic_sample(
    rows: list[dict[str, Any]], size: int, seed: str
) -> list[dict[str, Any]]:
    if size <= 0 or not rows:
        return []
    limit = min(size, len(rows))
    seed_value = int(hashlib.sha256(seed.encode('utf-8')).hexdigest()[:16], 16)
    indices = sorted(random.Random(seed_value).sample(range(len(rows)), limit))
    return [rows[index] for index in indices]


def exceptional_sample(
    rows: list[dict[str, Any]], size: int
) -> list[dict[str, Any]]:
    """Return deterministic high-signal rows without treating them as representative."""
    if size <= 0 or not rows:
        return []

    ranked = sorted(
        enumerate(rows),
        key=lambda item: (
            -_exception_score(item[1])[0],
            -_exception_score(item[1])[1],
            item[0],
        ),
    )
    return [row for _, row in ranked[: min(size, len(ranked))]]


def column_sample(
    rows: list[dict[str, Any]], columns: list[str], values_per_column: int = 3
) -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    for column in columns:
        seen: set[str] = set()
        value_count = 0
        for row in rows:
            value = row.get(column)
            if value is None or str(value).strip() == '':
                continue
            marker = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
            if marker in seen:
                continue
            seen.add(marker)
            samples.append({column: value})
            value_count += 1
            if value_count >= values_per_column:
                break
    return samples


def annotate_sample_rows(
    rows: list[dict[str, Any]], *, kind: str, seed: str
) -> list[dict[str, Any]]:
    annotated: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        digest = hashlib.sha256(
            f'{seed}:{kind}:{index}:{json.dumps(row, ensure_ascii=False, sort_keys=True, default=str)}'.encode('utf-8')
        ).hexdigest()[:12]
        annotated.append({'_theta_sample_id': f'{kind}-{digest}', **row})
    return annotated


def _exception_score(row: dict[str, Any]) -> tuple[int, int]:
    missing = sum(1 for value in row.values() if value is None or str(value).strip() == '')
    longest = max((len(str(value)) for value in row.values() if value is not None), default=0)
    return missing, longest
