from __future__ import annotations

from pathlib import Path
from typing import Any

from .profiler import profile
from .readers import load_dataset
from .redactor import RULES, redact_rows
from .samplers import annotate_sample_rows, deterministic_sample


DEFAULT_SAMPLE_SIZE = 10
MAX_SAMPLE_SIZE = 10


def explore_dataset(payload: dict[str, Any]) -> dict[str, Any]:
    path = Path(str(payload.get('filePath') or '')).resolve()
    if not path.is_file():
        raise FileNotFoundError(f'Dataset file not found: {path}')
    dataset_ref = str(payload.get('datasetRef') or '').strip()
    dataset_hash = str(payload.get('datasetHash') or '').strip()
    if not dataset_ref or not dataset_hash:
        raise ValueError('datasetRef and datasetHash are required')
    size = max(1, min(MAX_SAMPLE_SIZE, int(payload.get('sampleSize') or DEFAULT_SAMPLE_SIZE)))
    seed = str(payload.get('sampleSeed') or dataset_hash[:16])
    selected_columns = _selected_columns(payload.get('selectedColumns'))
    sheet_name = str(payload.get('sheetName') or '').strip() or None
    table = load_dataset(path, seed=seed, sheet_name=sheet_name)
    unknown_columns = [column for column in selected_columns if column not in table.columns]
    if unknown_columns:
        raise ValueError(f'Selected columns were not found: {unknown_columns}')
    sample_rows = deterministic_sample(table.rows, size, seed)
    analysis = profile(table.rows, table.columns)
    row_output_columns = [*selected_columns, '_theta_sample_id'] if selected_columns else []
    sample, sample_redactions, sample_output_truncated = redact_rows(
        annotate_sample_rows(sample_rows, kind='uniform', seed=seed),
        selected_columns=row_output_columns,
        byte_budget=20 * 1024,
    )
    column_profiles, profile_redactions, profile_output_truncated = _redact_column_profiles(
        analysis['profiles']
    )
    quality_warnings = list(analysis['qualityWarnings'])
    if table.rows_truncated:
        quality_warnings.append(
            f'列统计基于确定性蓄水池样本（最多 {len(table.rows)} 行），完整行数仍为 {table.row_count}。'
        )
    output_truncated = sample_output_truncated or profile_output_truncated
    if output_truncated:
        quality_warnings.append('展示样本或字段示例已按受治理输出预算截断。')
    return {
        'datasetRef': dataset_ref,
        'datasetHash': dataset_hash,
        'fileName': str(payload.get('fileName') or path.name),
        'format': table.suffix.lstrip('.'),
        'sizeBytes': int(payload.get('sizeBytes') or path.stat().st_size),
        'encoding': table.encoding,
        'delimiter': table.delimiter,
        'sheets': table.sheets,
        'selectedSheet': table.selected_sheet,
        'rowCount': table.row_count,
        'columns': table.columns,
        'columnProfiles': column_profiles,
        'sampleRows': sample,
        'sampleSeed': seed,
        'samplePolicy': {
            'method': 'deterministic_reservoir',
            'requestedRows': size,
            'returnedRows': len(sample),
            'profileRows': len(table.rows),
            'profileTruncated': table.rows_truncated,
        },
        'sampleTruncated': table.row_count > len(sample),
        'outputTruncated': output_truncated,
        'redactionSummary': {
            'applied': sample_redactions + profile_redactions > 0,
            'redactedValueCount': sample_redactions + profile_redactions,
            'rules': list(RULES) + ['sensitive_column'],
        },
        'candidateRoles': analysis['columnRoles'],
        'languageDistribution': analysis['languageDistribution'],
        'duplicateRatio': analysis['duplicateRatio'],
        'timeCoverage': analysis['timeCoverage'],
        'inferredDomain': analysis['inferredDomain'],
        'qualityWarnings': list(dict.fromkeys(quality_warnings)),
    }


def _selected_columns(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return list(dict.fromkeys(str(item).strip() for item in value if str(item).strip()))[:50]


def _redact_column_profiles(
    profiles: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], int, bool]:
    safe_profiles: list[dict[str, Any]] = []
    redaction_count = 0
    output_truncated = False
    for raw_profile in profiles:
        next_profile = dict(raw_profile)
        column_name = str(next_profile.get('name') or 'value')
        values = next_profile.get('sampleValues')
        if isinstance(values, list):
            rows = [{column_name: value} for value in values]
            safe_rows, count, truncated = redact_rows(
                rows,
                selected_columns=[column_name],
                byte_budget=4 * 1024,
            )
            next_profile['sampleValues'] = [
                row[column_name] for row in safe_rows if column_name in row
            ]
            redaction_count += count
            output_truncated = output_truncated or truncated
        safe_profiles.append(next_profile)
    return safe_profiles, redaction_count, output_truncated
