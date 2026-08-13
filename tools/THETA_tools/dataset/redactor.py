from __future__ import annotations

import json
import re
from typing import Any


MAX_CELL_CHARS = 500
MAX_ROW_CHARS = 5000
MAX_OUTPUT_BYTES = 50 * 1024
SENSITIVE_COLUMN = re.compile(
    r'(?:name|姓名|address|地址|account|账号|bank|银行卡|card|卡号|token|secret|password|passwd|authorization|auth[_-]?header|api[_-]?key)',
    re.IGNORECASE,
)
RULES = {
    'email': re.compile(r'\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b', re.IGNORECASE),
    'phone': re.compile(r'(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)'),
    'identity_number': re.compile(r'(?<!\d)\d{17}[\dXx](?!\d)'),
    'ip_address': re.compile(r'\b(?:\d{1,3}\.){3}\d{1,3}\b'),
    'bank_card': re.compile(r'(?<!\d)(?:\d[ -]?){15,19}(?!\d)'),
    'authorization': re.compile(r'(?i)\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}'),
    'api_token': re.compile(r'(?i)\b(?:sk|api|token|key)[-_][A-Za-z0-9_-]{12,}\b'),
    'address': re.compile(r'[\u4e00-\u9fff]{2,}(?:省|市|区|县|镇|乡|街道|路|街|巷)\S{0,30}(?:号|室|栋)?'),
}


def redact_rows(
    rows: list[dict[str, Any]],
    *,
    selected_columns: list[str] | None = None,
    byte_budget: int = MAX_OUTPUT_BYTES,
) -> tuple[list[dict[str, Any]], int, bool]:
    count = 0
    used_bytes = 2
    output_truncated = False
    selected = set(selected_columns or [])
    redacted: list[dict[str, Any]] = []
    for row in rows:
        next_row: dict[str, Any] = {}
        row_chars = 0
        for raw_key, value in row.items():
            key = str(raw_key)
            if selected and key not in selected:
                continue
            if SENSITIVE_COLUMN.search(key) and value not in (None, ''):
                next_value: Any = '[REDACTED_SENSITIVE_COLUMN]'
                count += 1
            elif isinstance(value, str):
                next_value = value
                for name, pattern in RULES.items():
                    next_value, replacements = pattern.subn(f'[REDACTED_{name.upper()}]', next_value)
                    count += replacements
                if len(next_value) > MAX_CELL_CHARS:
                    next_value = next_value[:MAX_CELL_CHARS] + '...[TRUNCATED]'
                    output_truncated = True
            else:
                next_value = value
            encoded = json.dumps(next_value, ensure_ascii=False)
            if row_chars + len(encoded) > MAX_ROW_CHARS:
                next_row['_theta_row_truncated'] = True
                output_truncated = True
                break
            next_row[key] = next_value
            row_chars += len(encoded)
        row_bytes = len(json.dumps(next_row, ensure_ascii=False).encode('utf-8')) + 1
        if used_bytes + row_bytes > max(1024, byte_budget):
            output_truncated = True
            break
        redacted.append(next_row)
        used_bytes += row_bytes
    if len(redacted) < len(rows):
        output_truncated = True
    return redacted, count, output_truncated
