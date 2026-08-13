from __future__ import annotations

import csv
import hashlib
import json
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Iterator


SUPPORTED_SUFFIXES = {'.csv', '.tsv', '.txt', '.json', '.jsonl', '.xlsx', '.xls', '.parquet'}
DEFAULT_PROFILE_LIMIT = 5000


@dataclass
class DatasetReader:
    path: Path
    suffix: str
    columns: list[str]
    encoding: str
    delimiter: str | None
    row_count: int
    rows: list[dict[str, Any]]
    head_rows: list[dict[str, Any]]
    rows_truncated: bool
    sheets: list[str]
    selected_sheet: str | None


def load_dataset(
    path: Path,
    *,
    seed: str = 'theta-dataset-profile',
    profile_limit: int = DEFAULT_PROFILE_LIMIT,
    sheet_name: str | None = None,
) -> DatasetReader:
    suffix = path.suffix.lower()
    if suffix not in SUPPORTED_SUFFIXES:
        raise ValueError(f"Unsupported dataset suffix '{suffix}'. Supported: {sorted(SUPPORTED_SUFFIXES)}")
    if suffix in {'.xlsx', '.xls', '.parquet'}:
        return _load_dataframe(path, suffix, seed, profile_limit, sheet_name)
    if suffix in {'.csv', '.tsv'}:
        encoding = _detect_encoding(path)
        delimiter = '\t' if suffix == '.tsv' else _sniff_delimiter(path, encoding)
        with path.open('r', encoding=encoding, newline='', errors='strict') as handle:
            reader = csv.DictReader(handle, delimiter=delimiter)
            columns = [str(value).strip() for value in (reader.fieldnames or [])]
            records = (
                {str(key).strip(): value for key, value in row.items() if key is not None}
                for row in reader
            )
            return _bounded_reader(path, suffix, columns, encoding, delimiter, records, seed, profile_limit)
    if suffix == '.jsonl':
        encoding = _detect_encoding(path)

        def records() -> Iterator[dict[str, Any]]:
            with path.open('r', encoding=encoding, errors='strict') as handle:
                for line in handle:
                    if not line.strip():
                        continue
                    value = json.loads(line)
                    if not isinstance(value, dict):
                        raise ValueError('JSONL records must be objects')
                    yield value

        return _bounded_reader(path, suffix, None, encoding, None, records(), seed, profile_limit)
    if suffix == '.json':
        encoding = _detect_encoding(path)
        with path.open('r', encoding=encoding, errors='strict') as handle:
            value = json.load(handle)
        records = value.get('data') or value.get('records') or value.get('items') if isinstance(value, dict) else value
        if not isinstance(records, list):
            raise ValueError('JSON dataset must be a list or contain data/records/items')
        object_rows = (item for item in records if isinstance(item, dict))
        return _bounded_reader(path, suffix, None, encoding, None, object_rows, seed, profile_limit)

    encoding = _detect_encoding(path)

    def text_records() -> Iterator[dict[str, Any]]:
        with path.open('r', encoding=encoding, errors='strict') as handle:
            for line in handle:
                value = line.strip()
                if value:
                    yield {'text': value}

    return _bounded_reader(path, suffix, ['text'], encoding, None, text_records(), seed, profile_limit)


def _bounded_reader(
    path: Path,
    suffix: str,
    known_columns: list[str] | None,
    encoding: str,
    delimiter: str | None,
    records: Iterable[dict[str, Any]],
    seed: str,
    profile_limit: int,
) -> DatasetReader:
    limit = max(10, profile_limit)
    rng = random.Random(_seed_value(seed))
    columns = list(known_columns or [])
    seen_columns = set(columns)
    rows: list[dict[str, Any]] = []
    head_rows: list[dict[str, Any]] = []
    row_count = 0
    for raw_row in records:
        row = {str(key): value for key, value in raw_row.items()}
        for key in row:
            if key not in seen_columns:
                columns.append(key)
                seen_columns.add(key)
        if len(head_rows) < 10:
            head_rows.append(row)
        row_count += 1
        if len(rows) < limit:
            rows.append(row)
            continue
        replacement = rng.randrange(row_count)
        if replacement < limit:
            rows[replacement] = row
    return DatasetReader(
        path,
        suffix,
        columns,
        encoding,
        delimiter,
        row_count,
        rows,
        head_rows,
        row_count > len(rows),
        [],
        None,
    )


def _load_dataframe(
    path: Path,
    suffix: str,
    seed: str,
    profile_limit: int,
    sheet_name: str | None,
) -> DatasetReader:
    try:
        import pandas as pd
    except ImportError as exc:
        raise RuntimeError(
            f"Reading {suffix} requires the optional pandas adapter and its format engine."
        ) from exc
    sheets: list[str] = []
    selected_sheet: str | None = None
    if suffix == '.parquet':
        frame = pd.read_parquet(path)
    else:
        workbook = pd.ExcelFile(path)
        sheets = [str(name) for name in workbook.sheet_names]
        if sheet_name:
            if sheet_name not in sheets:
                raise ValueError(f"Excel sheet '{sheet_name}' was not found. Available sheets: {sheets}")
            selected_sheet = sheet_name
            frame = pd.read_excel(workbook, sheet_name=sheet_name)
        else:
            frame = None
            for candidate in sheets:
                candidate_frame = pd.read_excel(workbook, sheet_name=candidate)
                if not candidate_frame.empty:
                    selected_sheet = candidate
                    frame = candidate_frame
                    break
            if frame is None:
                selected_sheet = sheets[0] if sheets else None
                frame = pd.DataFrame()
    frame = frame.where(frame.notna(), None)
    records = frame.to_dict(orient='records')
    reader = _bounded_reader(
        path,
        suffix,
        [str(column) for column in frame.columns],
        'binary',
        None,
        records,
        seed,
        profile_limit,
    )
    reader.sheets = sheets
    reader.selected_sheet = selected_sheet
    return reader


def _detect_encoding(path: Path) -> str:
    sample = path.read_bytes()[: 64 * 1024]
    for encoding in ('utf-8-sig', 'utf-8', 'gb18030', 'gbk', 'latin-1'):
        try:
            sample.decode(encoding)
            return encoding
        except UnicodeDecodeError:
            continue
    raise ValueError(f'Unable to decode dataset: {path.name}')


def _sniff_delimiter(path: Path, encoding: str) -> str:
    with path.open('r', encoding=encoding, errors='strict') as handle:
        sample = ''.join(handle.readline() for _ in range(20))
    try:
        return csv.Sniffer().sniff(sample, delimiters=',\t;|').delimiter
    except csv.Error:
        return ','


def _seed_value(seed: str) -> int:
    return int(hashlib.sha256(seed.encode('utf-8')).hexdigest()[:16], 16)
