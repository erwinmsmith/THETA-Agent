from __future__ import annotations

import csv
import hashlib
import importlib.util
import json
import os
import platform
import re
import shutil
import sqlite3
import subprocess
import sys
from collections import Counter
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .dataset import explore_dataset


BRIDGE_PROTOCOL = "theta-agent-bridge/v1"
PROJECT_ROOT = Path(__file__).resolve().parents[2]
THETA_ROOT = Path(
    os.environ.get("THETA_UPSTREAM_ROOT")
    or PROJECT_ROOT / "third_party" / "THETA"
).resolve()
MODEL_CONFIG_PATH = THETA_ROOT / "src" / "models" / "models_config" / "models.yaml"
RUN_PIPELINE_PATH = THETA_ROOT / "src" / "models" / "run_pipeline.py"
STATE_DIR = Path(
    os.environ.get("THETA_AGENT_STATE_DIR") or PROJECT_ROOT / ".theta_agent"
).expanduser().resolve()
STATE_DB_PATH = STATE_DIR / "agent.sqlite"
RUNS_DIR = STATE_DIR / "runs"
PYTHON_BIN = os.environ.get("THETA_AGENT_PYTHON") or sys.executable
TRAINING_RUNTIME_SCHEMA_VERSION = "1.0.0"

TEXT_COLUMN_NAMES = {
    "text",
    "content",
    "cleaned_content",
    "comment",
    "comments",
    "message",
    "body",
    "review",
    "title",
    "abstract",
    "description",
}

TIME_COLUMN_HINTS = ("time", "date", "created", "updated", "timestamp", "year", "month", "day")
ID_COLUMN_HINTS = ("id", "uuid", "guid", "key")
SUPPORTED_DATASET_SUFFIXES = {".csv", ".tsv", ".txt", ".json", ".jsonl"}
RESULT_TEXT_SUFFIXES = {".csv", ".tsv", ".json", ".jsonl", ".txt", ".md", ".log"}
RESULT_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
RESULT_TABLE_SUFFIXES = {".csv", ".tsv"}
RESULT_ALLOWED_SUFFIXES = (
    RESULT_TEXT_SUFFIXES
    | RESULT_IMAGE_SUFFIXES
    | {".html", ".htm", ".npy", ".npz", ".pt", ".pkl", ".parquet"}
)
RAG_TEXT_SUFFIXES = {
    ".csv",
    ".html",
    ".htm",
    ".json",
    ".jsonl",
    ".js",
    ".jsx",
    ".md",
    ".py",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
}
RAG_EXCLUDED_DIRS = {
    ".git",
    ".next",
    ".theta_agent",
    "__pycache__",
    "dist",
    "node_modules",
    "worker_runs",
}
RAG_MAX_FILE_BYTES = 2 * 1024 * 1024
RAG_CHUNK_CHARS = 1400
RAG_CHUNK_OVERLAP = 180


@dataclass
class TableData:
    file_path: Path
    suffix: str
    encoding: str
    delimiter: str | None
    columns: list[str]
    rows: list[dict[str, Any]]
    total_rows: int


def handle_request(request: dict[str, Any]) -> dict[str, Any]:
    command = request.get("command")
    payload = request.get("input") or {}

    handlers = {
        "dataset.inspect": dataset_inspect,
        "dataset.explore": explore_dataset,
        "dataset.detect_columns": dataset_detect_columns,
        "dataset.clean_preview": dataset_clean_preview,
        "model.catalog": model_catalog,
        "model.recommend": model_recommend,
        "plan.validate": plan_validate,
        "plan.create": plan_create,
        "plan.approve": plan_approve,
        "training.dry_run": training_dry_run,
        "training.start": training_start,
        "training.status": training_status,
        "training.cancel": training_cancel,
        "results.list": results_list,
        "results.summarize": results_summarize,
        "rag.index": rag_index,
        "rag.search": rag_search,
        "events.export": events_export,
        "events.replay": events_replay,
    }
    handler = handlers.get(command)
    if handler is None:
        return error_response(command, "UnknownCommand", f"Unsupported bridge command: {command}")

    try:
        data = handler(payload)
        return {
            "status": "ok",
            "protocol": BRIDGE_PROTOCOL,
            "command": command,
            "data": data,
        }
    except Exception as exc:
        return error_response(command, exc.__class__.__name__, str(exc))


def error_response(command: Any, error_type: str, message: str) -> dict[str, Any]:
    return {
        "status": "error",
        "protocol": BRIDGE_PROTOCOL,
        "command": command,
        "error": {
            "type": error_type,
            "message": message,
        },
    }


def resolve_dataset_path(payload: dict[str, Any]) -> Path:
    raw_path = payload.get("filePath")
    if not raw_path:
        raise ValueError("filePath is required for local dataset bridge calls")

    candidate = Path(str(raw_path))
    if not candidate.is_absolute():
        candidate = (PROJECT_ROOT / candidate).resolve()
    else:
        candidate = candidate.resolve()

    if not candidate.exists() or not candidate.is_file():
        raise FileNotFoundError(f"Dataset file not found: {candidate}")

    return candidate


def read_text_with_encoding(path: Path) -> tuple[str, str]:
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "gbk", "latin-1"):
        try:
            return path.read_text(encoding=encoding), encoding
        except UnicodeDecodeError:
            continue
    raise UnicodeDecodeError("unknown", b"", 0, 1, f"Could not decode {path}")


def sniff_delimiter(text: str, suffix: str) -> str:
    if suffix == ".tsv":
        return "\t"
    sample = "\n".join(text.splitlines()[:20])
    try:
        return csv.Sniffer().sniff(sample, delimiters=",\t;|").delimiter
    except csv.Error:
        return ","


def load_table(payload: dict[str, Any]) -> TableData:
    path = resolve_dataset_path(payload)
    suffix = path.suffix.lower()
    sample_size = int(payload.get("sampleSize") or 50)
    if sample_size < 1:
        sample_size = 50

    if suffix not in SUPPORTED_DATASET_SUFFIXES:
        raise ValueError(
            f"Unsupported dataset suffix '{suffix}'. Supported: {sorted(SUPPORTED_DATASET_SUFFIXES)}"
        )

    text, encoding = read_text_with_encoding(path)
    if suffix in {".csv", ".tsv"}:
        delimiter = sniff_delimiter(text, suffix)
        reader = csv.DictReader(text.splitlines(), delimiter=delimiter)
        columns = [column.strip() for column in (reader.fieldnames or [])]
        rows: list[dict[str, Any]] = []
        total = 0
        for raw_row in reader:
            total += 1
            if len(rows) < sample_size:
                rows.append({str(k).strip(): v for k, v in raw_row.items() if k is not None})
        return TableData(path, suffix, encoding, delimiter, columns, rows, total)

    if suffix == ".jsonl":
        rows = []
        total = 0
        columns: set[str] = set()
        for line in text.splitlines():
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError("JSONL records must be JSON objects")
            total += 1
            columns.update(value.keys())
            if len(rows) < sample_size:
                rows.append(value)
        return TableData(path, suffix, encoding, None, sorted(columns), rows, total)

    if suffix == ".json":
        value = json.loads(text)
        if isinstance(value, dict):
            records = value.get("data") or value.get("records") or value.get("items")
        else:
            records = value
        if not isinstance(records, list):
            raise ValueError("JSON dataset must be a list or contain data/records/items list")
        rows = [item for item in records if isinstance(item, dict)]
        columns = sorted({key for row in rows for key in row.keys()})
        return TableData(path, suffix, encoding, None, columns, rows[:sample_size], len(rows))

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    rows = [{"text": line} for line in lines[:sample_size]]
    return TableData(path, suffix, encoding, None, ["text"], rows, len(lines))


def dataset_inspect(payload: dict[str, Any]) -> dict[str, Any]:
    table = load_table(payload)
    profile = column_profiles(table.rows, table.columns, table.total_rows)
    return {
        "filePath": str(table.file_path),
        "fileName": table.file_path.name,
        "suffix": table.suffix,
        "supported": table.suffix in SUPPORTED_DATASET_SUFFIXES,
        "encoding": table.encoding,
        "delimiter": table.delimiter,
        "rowCount": table.total_rows,
        "sampleRowCount": len(table.rows),
        "columns": table.columns,
        "columnProfiles": profile,
        # The tool output is not included in audit traces. Return the complete
        # bounded analysis sample so downstream statistics are not calculated
        # from only the five display rows.
        "sampleRows": table.rows,
        "textColumnCandidates": detect_columns_from_table(table)["textColumns"],
    }


def dataset_detect_columns(payload: dict[str, Any]) -> dict[str, Any]:
    table = load_table(payload)
    return detect_columns_from_table(table)


def dataset_clean_preview(payload: dict[str, Any]) -> dict[str, Any]:
    dataset_payload = payload.get("dataset")
    if not isinstance(dataset_payload, dict):
        raise ValueError("dataset must be an object")

    text_column = str(payload.get("textColumn") or "").strip()
    if not text_column:
        raise ValueError("textColumn is required")

    options = payload.get("options")
    if not isinstance(options, dict):
        options = {}

    table = load_table(dataset_payload)
    if text_column not in table.columns:
        raise ValueError(f"textColumn '{text_column}' not found in dataset columns: {table.columns}")

    min_words = int(options.get("minWords") or 1)
    if min_words < 1:
        min_words = 1

    preview_rows = []
    dropped_by_min_words = 0
    changed_count = 0
    token_counts_before: list[int] = []
    token_counts_after: list[int] = []

    for index, row in enumerate(table.rows):
        original = str(row.get(text_column) or "")
        cleaned = clean_text(original, options)
        before_words = tokenize_for_count(original)
        after_words = tokenize_for_count(cleaned)
        keep = len(after_words) >= min_words

        if not keep:
            dropped_by_min_words += 1
        if original != cleaned:
            changed_count += 1

        token_counts_before.append(len(before_words))
        token_counts_after.append(len(after_words))
        preview_rows.append(
            {
                "rowIndex": index,
                "before": original,
                "after": cleaned,
                "beforeWordCount": len(before_words),
                "afterWordCount": len(after_words),
                "keep": keep,
            }
        )

    return {
        "filePath": str(table.file_path),
        "textColumn": text_column,
        "rowCount": table.total_rows,
        "sampleRowCount": len(table.rows),
        "options": {
            "removeUrls": bool(options.get("removeUrls", True)),
            "removeHtml": bool(options.get("removeHtml", True)),
            "removeStopwords": bool(options.get("removeStopwords", False)),
            "normalizeWhitespace": bool(options.get("normalizeWhitespace", True)),
            "minWords": min_words,
        },
        "summary": {
            "changedSampleRows": changed_count,
            "droppedSampleRowsByMinWords": dropped_by_min_words,
            "avgWordsBefore": average(token_counts_before),
            "avgWordsAfter": average(token_counts_after),
        },
        "previewRows": preview_rows[:10],
        "warnings": build_clean_preview_warnings(table.total_rows, dropped_by_min_words, len(table.rows)),
    }


def clean_text(value: str, options: dict[str, Any]) -> str:
    text = value
    if bool(options.get("removeUrls", True)):
        text = re.sub(r"https?://\S+|www\.\S+", " ", text)
    if bool(options.get("removeHtml", True)):
        text = re.sub(r"<[^>]+>", " ", text)
    if bool(options.get("removeSpecialChars", options.get("removePunctuation", True))):
        text = re.sub(r"[^\w\s\u4e00-\u9fff]", " ", text, flags=re.UNICODE)
    if bool(options.get("removeStopwords", False)):
        words = [word for word in tokenize_for_count(text) if word.lower() not in basic_stopwords()]
        text = " ".join(words)
    if bool(options.get("normalizeWhitespace", True)):
        text = re.sub(r"\s+", " ", text).strip()
    return text


def tokenize_for_count(value: str) -> list[str]:
    return re.findall(r"[\w\u4e00-\u9fff]+", value, flags=re.UNICODE)


def basic_stopwords() -> set[str]:
    return {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "by",
        "for",
        "from",
        "in",
        "is",
        "it",
        "of",
        "on",
        "or",
        "that",
        "the",
        "to",
        "with",
        "了",
        "和",
        "是",
        "在",
        "的",
        "我",
        "有",
        "就",
    }


def average(values: list[int]) -> float:
    if not values:
        return 0.0
    return round(sum(values) / len(values), 2)


def build_clean_preview_warnings(row_count: int, dropped: int, sample_count: int) -> list[str]:
    warnings = []
    if row_count < 20:
        warnings.append("Dataset is very small; preview may not represent a stable training corpus.")
    if sample_count and dropped == sample_count:
        warnings.append("All sampled rows would be dropped by minWords.")
    return warnings


def column_profiles(
    rows: list[dict[str, Any]], columns: list[str], total_rows: int
) -> list[dict[str, Any]]:
    profiles = []
    sample_denominator = max(len(rows), 1)
    for column in columns:
        values = [row.get(column) for row in rows]
        non_empty_values = [str(value).strip() for value in values if value is not None and str(value).strip()]
        unique_count = len(set(non_empty_values))
        lengths = [len(value) for value in non_empty_values]
        profiles.append(
            {
                "name": column,
                "nonEmptySampleCount": len(non_empty_values),
                "missingSampleCount": sample_denominator - len(non_empty_values),
                "missingSampleRatio": round((sample_denominator - len(non_empty_values)) / sample_denominator, 4),
                "uniqueSampleCount": unique_count,
                "avgLength": round(sum(lengths) / len(lengths), 2) if lengths else 0,
                "maxLength": max(lengths) if lengths else 0,
                "inferredType": infer_type(non_empty_values),
                "sampleValues": non_empty_values[:5],
                "estimatedTotalRows": total_rows,
            }
        )
    return profiles


def infer_type(values: list[str]) -> str:
    if not values:
        return "empty"
    if all(is_number(value) for value in values):
        return "number"
    if sum(1 for value in values if looks_like_datetime(value)) >= max(1, int(len(values) * 0.6)):
        return "datetime"
    if sum(1 for value in values if len(value) > 50) >= max(1, int(len(values) * 0.3)):
        return "text"
    return "string"


def is_number(value: str) -> bool:
    try:
        float(value)
        return True
    except ValueError:
        return False


def looks_like_datetime(value: str) -> bool:
    raw = value.strip()
    if re.fullmatch(r"\d{4}([-/]\d{1,2}){0,2}", raw):
        return True
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S"):
        try:
            datetime.strptime(raw[:19], fmt)
            return True
        except ValueError:
            continue
    return False


def detect_columns_from_table(table: TableData) -> dict[str, Any]:
    profiles = column_profiles(table.rows, table.columns, table.total_rows)
    text_columns = []
    time_columns = []
    metadata_columns = []

    for profile in profiles:
        name = profile["name"]
        lower_name = str(name).lower()
        unique_count = profile["uniqueSampleCount"]
        sample_count = max(profile["nonEmptySampleCount"], 1)
        unique_ratio = unique_count / sample_count
        avg_length = profile["avgLength"]
        inferred_type = profile["inferredType"]

        text_score = 0.0
        if lower_name in TEXT_COLUMN_NAMES:
            text_score += 0.5
        if inferred_type == "text":
            text_score += 0.35
        if avg_length >= 20:
            text_score += 0.25
        if unique_ratio >= 0.6:
            text_score += 0.15
        if any(hint == lower_name or lower_name.endswith(f"_{hint}") for hint in ID_COLUMN_HINTS):
            text_score -= 0.5
        if text_score > 0:
            text_columns.append(
                {
                    "name": name,
                    "score": round(max(0.0, min(text_score, 1.0)), 3),
                    "reason": "name/length/uniqueness heuristic",
                }
            )

        time_score = 0.0
        if any(hint in lower_name for hint in TIME_COLUMN_HINTS):
            time_score += 0.45
        if inferred_type == "datetime":
            time_score += 0.45
        if time_score > 0:
            time_columns.append(
                {
                    "name": name,
                    "score": round(min(time_score, 1.0), 3),
                    "reason": "name/date parse heuristic",
                }
            )

        if inferred_type in {"string", "number"} and unique_ratio <= 0.5:
            metadata_columns.append(
                {
                    "name": name,
                    "score": round(1.0 - unique_ratio, 3),
                    "reason": "low-cardinality candidate",
                }
            )

    text_columns.sort(key=lambda item: item["score"], reverse=True)
    time_columns.sort(key=lambda item: item["score"], reverse=True)
    metadata_columns.sort(key=lambda item: item["score"], reverse=True)

    return {
        "filePath": str(table.file_path),
        "rowCount": table.total_rows,
        "columns": table.columns,
        "textColumns": text_columns,
        "timeColumns": time_columns,
        "metadataColumns": metadata_columns,
        "recommendedTextColumn": text_columns[0]["name"] if text_columns else None,
        "warnings": build_column_warnings(text_columns, table.total_rows),
    }


def build_column_warnings(text_columns: list[dict[str, Any]], row_count: int) -> list[str]:
    warnings = []
    if not text_columns:
        warnings.append("No text column candidate was detected.")
    if row_count < 20:
        warnings.append("Dataset is very small; topic model results may be unstable.")
    return warnings


def model_catalog(_: dict[str, Any] | None = None) -> dict[str, Any]:
    models = parse_models_yaml()
    runnable = parse_run_pipeline_models()
    if runnable:
        for model_id in list(models):
            models[model_id]["runnable"] = model_id in runnable
        for model_id in runnable:
            if model_id not in models:
                models[model_id] = {
                    "id": model_id,
                    "name": model_id.upper(),
                    "type": "unknown",
                    "requires": [],
                    "params": {},
                    "runnable": True,
                }

    return {
        "source": str(MODEL_CONFIG_PATH),
        "runnableSource": str(RUN_PIPELINE_PATH),
        "models": [models[key] for key in sorted(models)],
        "supportedModelIds": sorted(models),
    }


def model_recommend(payload: dict[str, Any]) -> dict[str, Any]:
    data_profile = payload.get("dataProfile")
    if not isinstance(data_profile, dict):
        raise ValueError("dataProfile must be an object")

    research_goal = str(payload.get("researchGoal") or "").lower()
    constraints = payload.get("constraints") if isinstance(payload.get("constraints"), dict) else {}
    catalog = model_catalog({})
    models = [model for model in catalog["models"] if model.get("runnable")]
    if not models:
        models = catalog["models"]

    summary = summarize_data_profile(data_profile)
    preferred = {str(value).lower() for value in constraints.get("preferredModelIds", []) or []}
    forbidden = {str(value).lower() for value in constraints.get("forbiddenModelIds", []) or []}
    max_topics = safe_int(constraints.get("maxTopics"), None)
    requested_topics = safe_int(constraints.get("numTopics"), None)
    topic_count = choose_topic_count(summary["rowCount"], requested_topics, max_topics)

    recommendations = []
    skipped = []
    for model in models:
        model_id = str(model["id"]).lower()
        if model_id in forbidden:
            skipped.append({"modelId": model_id, "reason": "forbidden by constraints"})
            continue

        score, reasons, warnings = score_model(model, summary, research_goal)
        if model_id in preferred:
            score += 10
            reasons.append("preferred by caller constraints")

        if not is_model_compatible(model, summary):
            score -= 30
            warnings.append("missing recommended data requirement; validate before training")

        recommendations.append(
            {
                "modelId": model_id,
                "modelName": model.get("name") or model_id.upper(),
                "score": max(0, min(100, round(score))),
                "reasons": reasons,
                "warnings": warnings,
                "requirements": model.get("requires") or [],
                "recommendedPlanPatch": {
                    "modelId": model_id,
                    "mode": "zero_shot" if model_id == "theta" else "unsupervised",
                    "numTopics": topic_count,
                    "batchSize": 64,
                    "epochs": 20 if summary["rowCount"] < 500 else 50,
                },
            }
        )

    recommendations.sort(key=lambda item: item["score"], reverse=True)
    ranked = [
        {
            "rank": index + 1,
            **item,
        }
        for index, item in enumerate(recommendations[:5])
    ]

    return {
        "deterministic": True,
        "catalogSource": catalog["source"],
        "dataProfileSummary": summary,
        "recommendations": ranked,
        "skipped": skipped,
        "warnings": build_recommendation_warnings(summary, ranked),
        "constraintsApplied": {
            "preferredModelIds": sorted(preferred),
            "forbiddenModelIds": sorted(forbidden),
            "numTopics": requested_topics,
            "maxTopics": max_topics,
        },
    }


def summarize_data_profile(data_profile: dict[str, Any]) -> dict[str, Any]:
    column_profiles = data_profile.get("columnProfiles") or []
    text_candidates = data_profile.get("textColumns") or data_profile.get("textColumnCandidates") or []
    time_candidates = data_profile.get("timeColumns") or []
    metadata_candidates = data_profile.get("metadataColumns") or []

    recommended_text = data_profile.get("recommendedTextColumn")
    if not recommended_text and text_candidates:
        recommended_text = text_candidates[0].get("name") if isinstance(text_candidates[0], dict) else text_candidates[0]

    text_profile = None
    for profile in column_profiles:
        if isinstance(profile, dict) and profile.get("name") == recommended_text:
            text_profile = profile
            break

    row_count = safe_int(data_profile.get("rowCount"), 0) or 0
    avg_text_length = float(text_profile.get("avgLength") or 0) if isinstance(text_profile, dict) else 0.0

    return {
        "rowCount": row_count,
        "columns": data_profile.get("columns") or [],
        "recommendedTextColumn": recommended_text,
        "textColumnCount": len(text_candidates),
        "timeColumnCount": len(time_candidates),
        "metadataColumnCount": len(metadata_candidates),
        "avgTextLength": avg_text_length,
        "isSmallDataset": row_count < 100,
        "isShortText": 0 < avg_text_length < 80,
    }


def score_model(model: dict[str, Any], summary: dict[str, Any], research_goal: str) -> tuple[float, list[str], list[str]]:
    model_id = str(model["id"]).lower()
    score = 50.0
    reasons = ["model exists in THETA runnable catalog"]
    warnings: list[str] = []

    if model_id == "theta":
        score += 18
        reasons.append("best aligned with THETA project default workflow")
        warnings.append("requires cloud or local LLM embeddings")
    elif model_id == "lda":
        score += 8
        reasons.append("stable baseline for general topic modeling")
    elif model_id == "btm":
        score += 10 if summary["isShortText"] else 0
        reasons.append("suitable for short text corpora")
    elif model_id == "hdp":
        score += 8 if "auto" in research_goal or "自动" in research_goal else 0
        reasons.append("can infer topic count more flexibly")
    elif model_id == "dtm":
        if summary["timeColumnCount"]:
            score += 18
            reasons.append("time column exists, enabling topic evolution analysis")
        else:
            score -= 25
            warnings.append("requires a usable time column")
    elif model_id == "stm":
        if summary["metadataColumnCount"]:
            score += 12
            reasons.append("metadata candidates exist for covariate analysis")
        else:
            score -= 25
            warnings.append("requires metadata/covariates")
    elif model_id == "bertopic":
        score += 10
        reasons.append("embedding clustering can be useful for semantic exploration")
        if summary["isSmallDataset"]:
            score -= 12
            warnings.append("small datasets can produce unstable clusters")
    elif model.get("type") == "neural":
        score += 2
        if summary["isSmallDataset"]:
            score -= 8
            warnings.append("neural models may be unstable on very small datasets")

    if "time" in research_goal or "趋势" in research_goal or "演化" in research_goal:
        score += 15 if model_id == "dtm" else -3
    if "short" in research_goal or "短文本" in research_goal:
        score += 12 if model_id == "btm" else 0
    if "baseline" in research_goal or "基线" in research_goal:
        score += 10 if model_id in {"lda", "btm"} else 0

    if summary["rowCount"] < 20:
        warnings.append("dataset has fewer than 20 rows; all recommendations are low confidence")
        score -= 10
    if not summary["recommendedTextColumn"]:
        warnings.append("no text column detected")
        score -= 40

    return score, reasons, warnings


def is_model_compatible(model: dict[str, Any], summary: dict[str, Any]) -> bool:
    requirements = set(model.get("requires") or [])
    if "text" in requirements and not summary["recommendedTextColumn"]:
        return False
    if "time" in requirements and not summary["timeColumnCount"]:
        return False
    if "covariates" in requirements and not summary["metadataColumnCount"]:
        return False
    return bool(summary["recommendedTextColumn"])


def choose_topic_count(row_count: int, requested: int | None, max_topics: int | None) -> int:
    if requested:
        topics = requested
    elif row_count < 50:
        topics = 5
    elif row_count < 300:
        topics = 10
    else:
        topics = 20

    if max_topics:
        topics = min(topics, max_topics)
    return max(2, min(topics, 200))


def build_recommendation_warnings(summary: dict[str, Any], recommendations: list[dict[str, Any]]) -> list[str]:
    warnings = []
    if not summary["recommendedTextColumn"]:
        warnings.append("No text column was detected; ask the user to select a text column before planning.")
    if summary["isSmallDataset"]:
        warnings.append("Small corpus detected; prefer fewer topics and treat metrics as exploratory.")
    if recommendations and recommendations[0]["score"] < 60:
        warnings.append("No high-confidence model recommendation was found.")
    return warnings


def safe_int(value: Any, default: int | None) -> int | None:
    try:
        if value is None or value == "":
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def parse_models_yaml() -> dict[str, dict[str, Any]]:
    try:
        import yaml  # type: ignore

        raw = yaml.safe_load(MODEL_CONFIG_PATH.read_text(encoding="utf-8")) or {}
        configured = raw.get("models") or {}
        return {
            str(model_id): {
                "id": str(model_id),
                "name": config.get("name") or str(model_id).upper(),
                "type": config.get("type") or "unknown",
                "requires": config.get("requires") or [],
                "description": config.get("description") or "",
                "autoTopics": bool(config.get("auto_topics")),
                "params": config.get("params") or {},
                "runnable": False,
            }
            for model_id, config in configured.items()
            if isinstance(config, dict)
        }
    except Exception:
        return fallback_model_catalog()


def fallback_model_catalog() -> dict[str, dict[str, Any]]:
    return {
        model_id: {
            "id": model_id,
            "name": model_id.upper(),
            "type": "unknown",
            "requires": [],
            "params": {"num_topics": {"type": "int", "default": 20}},
            "runnable": False,
        }
        for model_id in parse_run_pipeline_models()
    }


def parse_run_pipeline_models() -> list[str]:
    if not RUN_PIPELINE_PATH.exists():
        return []
    text = RUN_PIPELINE_PATH.read_text(encoding="utf-8", errors="ignore")
    match = re.search(r"ALL_MODELS\s*=\s*\[(.*?)\]", text, re.S)
    if not match:
        return []
    return re.findall(r"['\"]([a-zA-Z0-9_-]+)['\"]", match.group(1))


def plan_validate(payload: dict[str, Any]) -> dict[str, Any]:
    plan = payload.get("plan")
    if not isinstance(plan, dict):
        raise ValueError("plan must be an object")

    catalog = model_catalog({})
    models_by_id = {model["id"]: model for model in catalog["models"]}
    errors: list[str] = []
    warnings: list[str] = []
    normalized = dict(plan)

    dataset_id = str(plan.get("datasetId") or "").strip()
    model_id = str(plan.get("modelId") or "").strip().lower()
    mode = str(plan.get("mode") or "").strip()
    num_topics = plan.get("numTopics")

    if not dataset_id:
        errors.append("datasetId is required.")
    if not model_id:
        errors.append("modelId is required.")
    elif model_id not in models_by_id:
        errors.append(f"Unsupported modelId '{model_id}'.")
    elif not models_by_id[model_id].get("runnable"):
        warnings.append(f"Model '{model_id}' is configured but not listed in run_pipeline.ALL_MODELS.")

    if mode not in {"zero_shot", "finetune", "supervised", "unsupervised"}:
        errors.append("mode must be one of zero_shot, finetune, supervised, unsupervised.")

    try:
        num_topics_int = int(num_topics)
        normalized["numTopics"] = num_topics_int
        if num_topics_int < 2 or num_topics_int > 200:
            errors.append("numTopics must be between 2 and 200.")
    except (TypeError, ValueError):
        errors.append("numTopics must be an integer.")

    if model_id in {"theta", "ctm", "dtm"}:
        warnings.append("This model requires embeddings; verify local or cloud embedding settings before training.")
    if model_id == "stm":
        warnings.append("STM requires covariates; a dataset without metadata should use another model.")
    if model_id == "dtm":
        warnings.append("DTM requires a time column.")

    return {
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "normalizedPlan": normalized,
        "catalogSource": catalog["source"],
    }


def plan_create(payload: dict[str, Any]) -> dict[str, Any]:
    plan = payload.get("plan")
    if not isinstance(plan, dict):
        raise ValueError("plan must be an object")

    rationale = str(payload.get("rationale") or "").strip()
    validation = plan_validate({"plan": plan, "dataProfile": payload.get("dataProfile")})
    normalized_plan = validation["normalizedPlan"]
    plan_hash = sha256_json(normalized_plan)
    plan_id = f"plan_{plan_hash[:12]}"
    now = utc_now_iso()

    with connect_state_db() as conn:
        init_state_db(conn)
        conn.execute(
            """
            INSERT INTO training_plans
                (plan_id, plan_hash, plan_json, rationale, valid, validation_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(plan_id) DO UPDATE SET
                plan_json = excluded.plan_json,
                rationale = excluded.rationale,
                valid = excluded.valid,
                validation_json = excluded.validation_json
            """,
            (
                plan_id,
                plan_hash,
                stable_json(normalized_plan),
                rationale,
                1 if validation["valid"] else 0,
                stable_json(validation),
                now,
            ),
        )
        record_event(
            conn,
            "plan.created",
            "training_plan",
            plan_id,
            {
                "planId": plan_id,
                "planHash": plan_hash,
                "valid": validation["valid"],
                "rationale": rationale,
            },
        )

    return {
        "planId": plan_id,
        "planHash": plan_hash,
        "valid": validation["valid"],
        "approvalRequired": True,
        "createdAt": now,
        "normalizedPlan": normalized_plan,
        "validation": validation,
        "stateDb": str(STATE_DB_PATH),
    }


def plan_approve(payload: dict[str, Any]) -> dict[str, Any]:
    plan_id = str(payload.get("planId") or "").strip()
    plan_hash = str(payload.get("planHash") or "").strip()
    approved_by = str(payload.get("approvedBy") or "").strip()
    approval_note = str(payload.get("approvalNote") or "").strip()

    if not plan_id:
        raise ValueError("planId is required")
    if not plan_hash:
        raise ValueError("planHash is required")
    if not approved_by:
        raise ValueError("approvedBy is required")

    with connect_state_db() as conn:
        init_state_db(conn)
        row = conn.execute(
            "SELECT plan_hash, valid, validation_json FROM training_plans WHERE plan_id = ?",
            (plan_id,),
        ).fetchone()
        if row is None:
            raise ValueError(f"Unknown planId: {plan_id}")
        if row["plan_hash"] != plan_hash:
            raise ValueError("planHash does not match stored plan")
        if not bool(row["valid"]):
            raise ValueError("Cannot approve an invalid plan")

        approval_id = f"approval_{sha256_json({'planId': plan_id, 'planHash': plan_hash, 'approvedBy': approved_by})[:12]}"
        now = utc_now_iso()
        conn.execute(
            """
            INSERT INTO plan_approvals
                (approval_id, plan_id, plan_hash, approved_by, approval_note, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(approval_id) DO UPDATE SET
                approval_note = excluded.approval_note
            """,
            (approval_id, plan_id, plan_hash, approved_by, approval_note, now),
        )
        record_event(
            conn,
            "plan.approved",
            "training_plan",
            plan_id,
            {
                "approvalId": approval_id,
                "planId": plan_id,
                "planHash": plan_hash,
                "approvedBy": approved_by,
            },
        )

    return {
        "approvalId": approval_id,
        "planId": plan_id,
        "planHash": plan_hash,
        "approvedBy": approved_by,
        "approvedAt": now,
        "stateDb": str(STATE_DB_PATH),
    }


def training_dry_run(payload: dict[str, Any]) -> dict[str, Any]:
    plan_record = require_mapping(payload.get("plan"), "plan")
    plan_review = require_mapping(payload.get("planReview"), "planReview")
    dataset_path = resolve_dataset_path({"filePath": payload.get("datasetPath")})
    plan_id = required_mapping_text(plan_record, "planId", "plan")
    plan_hash = required_mapping_text(plan_record, "planHash", "plan")
    canonical = require_mapping(plan_record.get("canonicalPlan"), "plan.canonicalPlan")
    if sha256_json(canonical) != plan_hash:
        raise ValueError("planHash does not match canonicalPlan")
    if plan_review.get("approvalType") != "human_plan_review":
        raise ValueError("planReview must be a HumanPlanReview receipt")
    if plan_review.get("planId") != plan_id or plan_review.get("planHash") != plan_hash:
        raise ValueError("planReview does not bind the canonical plan")

    plan = legacy_plan_from_record(plan_record, dataset_path)
    checks = training_preflight_checks(plan_record, plan, dataset_path)
    commands = build_training_commands(plan)
    return {
        "passed": all(check["status"] != "fail" for check in checks),
        "checks": checks,
        "commands": commands,
        "expectedArtifacts": expected_training_artifacts(plan),
        "notes": [
            "Dry run does not start Python training.",
            "The returned command and checks are bound by TypeScript to planHash and HumanPlanReview.",
        ],
        "checkedAt": utc_now_iso(),
    }


def training_start(payload: dict[str, Any]) -> dict[str, Any]:
    plan_record = require_mapping(payload.get("plan"), "plan")
    plan_review = require_mapping(payload.get("planReview"), "planReview")
    dry_run = require_mapping(payload.get("dryRun"), "dryRun")
    training_review = require_mapping(payload.get("trainingReview"), "trainingReview")
    plan_id = required_mapping_text(plan_record, "planId", "plan")
    plan_hash = required_mapping_text(plan_record, "planHash", "plan")
    canonical = require_mapping(plan_record.get("canonicalPlan"), "plan.canonicalPlan")
    if sha256_json(canonical) != plan_hash:
        raise ValueError("planHash does not match canonicalPlan")
    plan_review_id = required_mapping_text(plan_review, "approvalId", "planReview")
    training_review_id = required_mapping_text(training_review, "approvalId", "trainingReview")
    dry_run_hash = required_mapping_text(dry_run, "dryRunHash", "dryRun")
    idempotency_key = str(payload.get("idempotencyKey") or "").strip()
    retry_of_training_run_id = str(payload.get("retryOfTrainingRunId") or "").strip()
    retry_reason = str(payload.get("retryReason") or "").strip()

    if not idempotency_key:
        raise ValueError("idempotencyKey is required")
    if plan_review_id == training_review_id:
        raise ValueError("planReview and trainingReview approval IDs must be different")
    if plan_review.get("approvalType") != "human_plan_review":
        raise ValueError("planReview must be a HumanPlanReview receipt")
    if training_review.get("approvalType") != "human_training_review":
        raise ValueError("trainingReview must be a HumanTrainingReview receipt")
    for receipt_name, receipt in (
        ("planReview", plan_review),
        ("dryRun", dry_run),
        ("trainingReview", training_review),
    ):
        if receipt.get("planId") != plan_id or receipt.get("planHash") != plan_hash:
            raise ValueError(f"{receipt_name} does not bind the canonical plan")
    if dry_run.get("planReviewApprovalId") != plan_review_id:
        raise ValueError("dryRun does not bind planReview")
    if dry_run.get("passed") is not True:
        raise ValueError("dryRun must pass before training starts")
    if training_review.get("dryRunHash") != dry_run_hash:
        raise ValueError("trainingReview does not bind the current dryRun")
    commands = dry_run.get("commands")
    expected_artifacts = dry_run.get("expectedArtifacts")
    if not isinstance(commands, list) or not commands:
        raise ValueError("dryRun.commands must not be empty")
    if not isinstance(expected_artifacts, list):
        raise ValueError("dryRun.expectedArtifacts must be an array")
    dry_run_material = {
        "planId": dry_run.get("planId"),
        "planHash": dry_run.get("planHash"),
        "planReviewApprovalId": dry_run.get("planReviewApprovalId"),
        "passed": dry_run.get("passed"),
        "checks": dry_run.get("checks"),
        "commands": commands,
        "expectedArtifacts": expected_artifacts,
        "notes": dry_run.get("notes"),
    }
    if sha256_json(dry_run_material) != dry_run_hash:
        raise ValueError("dryRunHash does not match the dry-run material")
    prepare_commands = [
        item
        for item in commands
        if isinstance(item, dict) and item.get("step") == "prepare_data"
    ]
    if len(prepare_commands) != 1:
        raise ValueError("dryRun must contain exactly one prepare_data command")
    prepare_argv = prepare_commands[0].get("argv")
    if not isinstance(prepare_argv, list) or "--raw-input" not in prepare_argv:
        raise ValueError("dryRun prepare_data command must bind --raw-input")
    raw_input_index = prepare_argv.index("--raw-input") + 1
    if raw_input_index >= len(prepare_argv):
        raise ValueError("dryRun --raw-input is missing its path")
    dataset_path = resolve_dataset_path({"filePath": prepare_argv[raw_input_index]})
    resolved_plan = legacy_plan_from_record(plan_record, dataset_path)
    resolved_commands = build_training_commands(resolved_plan)
    resolved_artifacts = expected_training_artifacts(resolved_plan)
    if stable_json(commands) != stable_json(resolved_commands):
        raise ValueError("dryRun.commands do not match the canonical command compiler")
    if stable_json(expected_artifacts) != stable_json(resolved_artifacts):
        raise ValueError("dryRun.expectedArtifacts do not match the canonical plan")

    with connect_state_db() as conn:
        init_state_db(conn)
        existing_row = select_training_run(conn, idempotency_key=idempotency_key)
        if existing_row is not None:
            assert_training_run_binding(
                existing_row,
                plan_id=plan_id,
                plan_hash=plan_hash,
                plan_review_approval_id=plan_review_id,
                training_review_approval_id=training_review_id,
                dry_run_hash=dry_run_hash,
            )
            existing_status = str(existing_row["status"])
            if existing_status in {"queued", "running", "cancel_requested"}:
                existing_row = reconcile_training_run(conn, existing_row)
                existing_status = str(existing_row["status"])
            if existing_status == "failed":
                raise ValueError(
                    "The idempotent training run failed. Supply a new idempotencyKey, "
                    "retryOfTrainingRunId, and retryReason to create a new attempt."
                )
            if existing_status not in {
                "queued",
                "running",
                "cancel_requested",
                "completed",
                "cancelled",
                "quarantined",
            }:
                existing_row = quarantine_training_run(
                    conn,
                    existing_row,
                    f"Unknown persisted training status: {existing_status}",
                    source="idempotency_reconcile",
                )
            return training_run_response(
                existing_row,
                process_started=bool(existing_row["pid"]),
                message="Existing idempotent training run returned.",
            )

        attempt = 1
        if retry_of_training_run_id:
            prior = select_training_run(
                conn, training_run_id=retry_of_training_run_id
            )
            if prior is None:
                raise ValueError(
                    f"Unknown retryOfTrainingRunId: {retry_of_training_run_id}"
                )
            prior_status = str(prior["status"])
            prior_quality = json.loads(prior["quality_json"] or "{}")
            quality_failed = prior_status == "completed" and str(prior_quality.get("status") or "") == "failed"
            if quality_failed:
                raise ValueError(
                    "Quality-gate failures require a revised plan; unchanged training retries are not allowed"
                )
            if prior_status not in {"failed", "quarantined"}:
                raise ValueError(
                    "Only execution-failed or quarantined training runs may be retried"
                )
            if prior["plan_id"] != plan_id or prior["plan_hash"] != plan_hash:
                raise ValueError("Retry run does not bind the same canonical plan")
            if not retry_reason:
                raise ValueError("retryReason is required for an explicit retry")
            attempt = int(prior["attempt"] or 1) + 1
        elif retry_reason:
            raise ValueError("retryReason requires retryOfTrainingRunId")

        run_hash = sha256_json({"idempotencyKey": idempotency_key})
        training_run_id = f"run_{run_hash[:12]}"
        runtime_commands, runtime_expected_artifacts = bind_training_run_namespace(
            commands,
            expected_artifacts,
            training_run_id,
        )
        now = utc_now_iso()
        run_dir = RUNS_DIR / training_run_id
        run_dir.mkdir(parents=True, exist_ok=True)
        log_path = run_dir / "training.log"

        conn.execute(
            """
            INSERT INTO training_runs
                (training_run_id, plan_id, plan_hash, approval_id,
                 plan_review_approval_id, training_review_approval_id, dry_run_hash,
                 idempotency_key, attempt, retry_of_training_run_id, retry_reason,
                 status, progress, command_json, artifact_json, result_json,
                 cancellation_json, error_message, failure_json, quarantine_reason,
                 pid, current_step, log_path, python_executable, python_version,
                 python_environment, started_at, finished_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                training_run_id,
                plan_id,
                plan_hash,
                training_review_id,
                plan_review_id,
                training_review_id,
                dry_run_hash,
                idempotency_key,
                attempt,
                retry_of_training_run_id,
                retry_reason,
                "queued",
                0,
                stable_json(runtime_commands),
                stable_json(runtime_expected_artifacts),
                "[]",
                "",
                "",
                "",
                "",
                None,
                "queued",
                str(log_path),
                str(Path(PYTHON_BIN).resolve()),
                platform.python_version(),
                os.environ.get("VIRTUAL_ENV") or sys.prefix,
                "",
                "",
                now,
                now,
            ),
        )
        conn.commit()
        try:
            runner_pid = spawn_training_runner(training_run_id)
        except Exception as exc:
            failed_at = utc_now_iso()
            failure = {
                "code": "PYTHON_ENVIRONMENT_MISMATCH",
                "stage": "runner_start",
                "summary": "无法使用已确认的 Python 环境启动后台训练进程。",
                "technicalDetail": str(exc),
                "retryable": True,
                "suggestedCommands": [
                    "Run uv sync --extra training, then run doctor again."
                ],
                "partialArtifactsAvailable": False,
            }
            conn.execute(
                """
                UPDATE training_runs
                SET status = 'failed', current_step = 'runner_start',
                    error_message = ?, failure_json = ?,
                    finished_at = ?, updated_at = ?
                WHERE training_run_id = ?
                """,
                (
                    str(exc),
                    stable_json(failure),
                    failed_at,
                    failed_at,
                    training_run_id,
                ),
            )
            record_event(
                conn,
                "training.failed",
                "training_run",
                training_run_id,
                {
                    "trainingRunId": training_run_id,
                    "status": "failed",
                    "step": "runner_start",
                    "error": str(exc),
                    "failure": failure,
                },
            )
            raise
        conn.execute(
            """
            UPDATE training_runs
            SET pid = ?, runner_pid = ?, updated_at = ?
            WHERE training_run_id = ?
            """,
            (runner_pid, runner_pid, utc_now_iso(), training_run_id),
        )
        record_event(
            conn,
            "training.queued",
            "training_run",
            training_run_id,
            {
                "trainingRunId": training_run_id,
                "planId": plan_id,
                "planHash": plan_hash,
                "planReviewApprovalId": plan_review_id,
                "trainingReviewApprovalId": training_review_id,
                "dryRunHash": dry_run_hash,
                "attempt": attempt,
                "retryOfTrainingRunId": retry_of_training_run_id or None,
                "processStarted": True,
                "pid": runner_pid,
                "runnerPid": runner_pid,
                "logPath": str(log_path),
            },
        )
        row = select_training_run(conn, training_run_id=training_run_id)
        assert row is not None
        return training_run_response(
            row,
            process_started=True,
            message="Approved training run queued. The local runner will execute it in the background.",
        )


def training_status(payload: dict[str, Any]) -> dict[str, Any]:
    training_run_id = str(payload.get("trainingRunId") or "").strip()
    if not training_run_id:
        raise ValueError("trainingRunId is required")

    with connect_state_db() as conn:
        init_state_db(conn)
        row = select_training_run(conn, training_run_id=training_run_id)
        if row is None:
            return {
                "trainingRunId": training_run_id,
                "found": False,
                "status": "not_found",
                "logs": [],
                "events": [],
            }
        # Status lookups are retry-aware: callers holding the original failed
        # receipt automatically follow the newest durable attempt.
        while True:
            retry = conn.execute(
                f"""
                SELECT {TRAINING_RUN_SELECT_COLUMNS}
                FROM training_runs
                WHERE retry_of_training_run_id = ?
                ORDER BY attempt DESC, created_at DESC
                LIMIT 1
                """,
                (row["training_run_id"],),
            ).fetchone()
            if retry is None:
                break
            row = retry
        row = reconcile_training_run(conn, row)
        resolved_training_run_id = str(row["training_run_id"])
        events = conn.execute(
            """
            SELECT event_type, payload_json, created_at
            FROM agent_events
            WHERE subject_type = 'training_run' AND subject_id = ?
            ORDER BY id ASC
            """,
            (resolved_training_run_id,),
        ).fetchall()

    receipt = training_run_response(
        row,
        process_started=bool(row["pid"]),
        message="Current persisted training receipt.",
    )
    reassessed = bool(payload.get("reassessQuality"))
    reassessment_receipt = None
    if reassessed:
        rebound_artifacts = bind_result_artifacts(
            json.loads(row["result_json"] or "[]")
        )
        prior_quality = json.loads(row["quality_json"] or "{}")
        model_id = str(prior_quality.get("modelId") or "unknown")
        receipt["resultArtifacts"] = rebound_artifacts
        receipt["quality"] = assess_result_quality(rebound_artifacts, model_id)
        reassessment_receipt = persist_quality_reassessment(
            resolved_training_run_id,
            rebound_artifacts,
            receipt["quality"],
        )
        receipt["message"] = "Quality was reassessed from current run-bound artifacts without retraining."
    requested_log_limit = max(0, safe_int(payload.get("logLimit"), 80))
    return {
        "trainingRunId": row["training_run_id"],
        "found": True,
        "receipt": receipt,
        "status": row["status"],
        "reassessed": reassessed,
        **({"reassessmentReceipt": reassessment_receipt} if reassessment_receipt else {}),
        "logs": tail_log_lines(row["log_path"], limit=requested_log_limit),
        "events": [
            {
                "type": event["event_type"],
                "payload": json.loads(event["payload_json"]),
                "createdAt": event["created_at"],
            }
            for event in events
        ],
    }


def training_cancel(payload: dict[str, Any]) -> dict[str, Any]:
    training_run_id = str(payload.get("trainingRunId") or "").strip()
    reason = str(payload.get("reason") or "").strip()
    operator = str(payload.get("operator") or "").strip()
    if not training_run_id:
        raise ValueError("trainingRunId is required")
    if not reason:
        raise ValueError("reason is required")
    if not operator:
        raise ValueError("operator is required")

    now = utc_now_iso()
    with connect_state_db() as conn:
        init_state_db(conn)
        row = select_training_run(conn, training_run_id=training_run_id)
        if row is None:
            raise ValueError(f"Unknown trainingRunId: {training_run_id}")

        current_status = str(row["status"])
        terminal_statuses = {"completed", "failed", "cancelled", "quarantined"}
        existing_cancellation = json.loads(row["cancellation_json"] or "null")
        if existing_cancellation is not None:
            return {
                "trainingRunId": training_run_id,
                "status": current_status,
                "changed": False,
                "reason": existing_cancellation["reason"],
                "cancellation": existing_cancellation,
                "message": "Existing cancellation receipt returned.",
            }

        cancellation = {
            "cancellationId": f"cancel_{sha256_json({'trainingRunId': training_run_id, 'operator': operator, 'reason': reason})[:20]}",
            "trainingRunId": training_run_id,
            "operator": operator,
            "reason": reason,
            "requestedAt": now,
            "targetPid": (
                int(row["active_pid"] or row["runner_pid"] or row["pid"])
                if row["active_pid"] or row["runner_pid"] or row["pid"]
                else None
            ),
            "gracefulResult": (
                "pending"
                if row["active_pid"] or row["runner_pid"] or row["pid"]
                else "not_required"
            ),
            "forcedResult": (
                "pending"
                if row["active_pid"] or row["runner_pid"] or row["pid"]
                else "not_required"
            ),
        }
        if current_status in terminal_statuses:
            conn.execute(
                """
                UPDATE training_runs
                SET cancellation_json = ?, updated_at = ?
                WHERE training_run_id = ?
                """,
                (stable_json(cancellation), now, training_run_id),
            )
            return {
                "trainingRunId": training_run_id,
                "status": current_status,
                "changed": False,
                "reason": reason,
                "cancellation": cancellation,
                "message": f"Run is already terminal: {current_status}",
            }

        next_status = (
            "cancel_requested"
            if row["active_pid"] or row["runner_pid"] or row["pid"]
            else "cancelled"
        )
        conn.execute(
            """
            UPDATE training_runs
            SET status = ?, error_message = ?, cancellation_json = ?,
                finished_at = CASE WHEN ? = 'cancelled' THEN ? ELSE finished_at END,
                updated_at = ?
            WHERE training_run_id = ?
            """,
            (
                next_status,
                reason,
                stable_json(cancellation),
                next_status,
                now,
                now,
                training_run_id,
            ),
        )
        record_event(
            conn,
            "training.cancel_requested" if next_status == "cancel_requested" else "training.cancelled",
            "training_run",
            training_run_id,
            {
                **cancellation,
                "previousStatus": current_status,
                "status": next_status,
            },
        )

    return {
        "trainingRunId": training_run_id,
        "status": next_status,
        "changed": True,
        "reason": reason,
        "cancellation": cancellation,
        "message": "Cancellation recorded locally.",
    }


def results_list(payload: dict[str, Any]) -> dict[str, Any]:
    max_files = safe_int(payload.get("maxFiles"), 250) or 250
    max_files = max(1, min(max_files, 1000))
    include_preview = bool(payload.get("includePreview", False))
    roots, inferred_filters, warnings = result_search_roots(payload)

    files: list[Path] = []
    seen: set[str] = set()
    for root in roots:
        if not root.exists():
            continue
        search_root = root if root.is_dir() else root.parent
        if root.is_file():
            candidates = [root]
        else:
            candidates = sorted(search_root.rglob("*"), key=lambda item: str(item).lower())
        for candidate in candidates:
            if not candidate.is_file():
                continue
            if candidate.suffix.lower() not in RESULT_ALLOWED_SUFFIXES:
                continue
            if not result_file_matches(candidate, inferred_filters):
                continue
            resolved = str(candidate.resolve())
            if resolved in seen:
                continue
            seen.add(resolved)
            files.append(candidate)
            if len(files) >= max_files:
                break
        if len(files) >= max_files:
            break

    artifacts = [result_artifact(file_path, include_preview=include_preview) for file_path in files]
    counts = Counter(str(item["kind"]) for item in artifacts)
    suffix_counts = Counter(str(item["suffix"]) for item in artifacts)

    if not artifacts:
        warnings.append(
            "No result artifacts were found. Check trainingRunId, datasetId/userId/modelId filters, or pass resultRoot."
        )

    return {
        "trainingRunId": payload.get("trainingRunId") or None,
        "filters": inferred_filters,
        "roots": [
            {
                "path": str(root),
                "relativePath": project_relative_path(root),
                "exists": root.exists(),
            }
            for root in roots
        ],
        "artifactCount": len(artifacts),
        "countsByKind": dict(counts),
        "countsBySuffix": dict(suffix_counts),
        "artifacts": artifacts,
        "warnings": warnings,
    }


def results_summarize(payload: dict[str, Any]) -> dict[str, Any]:
    list_payload = dict(payload)
    list_payload["includePreview"] = True
    listed = results_list(list_payload)
    selected_ids = {str(value) for value in payload.get("artifactIds") or []}
    artifacts = listed["artifacts"]
    if selected_ids:
        artifacts = [artifact for artifact in artifacts if str(artifact["id"]) in selected_ids]

    topic_tables = []
    metrics = []
    config_files = []
    previews = []
    for artifact in artifacts:
        path = PROJECT_ROOT / str(artifact["relativePath"])
        name_lower = str(artifact["name"]).lower()
        preview = artifact.get("preview") if isinstance(artifact.get("preview"), dict) else {}
        if artifact.get("kind") == "table":
            table_summary = summarize_table_artifact(path, preview)
            if table_summary:
                if table_summary.get("kind") == "topic_table":
                    topic_tables.append(table_summary)
                else:
                    previews.append(table_summary)
        elif artifact.get("suffix") == ".json":
            json_summary = summarize_json_artifact(path, name_lower)
            if json_summary:
                if "metric" in name_lower or "history" in name_lower or "eval" in name_lower:
                    metrics.append(json_summary)
                elif "config" in name_lower:
                    config_files.append(json_summary)
                else:
                    previews.append(json_summary)
        elif artifact.get("kind") in {"text", "html"} and preview:
            previews.append(
                {
                    "artifactId": artifact["id"],
                    "name": artifact["name"],
                    "kind": artifact["kind"],
                    "preview": preview.get("text") or preview.get("summary"),
                }
            )

    image_artifacts = [artifact for artifact in artifacts if artifact.get("kind") == "image"]
    html_artifacts = [artifact for artifact in artifacts if artifact.get("kind") == "html"]

    return {
        "trainingRunId": listed.get("trainingRunId"),
        "artifactCount": len(artifacts),
        "countsByKind": listed.get("countsByKind", {}),
        "topicTables": topic_tables,
        "metrics": metrics,
        "configs": config_files,
        "visualizations": {
            "imageCount": len(image_artifacts),
            "htmlCount": len(html_artifacts),
            "images": [
                {
                    "artifactId": artifact["id"],
                    "name": artifact["name"],
                    "relativePath": artifact["relativePath"],
                }
                for artifact in image_artifacts[:30]
            ],
            "html": [
                {
                    "artifactId": artifact["id"],
                    "name": artifact["name"],
                    "relativePath": artifact["relativePath"],
                }
                for artifact in html_artifacts[:10]
            ],
        },
        "textPreviews": previews[:20],
        "warnings": listed.get("warnings", []),
        "deterministic": True,
    }


def events_export(payload: dict[str, Any]) -> dict[str, Any]:
    since_event_id = safe_int(payload.get("sinceEventId"), None)
    until_event_id = safe_int(payload.get("untilEventId"), None)
    limit = safe_int(payload.get("limit"), 500) or 500
    limit = max(1, min(limit, 5000))
    subject_type = normalize_optional_string(payload.get("subjectType"))
    subject_id = normalize_optional_string(payload.get("subjectId"))
    include_snapshots = bool(payload.get("includeSnapshots", False))

    event_types = payload.get("eventTypes") or []
    if not isinstance(event_types, list):
        raise ValueError("eventTypes must be an array when provided")
    normalized_event_types = [str(value).strip() for value in event_types if str(value).strip()]

    where_parts = []
    params: list[Any] = []
    if since_event_id is not None:
        where_parts.append("id > ?")
        params.append(since_event_id)
    if until_event_id is not None:
        where_parts.append("id <= ?")
        params.append(until_event_id)
    if normalized_event_types:
        where_parts.append(f"event_type IN ({','.join('?' for _ in normalized_event_types)})")
        params.extend(normalized_event_types)
    if subject_type:
        where_parts.append("subject_type = ?")
        params.append(subject_type)
    if subject_id:
        where_parts.append("subject_id = ?")
        params.append(subject_id)

    where_sql = f"WHERE {' AND '.join(where_parts)}" if where_parts else ""
    query = f"""
        SELECT id, event_type, subject_type, subject_id, payload_json, created_at
        FROM agent_events
        {where_sql}
        ORDER BY id ASC
        LIMIT ?
    """
    params.append(limit)

    with connect_state_db() as conn:
        init_state_db(conn)
        rows = conn.execute(query, params).fetchall()
        events = [agent_event_from_row(row) for row in rows]
        snapshot = build_state_snapshot(conn) if include_snapshots else None

    export_body: dict[str, Any] = {
        "protocol": BRIDGE_PROTOCOL,
        "exportedAt": utc_now_iso(),
        "stateDb": str(STATE_DB_PATH),
        "filters": {
            "sinceEventId": since_event_id,
            "untilEventId": until_event_id,
            "eventTypes": normalized_event_types,
            "subjectType": subject_type or None,
            "subjectId": subject_id or None,
            "limit": limit,
        },
        "eventCount": len(events),
        "firstEventId": events[0]["id"] if events else None,
        "lastEventId": events[-1]["id"] if events else None,
        "events": events,
        "deterministic": True,
    }
    if snapshot is not None:
        export_body["snapshot"] = snapshot
    export_body["exportHash"] = sha256_json({"events": events, "snapshot": snapshot})
    return export_body


def events_replay(payload: dict[str, Any]) -> dict[str, Any]:
    events = payload.get("events")
    if not isinstance(events, list):
        raise ValueError("events must be an array")
    verify_state = bool(payload.get("verifyState", False))

    normalized_events = [normalize_exported_event(event) for event in events]
    warnings = validate_event_sequence(normalized_events)
    counts_by_type: Counter[str] = Counter()
    subjects: dict[str, dict[str, Any]] = {}

    for event in normalized_events:
        event_type = event["eventType"]
        subject_key = f"{event['subjectType']}:{event['subjectId']}"
        payload_value = event["payload"]
        counts_by_type[event_type] += 1
        subject = subjects.setdefault(
            subject_key,
            {
                "subjectType": event["subjectType"],
                "subjectId": event["subjectId"],
                "eventCount": 0,
                "firstEventId": event["id"],
                "lastEventId": event["id"],
                "lastEventType": event_type,
                "status": None,
            },
        )
        subject["eventCount"] += 1
        subject["lastEventId"] = event["id"]
        subject["lastEventType"] = event_type
        status = payload_value.get("status") if isinstance(payload_value, dict) else None
        if status:
            subject["status"] = status

    state_check = None
    if verify_state:
        state_check = verify_events_against_state(normalized_events)

    return {
        "replayedAt": utc_now_iso(),
        "eventCount": len(normalized_events),
        "firstEventId": normalized_events[0]["id"] if normalized_events else None,
        "lastEventId": normalized_events[-1]["id"] if normalized_events else None,
        "countsByType": dict(counts_by_type),
        "subjects": list(subjects.values()),
        "warnings": warnings,
        "stateCheck": state_check,
        "replayHash": sha256_json(normalized_events),
        "sideEffects": [],
        "deterministic": True,
    }


def rag_index(payload: dict[str, Any]) -> dict[str, Any]:
    collection_name = normalize_collection_name(payload.get("collectionName"))
    source_values = payload.get("sourcePaths")
    if not isinstance(source_values, list) or not source_values:
        raise ValueError("sourcePaths must be a non-empty array")

    max_files = safe_int(payload.get("maxFiles"), 500) or 500
    max_files = max(1, min(max_files, 5000))
    replace = bool(payload.get("replace", True))
    warnings: list[str] = []
    files = collect_rag_files(source_values, max_files, warnings)
    now = utc_now_iso()

    indexed_documents = 0
    indexed_chunks = 0
    skipped_documents: list[dict[str, Any]] = []
    with connect_state_db() as conn:
        init_state_db(conn)
        if replace:
            conn.execute("DELETE FROM rag_chunks WHERE collection_name = ?", (collection_name,))
            conn.execute("DELETE FROM rag_documents WHERE collection_name = ?", (collection_name,))

        for path in files:
            try:
                stat = path.stat()
                if stat.st_size > RAG_MAX_FILE_BYTES:
                    skipped_documents.append(
                        {
                            "path": project_relative_path(path),
                            "reason": f"file exceeds {RAG_MAX_FILE_BYTES} bytes",
                        }
                    )
                    continue
                text, encoding = read_text_with_encoding(path)
                normalized_text = normalize_rag_text(text)
                if not normalized_text:
                    skipped_documents.append(
                        {"path": project_relative_path(path), "reason": "no indexable text"}
                    )
                    continue
                document_id = rag_document_id(collection_name, path)
                content_hash = hashlib.sha256(normalized_text.encode("utf-8")).hexdigest()
                chunks = chunk_text(normalized_text)
                conn.execute(
                    """
                    INSERT OR REPLACE INTO rag_documents
                        (collection_name, document_id, source_path, relative_path, suffix,
                         title, encoding, byte_size, content_hash, indexed_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        collection_name,
                        document_id,
                        str(path),
                        project_relative_path(path),
                        path.suffix.lower(),
                        path.name,
                        encoding,
                        stat.st_size,
                        content_hash,
                        now,
                    ),
                )
                conn.execute(
                    "DELETE FROM rag_chunks WHERE collection_name = ? AND document_id = ?",
                    (collection_name, document_id),
                )
                for index, chunk in enumerate(chunks):
                    chunk_id = f"{document_id}:{index}"
                    tokens = tokenize_for_search(chunk["text"])
                    conn.execute(
                        """
                        INSERT OR REPLACE INTO rag_chunks
                            (collection_name, chunk_id, document_id, chunk_index,
                             start_char, end_char, text, token_json)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            collection_name,
                            chunk_id,
                            document_id,
                            index,
                            chunk["start"],
                            chunk["end"],
                            chunk["text"],
                            stable_json(tokens),
                        ),
                    )
                indexed_documents += 1
                indexed_chunks += len(chunks)
            except Exception as exc:
                skipped_documents.append(
                    {
                        "path": project_relative_path(path),
                        "reason": f"{exc.__class__.__name__}: {exc}",
                    }
                )

        record_event(
            conn,
            "rag.indexed",
            "rag_collection",
            collection_name,
            {
                "collectionName": collection_name,
                "sourceCount": len(source_values),
                "indexedDocuments": indexed_documents,
                "indexedChunks": indexed_chunks,
                "skippedDocuments": len(skipped_documents),
                "replace": replace,
            },
        )

    return {
        "collectionName": collection_name,
        "indexedDocuments": indexed_documents,
        "indexedChunks": indexed_chunks,
        "skippedDocuments": skipped_documents[:50],
        "warnings": warnings,
        "stateDb": str(STATE_DB_PATH),
        "deterministic": True,
    }


def rag_search(payload: dict[str, Any]) -> dict[str, Any]:
    collection_name = normalize_collection_name(payload.get("collectionName"))
    query = str(payload.get("query") or "").strip()
    if not query:
        raise ValueError("query is required")
    limit = safe_int(payload.get("limit"), 8) or 8
    limit = max(1, min(limit, 50))
    query_tokens = tokenize_for_search(query)
    if not query_tokens:
        raise ValueError("query does not contain searchable terms")

    with connect_state_db() as conn:
        init_state_db(conn)
        document_count = conn.execute(
            "SELECT COUNT(*) AS count FROM rag_documents WHERE collection_name = ?",
            (collection_name,),
        ).fetchone()["count"]
        rows = conn.execute(
            """
            SELECT c.chunk_id, c.document_id, c.chunk_index, c.start_char, c.end_char,
                   c.text, c.token_json, d.source_path, d.relative_path, d.title, d.suffix
            FROM rag_chunks c
            JOIN rag_documents d
              ON d.collection_name = c.collection_name
             AND d.document_id = c.document_id
            WHERE c.collection_name = ?
            """,
            (collection_name,),
        ).fetchall()

    scored = []
    query_counter = Counter(query_tokens)
    query_text = query.lower()
    for row in rows:
        try:
            chunk_tokens = json.loads(row["token_json"] or "[]")
        except json.JSONDecodeError:
            chunk_tokens = []
        score = score_rag_chunk(query_counter, chunk_tokens, row["text"], query_text)
        if score <= 0:
            continue
        scored.append((score, row))

    scored.sort(key=lambda item: (-item[0], str(item[1]["relative_path"]), int(item[1]["chunk_index"])))
    citations = []
    for score, row in scored[:limit]:
        citations.append(
            {
                "collectionName": collection_name,
                "chunkId": row["chunk_id"],
                "documentId": row["document_id"],
                "title": row["title"],
                "relativePath": row["relative_path"],
                "sourcePath": row["source_path"],
                "chunkIndex": row["chunk_index"],
                "startChar": row["start_char"],
                "endChar": row["end_char"],
                "score": round(score, 4),
                "text": row["text"],
            }
        )

    return {
        "collectionName": collection_name,
        "query": query,
        "queryTokens": query_tokens,
        "documentCount": document_count,
        "searchedChunks": len(rows),
        "citations": citations,
        "deterministic": True,
    }


def normalize_collection_name(value: Any) -> str:
    name = str(value or "").strip()
    if not name:
        raise ValueError("collectionName is required")
    if not re.match(r"^[A-Za-z0-9_.-]{1,80}$", name):
        raise ValueError("collectionName may contain only letters, numbers, underscores, dots and hyphens")
    return name


def collect_rag_files(source_values: list[Any], max_files: int, warnings: list[str]) -> list[Path]:
    files: list[Path] = []
    seen: set[str] = set()
    for value in source_values:
        path = resolve_local_rag_source(value)
        candidates = [path]
        if path.is_dir():
            candidates = [
                item
                for item in path.rglob("*")
                if item.is_file() and not should_skip_rag_path(item)
            ]
        for candidate in candidates:
            if should_skip_rag_path(candidate):
                continue
            if candidate.suffix.lower() not in RAG_TEXT_SUFFIXES:
                warnings.append(f"Skipped unsupported RAG file suffix: {project_relative_path(candidate)}")
                continue
            key = str(candidate.resolve()).lower()
            if key in seen:
                continue
            seen.add(key)
            files.append(candidate.resolve())
            if len(files) >= max_files:
                warnings.append(f"RAG index stopped at maxFiles={max_files}.")
                return files
    return files


def resolve_local_rag_source(value: Any) -> Path:
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("sourcePaths cannot contain empty values")
    path = Path(raw)
    if not path.is_absolute():
        path = (PROJECT_ROOT / path).resolve()
    else:
        path = path.resolve()
    try:
        path.relative_to(PROJECT_ROOT)
    except ValueError as exc:
        raise ValueError(f"RAG source must be inside the repository: {path}") from exc
    if not path.exists():
        raise FileNotFoundError(f"RAG source not found: {path}")
    return path


def should_skip_rag_path(path: Path) -> bool:
    parts = {part.lower() for part in path.parts}
    return bool(parts & RAG_EXCLUDED_DIRS)


def normalize_rag_text(text: str) -> str:
    text = re.sub(r"<script\b[^>]*>.*?</script>", " ", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<style\b[^>]*>.*?</style>", " ", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<[^>]+>", " ", text)
    text = text.replace("\x00", " ")
    return re.sub(r"\s+", " ", text).strip()


def chunk_text(text: str) -> list[dict[str, Any]]:
    if len(text) <= RAG_CHUNK_CHARS:
        return [{"start": 0, "end": len(text), "text": text}]
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + RAG_CHUNK_CHARS, len(text))
        if end < len(text):
            boundary = max(text.rfind("。", start, end), text.rfind(".", start, end), text.rfind("\n", start, end))
            if boundary > start + (RAG_CHUNK_CHARS // 2):
                end = boundary + 1
        chunks.append({"start": start, "end": end, "text": text[start:end].strip()})
        if end >= len(text):
            break
        start = max(0, end - RAG_CHUNK_OVERLAP)
    return [chunk for chunk in chunks if chunk["text"]]


def tokenize_for_search(text: str) -> list[str]:
    text = text.lower()
    latin_tokens = re.findall(r"[a-z0-9_]{2,}", text)
    cjk_tokens = re.findall(r"[\u4e00-\u9fff]{2,}", text)
    cjk_terms: list[str] = []
    for token in cjk_tokens:
        if len(token) <= 6:
            cjk_terms.append(token)
        else:
            cjk_terms.extend(token[index : index + 2] for index in range(0, len(token) - 1))
    return latin_tokens + cjk_terms


def score_rag_chunk(query_counter: Counter[str], chunk_tokens: list[str], chunk_text: str, query_text: str) -> float:
    chunk_counter = Counter(str(token) for token in chunk_tokens)
    score = 0.0
    for token, query_weight in query_counter.items():
        if token in chunk_counter:
            score += (1.0 + min(chunk_counter[token], 5) * 0.2) * query_weight
    if query_text and query_text in chunk_text.lower():
        score += 3.0
    return score


def rag_document_id(collection_name: str, path: Path) -> str:
    return hashlib.sha256(f"{collection_name}:{project_relative_path(path)}".encode("utf-8")).hexdigest()[:24]


def agent_event_from_row(row: sqlite3.Row) -> dict[str, Any]:
    event = {
        "id": int(row["id"]),
        "eventType": str(row["event_type"]),
        "subjectType": str(row["subject_type"]),
        "subjectId": str(row["subject_id"]),
        "payload": json.loads(row["payload_json"]),
        "createdAt": str(row["created_at"]),
    }
    event["eventHash"] = event_hash(event)
    return event


def event_hash(event: dict[str, Any]) -> str:
    body = {key: value for key, value in event.items() if key != "eventHash"}
    return sha256_json(body)


def normalize_exported_event(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Each replay event must be an object")

    event_id = safe_int(value.get("id"), None)
    if event_id is None:
        raise ValueError("Each replay event requires numeric id")
    event_type = str(value.get("eventType") or value.get("event_type") or "").strip()
    subject_type = str(value.get("subjectType") or value.get("subject_type") or "").strip()
    subject_id = str(value.get("subjectId") or value.get("subject_id") or "").strip()
    created_at = str(value.get("createdAt") or value.get("created_at") or "").strip()
    if not event_type or not subject_type or not subject_id:
        raise ValueError("Each replay event requires eventType, subjectType and subjectId")

    payload = value.get("payload")
    if payload is None and "payload_json" in value:
        payload = json.loads(str(value["payload_json"]))
    if payload is None:
        payload = {}
    if not isinstance(payload, dict):
        payload = {"value": payload}

    event = {
        "id": event_id,
        "eventType": event_type,
        "subjectType": subject_type,
        "subjectId": subject_id,
        "payload": payload,
        "createdAt": created_at,
    }
    expected_hash = value.get("eventHash")
    if expected_hash:
        actual_hash = event_hash(event)
        if str(expected_hash) != actual_hash:
            event["hashMismatch"] = {"expected": str(expected_hash), "actual": actual_hash}
        else:
            event["eventHash"] = actual_hash
    else:
        event["eventHash"] = event_hash(event)
    return event


def validate_event_sequence(events: list[dict[str, Any]]) -> list[str]:
    warnings = []
    previous_id: int | None = None
    seen_ids: set[int] = set()
    for event in events:
        event_id = int(event["id"])
        if event_id in seen_ids:
            warnings.append(f"Duplicate event id in replay input: {event_id}")
        seen_ids.add(event_id)
        if previous_id is not None and event_id <= previous_id:
            warnings.append("Events are not strictly ordered by id; replay kept input order.")
            break
        previous_id = event_id
        if event.get("hashMismatch"):
            warnings.append(f"Event hash mismatch for event {event_id}.")
    return warnings


def verify_events_against_state(events: list[dict[str, Any]]) -> dict[str, Any]:
    checked = 0
    missing: list[int] = []
    mismatched: list[dict[str, Any]] = []
    with connect_state_db() as conn:
        init_state_db(conn)
        for event in events:
            row = conn.execute(
                """
                SELECT id, event_type, subject_type, subject_id, payload_json, created_at
                FROM agent_events
                WHERE id = ?
                """,
                (event["id"],),
            ).fetchone()
            if row is None:
                missing.append(int(event["id"]))
                continue
            checked += 1
            stored = agent_event_from_row(row)
            if stored["eventHash"] != event["eventHash"]:
                mismatched.append(
                    {
                        "id": int(event["id"]),
                        "expectedHash": event["eventHash"],
                        "storedHash": stored["eventHash"],
                    }
                )
    return {
        "checked": checked,
        "missingEventIds": missing,
        "mismatchedEvents": mismatched,
        "ok": not missing and not mismatched,
    }


def build_state_snapshot(conn: sqlite3.Connection) -> dict[str, Any]:
    counts = {}
    for table_name in (
        "training_plans",
        "plan_approvals",
        "training_runs",
        "agent_events",
        "rag_documents",
        "rag_chunks",
    ):
        row = conn.execute(f"SELECT COUNT(*) AS count FROM {table_name}").fetchone()
        counts[table_name] = int(row["count"])

    latest_training_runs = [
        {
            "trainingRunId": row["training_run_id"],
            "planId": row["plan_id"],
            "status": row["status"],
            "progress": row["progress"],
            "currentStep": row["current_step"],
            "updatedAt": row["updated_at"],
        }
        for row in conn.execute(
            """
            SELECT training_run_id, plan_id, status, progress, current_step, updated_at
            FROM training_runs
            ORDER BY updated_at DESC
            LIMIT 20
            """
        ).fetchall()
    ]
    rag_collections = [
        {
            "collectionName": row["collection_name"],
            "documentCount": int(row["document_count"]),
            "chunkCount": int(row["chunk_count"]),
        }
        for row in conn.execute(
            """
            SELECT d.collection_name,
                   COUNT(DISTINCT d.document_id) AS document_count,
                   COUNT(c.chunk_id) AS chunk_count
            FROM rag_documents d
            LEFT JOIN rag_chunks c
              ON c.collection_name = d.collection_name
             AND c.document_id = d.document_id
            GROUP BY d.collection_name
            ORDER BY d.collection_name
            """
        ).fetchall()
    ]
    return {
        "counts": counts,
        "latestTrainingRuns": latest_training_runs,
        "ragCollections": rag_collections,
    }


def result_search_roots(payload: dict[str, Any]) -> tuple[list[Path], dict[str, Any], list[str]]:
    filters = {
        "datasetId": normalize_optional_string(payload.get("datasetId")),
        "userId": normalize_optional_string(payload.get("userId")),
        "modelId": normalize_optional_string(payload.get("modelId")),
        "trainingRunId": normalize_optional_string(payload.get("trainingRunId")),
    }
    warnings: list[str] = []
    roots: list[Path] = []

    result_root = normalize_optional_string(payload.get("resultRoot"))
    if result_root:
        roots.append(resolve_local_result_path(result_root))

    training_run_id = filters["trainingRunId"]
    if training_run_id:
        run_roots, run_filters = roots_from_training_run(training_run_id)
        roots.extend(run_roots)
        for key, value in run_filters.items():
            if value and not filters.get(key):
                filters[key] = value
        if not run_roots:
            warnings.append(f"No local training run metadata found for trainingRunId '{training_run_id}'.")

    if not roots:
        roots.extend([PROJECT_ROOT / "result", PROJECT_ROOT / "worker_runs"])

    existing_roots = []
    seen: set[str] = set()
    for root in roots:
        resolved = root.resolve()
        key = str(resolved).lower()
        if key in seen:
            continue
        seen.add(key)
        existing_roots.append(resolved)

    return existing_roots, filters, warnings


def roots_from_training_run(training_run_id: str) -> tuple[list[Path], dict[str, Any]]:
    roots: list[Path] = []
    filters: dict[str, Any] = {}
    if not STATE_DB_PATH.exists():
        return roots, filters
    try:
        with connect_state_db() as conn:
            init_state_db(conn)
            row = conn.execute(
                """
                SELECT command_json, artifact_json, log_path
                FROM training_runs
                WHERE training_run_id = ?
                """,
                (training_run_id,),
            ).fetchone()
            if row is None:
                return roots, filters
            artifact_json = json.loads(row["artifact_json"] or "[]")
            for artifact in artifact_json:
                path = artifact.get("path") if isinstance(artifact, dict) else None
                if path:
                    roots.append((PROJECT_ROOT / str(path)).resolve())
            plan = extract_plan_hints_from_commands(json.loads(row["command_json"] or "[]"))
            filters.update(plan)
            if row["log_path"]:
                roots.append(Path(row["log_path"]).resolve().parent)
    except (sqlite3.Error, json.JSONDecodeError, OSError):
        return roots, filters
    return roots, filters


def extract_plan_hints_from_commands(commands: list[dict[str, Any]]) -> dict[str, str]:
    hints: dict[str, str] = {}
    for command in commands:
        argv = command.get("argv") if isinstance(command, dict) else None
        if not isinstance(argv, list):
            continue
        parsed = argv_option_map([str(value) for value in argv])
        if parsed.get("--dataset") and not hints.get("datasetId"):
            hints["datasetId"] = parsed["--dataset"]
        if parsed.get("--user_id") and not hints.get("userId"):
            hints["userId"] = parsed["--user_id"]
        if parsed.get("--models") and not hints.get("modelId"):
            hints["modelId"] = parsed["--models"]
        if parsed.get("--model") and not hints.get("modelId"):
            hints["modelId"] = prepare_model_name_reverse(parsed["--model"])
    return hints


def argv_option_map(argv: list[str]) -> dict[str, str]:
    parsed: dict[str, str] = {}
    index = 0
    while index < len(argv) - 1:
        key = argv[index]
        value = argv[index + 1]
        if key.startswith("--") and not value.startswith("--"):
            parsed[key] = value
            index += 2
        else:
            index += 1
    return parsed


def prepare_model_name_reverse(model_id: str) -> str:
    if model_id == "baseline":
        return ""
    return model_id


def result_file_matches(path: Path, filters: dict[str, Any]) -> bool:
    parts = {part.lower() for part in path.parts}
    text_path = str(path).lower()
    for key in ("datasetId", "userId", "modelId", "trainingRunId"):
        value = normalize_optional_string(filters.get(key))
        if not value:
            continue
        needle = value.lower()
        if key == "trainingRunId":
            if needle not in text_path:
                return False
            continue
        if needle not in parts and needle not in text_path:
            return False
    return True


def result_artifact(path: Path, include_preview: bool = False) -> dict[str, Any]:
    suffix = path.suffix.lower()
    stat = path.stat()
    artifact = {
        "id": artifact_id(path),
        "name": path.name,
        "suffix": suffix,
        "kind": classify_result_artifact(path),
        "path": str(path),
        "relativePath": project_relative_path(path),
        "sizeBytes": stat.st_size,
        "modifiedAt": datetime.utcfromtimestamp(stat.st_mtime).replace(microsecond=0).isoformat() + "Z",
    }
    if include_preview:
        artifact["preview"] = preview_result_artifact(path)
    return artifact


def classify_result_artifact(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in RESULT_IMAGE_SUFFIXES:
        return "image"
    if suffix in RESULT_TABLE_SUFFIXES:
        return "table"
    if suffix == ".json":
        return "json"
    if suffix in {".html", ".htm"}:
        return "html"
    if suffix in {".txt", ".md", ".log", ".jsonl"}:
        return "text"
    if suffix in {".npy", ".npz", ".pt", ".pkl"}:
        return "model_artifact"
    return "other"


def preview_result_artifact(path: Path) -> dict[str, Any]:
    suffix = path.suffix.lower()
    try:
        if suffix in RESULT_TABLE_SUFFIXES:
            text, encoding = read_text_with_encoding(path)
            delimiter = sniff_delimiter(text, suffix)
            reader = csv.DictReader(text.splitlines(), delimiter=delimiter)
            rows = []
            total = 0
            for row in reader:
                total += 1
                if len(rows) < 8:
                    rows.append({str(key): value for key, value in row.items() if key is not None})
            return {
                "encoding": encoding,
                "delimiter": delimiter,
                "columns": reader.fieldnames or [],
                "sampleRows": rows,
                "sampleRowCount": len(rows),
                "estimatedRowsInPreviewScan": total,
            }
        if suffix == ".json":
            value = json.loads(read_text_with_encoding(path)[0])
            return preview_json_value(value)
        if suffix in {".jsonl", ".txt", ".md", ".log"}:
            text, encoding = read_text_with_encoding(path)
            return {
                "encoding": encoding,
                "text": text[:2000],
                "truncated": len(text) > 2000,
            }
        if suffix in RESULT_IMAGE_SUFFIXES:
            return {"summary": "Image artifact; binary preview is represented by path metadata."}
        if suffix in {".html", ".htm"}:
            return {"summary": "HTML visualization artifact; open in a browser-capable renderer."}
    except Exception as exc:
        return {
            "error": {
                "type": exc.__class__.__name__,
                "message": str(exc),
            }
        }
    return {"summary": "Binary artifact; no inline preview."}


def preview_json_value(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        sample = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= 12:
                break
            sample[str(key)] = compact_json_preview(item)
        return {
            "type": "object",
            "keys": list(value.keys())[:40],
            "sample": sample,
        }
    if isinstance(value, list):
        return {
            "type": "array",
            "length": len(value),
            "sample": [compact_json_preview(item) for item in value[:5]],
        }
    return {"type": type(value).__name__, "value": value}


def compact_json_preview(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): compact_json_preview(item) for key, item in list(value.items())[:8]}
    if isinstance(value, list):
        return [compact_json_preview(item) for item in value[:8]]
    if isinstance(value, str) and len(value) > 200:
        return value[:200] + "..."
    return value


def summarize_table_artifact(path: Path, preview: dict[str, Any]) -> dict[str, Any] | None:
    columns = [str(column) for column in preview.get("columns") or []]
    rows = preview.get("sampleRows") if isinstance(preview.get("sampleRows"), list) else []
    name_lower = path.name.lower()
    column_names = {column.lower() for column in columns}
    is_topic_table = (
        "topic" in name_lower
        or "主题" in path.name
        or bool(column_names & {"topic_id", "topic_name", "keywords", "terms"})
        or any(column in {"主题", "关键词"} for column in columns)
    )
    if not is_topic_table and rows:
        return {
            "artifactId": artifact_id(path),
            "name": path.name,
            "kind": "table",
            "columns": columns,
            "sampleRows": rows[:5],
            "rowCountInPreviewScan": preview.get("estimatedRowsInPreviewScan"),
        }
    if not is_topic_table:
        return None

    topics = []
    for row in rows[:10]:
        if not isinstance(row, dict):
            continue
        topics.append(
            {
                "topicId": first_present(row, ["topic_id", "id", "主题编号", "主题"]),
                "name": first_present(row, ["topic_name", "name", "主题名称"]),
                "strength": first_present(row, ["strength", "weight", "占比", "显著性"]),
                "keywords": first_present(row, ["keywords", "terms", "关键词"]),
            }
        )
    return {
        "artifactId": artifact_id(path),
        "name": path.name,
        "kind": "topic_table",
        "relativePath": project_relative_path(path),
        "columns": columns,
        "topicCountInPreviewScan": preview.get("estimatedRowsInPreviewScan"),
        "topics": topics,
    }


def summarize_json_artifact(path: Path, name_lower: str) -> dict[str, Any] | None:
    try:
        value = json.loads(read_text_with_encoding(path)[0])
    except Exception as exc:
        return {
            "artifactId": artifact_id(path),
            "name": path.name,
            "error": {"type": exc.__class__.__name__, "message": str(exc)},
        }

    if "topic_words" in name_lower and isinstance(value, dict):
        topics = []
        for index, (topic_id, words) in enumerate(value.items()):
            if index >= 20:
                break
            topics.append({"topicId": topic_id, "keywords": words[:20] if isinstance(words, list) else words})
        return {
            "artifactId": artifact_id(path),
            "name": path.name,
            "kind": "topic_words",
            "topicCount": len(value),
            "topics": topics,
        }
    if isinstance(value, dict):
        numeric_items = {
            str(key): item
            for key, item in value.items()
            if isinstance(item, (int, float)) or (isinstance(item, list) and all(isinstance(v, (int, float)) for v in item[:20]))
        }
        return {
            "artifactId": artifact_id(path),
            "name": path.name,
            "kind": "json",
            "keys": list(value.keys())[:40],
            "numericValues": compact_json_preview(numeric_items),
            "sample": compact_json_preview(value),
        }
    return {
        "artifactId": artifact_id(path),
        "name": path.name,
        "kind": "json",
        "preview": compact_json_preview(value),
    }


def first_present(row: dict[str, Any], keys: list[str]) -> Any:
    lower_map = {str(key).lower(): value for key, value in row.items()}
    for key in keys:
        if key in row and row[key] not in (None, ""):
            return row[key]
        lower = key.lower()
        if lower in lower_map and lower_map[lower] not in (None, ""):
            return lower_map[lower]
    return None


def artifact_id(path: Path) -> str:
    return hashlib.sha256(project_relative_path(path).encode("utf-8")).hexdigest()[:16]


def project_relative_path(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(PROJECT_ROOT)).replace("\\", "/")
    except ValueError:
        return str(path.resolve())


def resolve_local_result_path(value: str) -> Path:
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = PROJECT_ROOT / candidate
    resolved = candidate.resolve()
    try:
        resolved.relative_to(PROJECT_ROOT)
    except ValueError as exc:
        raise ValueError(f"resultRoot must stay under project root: {PROJECT_ROOT}") from exc
    return resolved


def normalize_optional_string(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    return text


def require_mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def required_mapping_text(value: dict[str, Any], key: str, label: str) -> str:
    resolved = str(value.get(key) or "").strip()
    if not resolved:
        raise ValueError(f"{label}.{key} is required")
    return resolved


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def legacy_plan_from_record(plan_record: dict[str, Any], dataset_path: Path) -> dict[str, Any]:
    canonical = require_mapping(plan_record.get("canonicalPlan"), "plan.canonicalPlan")
    model = require_mapping(canonical.get("model"), "plan.canonicalPlan.model")
    columns = require_mapping(canonical.get("columns"), "plan.canonicalPlan.columns")
    resources = require_mapping(canonical.get("resources"), "plan.canonicalPlan.resources")
    experiment_protocol = require_mapping(
        canonical.get("experimentProtocol") or {
            "mode": "quick",
            "primarySeeds": [42],
            "baselineModelId": None,
            "baselineSeeds": [],
            "rationale": "Legacy plan: one primary-model quick run.",
            "evidenceRefs": [],
            "confidence": "low",
        },
        "plan.canonicalPlan.experimentProtocol",
    )
    parameters = require_mapping(model.get("parameters") or {}, "plan.canonicalPlan.model.parameters")
    text_columns = columns.get("textColumns") or []
    if not isinstance(text_columns, list) or not text_columns:
        raise ValueError("plan.canonicalPlan.columns.textColumns must not be empty")
    validate_canonical_model_semantics(model, parameters)
    device = str(resources.get("device") or "unknown")
    plan_hash = normalize_optional_string(plan_record.get("planHash")) or sha256_json(canonical)
    return {
        "planId": normalize_optional_string(plan_record.get("planId")) or f"plan_{plan_hash[:16]}",
        "planHash": plan_hash,
        # Stable, filesystem-safe experiment identity. A canonical plan always
        # writes into its own result directory, so stale output cannot satisfy it.
        "experimentId": "approved_plan",
        "datasetId": required_mapping_text(canonical, "datasetId", "plan.canonicalPlan"),
        "modelId": required_mapping_text(model, "modelId", "plan.canonicalPlan.model"),
        "mode": required_mapping_text(model, "mode", "plan.canonicalPlan.model"),
        "topicCountMode": str(model.get("topicCountMode") or "fixed"),
        "numTopics": model.get("numTopics"),
        "maxTopics": model.get("maxTopics"),
        "textColumn": str(text_columns[0]),
        "timeColumn": columns.get("timeColumn"),
        "covariateColumns": columns.get("covariateColumns") or [],
        "metadataColumns": columns.get("metadataColumns") or [],
        "groupingColumns": columns.get("groupingColumns") or [],
        "evaluationLabelColumns": columns.get("evaluationLabelColumns") or [],
        "rawInput": str(dataset_path.resolve()),
        "gpu": 0 if device == "gpu" else -1,
        "experimentProtocol": experiment_protocol,
        **parameters,
    }


def validate_canonical_model_semantics(
    model: dict[str, Any],
    parameters: dict[str, Any],
) -> None:
    model_id = required_mapping_text(model, "modelId", "plan.canonicalPlan.model").lower()
    mode = required_mapping_text(model, "mode", "plan.canonicalPlan.model")
    if model_id == "theta":
        if mode not in {"zero_shot", "supervised", "unsupervised"}:
            raise ValueError(f"THETA mode is not supported: {mode}")
    elif mode != "unsupervised":
        raise ValueError(f"Model '{model_id}' only supports unsupervised mode")

    topic_mode = str(model.get("topicCountMode") or "fixed")
    num_topics = model.get("numTopics")
    max_topics = model.get("maxTopics")
    if model_id == "hdp":
        if topic_mode != "auto" or num_topics is not None:
            raise ValueError("HDP requires topicCountMode=auto and numTopics=null")
        if not isinstance(max_topics, int) or isinstance(max_topics, bool) or not 2 <= max_topics <= 1000:
            raise ValueError("HDP maxTopics must be an integer between 2 and 1000")
    elif model_id == "bertopic":
        if topic_mode not in {"auto", "target_reduction"}:
            raise ValueError("BERTopic requires auto or target_reduction topic mode")
        if topic_mode == "auto" and num_topics is not None:
            raise ValueError("BERTopic auto mode requires numTopics=null")
        if topic_mode == "target_reduction" and (
            not isinstance(num_topics, int)
            or isinstance(num_topics, bool)
            or not 2 <= num_topics <= 200
        ):
            raise ValueError("BERTopic target_reduction requires numTopics between 2 and 200")
    else:
        if topic_mode != "fixed":
            raise ValueError(f"Model '{model_id}' requires topicCountMode=fixed")
        if (
            not isinstance(num_topics, int)
            or isinstance(num_topics, bool)
            or not 2 <= num_topics <= 200
        ):
            raise ValueError("Fixed topic mode requires numTopics between 2 and 200")

    allowed_parameters = {
        "lda": set(),
        "btm": {"epochs"},
        "hdp": set(),
        "dtm": {"epochs", "batchSize"},
        "stm": set(),
        "bertopic": {
            "nNeighbors",
            "nComponents",
            "minClusterSize",
            "minSamples",
            "topNWords",
            "randomState",
        },
        "theta": {"modelSize", "epochs", "batchSize"},
    }
    allowed = allowed_parameters.get(model_id)
    if allowed is None:
        raise ValueError(f"Model '{model_id}' has no Validator V2 capability contract")
    unsupported = sorted(set(parameters) - allowed)
    if unsupported:
        raise ValueError(
            f"Parameters are not supported for model '{model_id}': {', '.join(unsupported)}"
        )
    integer_ranges = {
        "epochs": (1, None),
        "batchSize": (1, None),
        "nNeighbors": (2, 100),
        "nComponents": (2, 50),
        "minClusterSize": (2, 100),
        "minSamples": (1, None),
        "topNWords": (1, 30),
        "randomState": (None, None),
    }
    for name, value in parameters.items():
        if name == "modelSize":
            if value not in {"0.6B", "4B", "8B"}:
                raise ValueError("modelSize must be one of 0.6B, 4B, 8B")
            continue
        if name not in integer_ranges:
            continue
        if name == "minSamples" and value is None:
            continue
        if not isinstance(value, int) or isinstance(value, bool):
            raise ValueError(f"Parameter '{name}' must be an integer")
        minimum, maximum = integer_ranges[name]
        if minimum is not None and value < minimum:
            raise ValueError(f"Parameter '{name}' must be at least {minimum}")
        if maximum is not None and value > maximum:
            raise ValueError(f"Parameter '{name}' must be at most {maximum}")


def training_preflight_checks(
    plan_record: dict[str, Any],
    plan: dict[str, Any],
    dataset_path: Path,
) -> list[dict[str, str]]:
    canonical = require_mapping(plan_record.get("canonicalPlan"), "plan.canonicalPlan")
    resources = require_mapping(canonical.get("resources"), "plan.canonicalPlan.resources")
    model_id = str(plan.get("modelId") or "").lower()
    expected_sha = required_mapping_text(canonical, "datasetSha256", "plan.canonicalPlan")
    actual_sha = sha256_file(dataset_path)
    catalog = model_catalog({})
    runnable = {
        str(item.get("id") or "").lower(): bool(item.get("runnable"))
        for item in catalog.get("models", [])
        if isinstance(item, dict)
    }
    model_scripts_ready = MODEL_CONFIG_PATH.is_file() and RUN_PIPELINE_PATH.is_file()
    command_root = THETA_ROOT / "src" / "models"
    command_root_writable = command_root.is_dir() and os.access(command_root, os.W_OK)
    free_bytes = shutil.disk_usage(PROJECT_ROOT).free
    gpu_requested = resources.get("device") == "gpu"
    required_python_modules = ("pandas", "numpy", "sklearn", "docx")
    missing_python_modules = [
        name
        for name in required_python_modules
        if importlib.util.find_spec(name) is None
    ]
    model_python_modules = {
        "hdp": ("gensim",),
        "bertopic": ("bertopic", "sentence_transformers", "umap", "hdbscan"),
    }
    missing_model_modules = [
        name
        for name in model_python_modules.get(model_id, ())
        if importlib.util.find_spec(name) is None
    ]
    offline_assets_ready = True
    offline_assets_detail = "No model-specific offline asset check is required."
    if model_id == "bertopic" and not resources.get("networkAllowed"):
        configured_sbert = str(os.environ.get("SBERT_MODEL_PATH") or "").strip()
        sbert_path = Path(configured_sbert) if configured_sbert else None
        offline_assets_ready = bool(sbert_path and sbert_path.exists())
        offline_assets_detail = (
            f"BERTopic will use local SBERT assets at {sbert_path.resolve()}."
            if offline_assets_ready and sbert_path is not None
            else "Offline BERTopic requires SBERT_MODEL_PATH to point to an existing local model directory."
        )
    torch_available = importlib.util.find_spec("torch") is not None
    gpu_available = False
    if gpu_requested and torch_available:
        try:
            import torch

            gpu_available = bool(torch.cuda.is_available())
        except Exception:
            gpu_available = False
    model_data_checks = training_dataset_semantic_checks(plan, dataset_path)
    return [
        {
            "code": "DATASET_EXISTS",
            "status": "pass",
            "detail": "Dataset exists and passed the configured path policy.",
        },
        {
            "code": "DATASET_HASH_MATCH",
            "status": "pass" if actual_sha == expected_sha else "fail",
            "detail": "Dataset SHA-256 matches the canonical plan."
            if actual_sha == expected_sha
            else "Dataset SHA-256 changed after plan creation.",
        },
        {
            "code": "PYTHON_RUNTIME",
            "status": "pass"
            if Path(PYTHON_BIN).exists() and not missing_python_modules
            else "fail",
            "detail": (
                f"Training will use {Path(PYTHON_BIN).resolve()} "
                f"(Python {platform.python_version()}, environment="
                f"{os.environ.get('VIRTUAL_ENV') or sys.prefix})."
                if not missing_python_modules
                else "Training Python is missing modules: "
                + ", ".join(missing_python_modules)
            ),
        },
        {
            "code": "MODEL_DEPENDENCIES",
            "status": "pass"
            if model_scripts_ready and runnable.get(model_id, False) and not missing_model_modules
            else "fail",
            "detail": (
                "Model is runnable and its Python dependencies are available."
                if model_scripts_ready and runnable.get(model_id, False) and not missing_model_modules
                else "Model is unavailable, scripts are missing, or Python modules are absent: "
                + ", ".join(missing_model_modules)
            ),
        },
        {
            "code": "COMMAND_WORKDIR_WRITABLE",
            "status": "pass" if command_root_writable else "fail",
            "detail": "Training working directory is writable."
            if command_root_writable
            else "Training working directory is not writable.",
        },
        {
            "code": "DISK_SPACE",
            "status": "pass" if free_bytes >= 1024 * 1024 * 1024 else "warn",
            "detail": "At least 1 GiB of free disk space is available."
            if free_bytes >= 1024 * 1024 * 1024
            else "Less than 1 GiB of free disk space is available.",
        },
        {
            "code": "GPU_AVAILABILITY",
            "status": "pass" if not gpu_requested or gpu_available else "fail",
            "detail": "GPU requirement is satisfied."
            if not gpu_requested or gpu_available
            else "The canonical plan requires a GPU, but CUDA is unavailable.",
        },
        {
            "code": "NETWORK_POLICY",
            "status": "warn" if resources.get("networkAllowed") else "pass",
            "detail": "Network downloads are allowed and require operator awareness."
            if resources.get("networkAllowed")
            else "Network access is disabled by the canonical plan.",
        },
        {
            "code": "OFFLINE_MODEL_ASSETS",
            "status": "pass" if offline_assets_ready else "fail",
            "detail": offline_assets_detail,
        },
        *model_data_checks,
    ]


def training_dataset_semantic_checks(
    plan: dict[str, Any],
    dataset_path: Path,
) -> list[dict[str, str]]:
    model_id = str(plan.get("modelId") or "").lower()
    text_column = str(plan.get("textColumn") or "").strip()
    time_column = str(plan.get("timeColumn") or "").strip()
    covariate_columns = [
        str(value).strip()
        for value in plan.get("covariateColumns") or []
        if str(value).strip()
    ]
    try:
        table = load_table({"filePath": str(dataset_path), "sampleSize": 500})
    except Exception as exc:
        return [
            {
                "code": "DATASET_SEMANTIC_READ",
                "status": "fail",
                "detail": f"Could not inspect dataset semantics: {exc}",
            }
        ]

    checks: list[dict[str, str]] = []
    if not text_column or text_column not in table.columns:
        checks.append(
            {
                "code": "TEXT_COLUMN_DATA",
                "status": "fail",
                "detail": f"Bound text column '{text_column}' is absent from the dataset.",
            }
        )
        return checks

    texts = [
        str(row.get(text_column) or "").strip()
        for row in table.rows
    ]
    token_counts = [
        len(re.findall(r"[\u3400-\u9fff]|[A-Za-z0-9_]+", text))
        for text in texts
    ]
    nonempty_documents = sum(count > 0 for count in token_counts)
    checks.append(
        {
            "code": "NONEMPTY_VOCABULARY_PROXY",
            "status": "pass" if nonempty_documents > 0 else "fail",
            "detail": (
                f"{nonempty_documents} of {len(texts)} sampled documents contain lexical tokens."
                if nonempty_documents > 0
                else "No lexical tokens remain in the sampled text column."
            ),
        }
    )

    if model_id == "btm":
        biterm_documents = sum(count >= 2 for count in token_counts)
        checks.append(
            {
                "code": "BTM_BITERM_SUPPORT",
                "status": "pass" if biterm_documents > 0 else "fail",
                "detail": (
                    f"{biterm_documents} sampled documents can form at least one biterm."
                    if biterm_documents > 0
                    else "No sampled document contains at least two lexical tokens; BTM cannot form biterms."
                ),
            }
        )

    if model_id == "dtm":
        if not time_column or time_column not in table.columns:
            checks.append(
                {
                    "code": "DTM_TIME_SLICES",
                    "status": "fail",
                    "detail": f"Bound time column '{time_column}' is absent from the dataset.",
                }
            )
        else:
            time_values = {
                str(row.get(time_column) or "").strip()
                for row in table.rows
                if str(row.get(time_column) or "").strip()
            }
            checks.append(
                {
                    "code": "DTM_TIME_SLICES",
                    "status": "pass" if len(time_values) >= 2 else "fail",
                    "detail": (
                        f"Sampled data contains {len(time_values)} distinct non-empty time values."
                        if len(time_values) >= 2
                        else "DTM requires at least two distinct non-empty time values."
                    ),
                }
            )

    if model_id == "stm":
        missing_columns = [
            column for column in covariate_columns if column not in table.columns
        ]
        if not covariate_columns or missing_columns:
            checks.append(
                {
                    "code": "STM_METADATA_ALIGNMENT",
                    "status": "fail",
                    "detail": (
                        "STM has no explicitly bound training covariate columns."
                        if not covariate_columns
                        else "STM covariate columns are absent: " + ", ".join(missing_columns)
                    ),
                }
            )
        else:
            populated = sum(
                any(str(row.get(column) or "").strip() for column in covariate_columns)
                for row in table.rows
            )
            checks.append(
                {
                    "code": "STM_METADATA_ALIGNMENT",
                    "status": "pass" if populated > 0 else "fail",
                    "detail": (
                        f"{populated} of {len(table.rows)} sampled rows contain bound metadata."
                        if populated > 0
                        else "All bound STM metadata values are empty in the sample."
                    ),
                }
            )
            if table.rows and populated / len(table.rows) < 0.5:
                checks.append(
                    {
                        "code": "SEVERE_METADATA_SPARSITY",
                        "status": "warn",
                        "detail": "Fewer than half of sampled rows contain bound STM metadata.",
                    }
                )

    return checks


def build_training_commands(plan: dict[str, Any]) -> list[dict[str, Any]]:
    dataset_id = str(plan.get("datasetId"))
    model_id = str(plan.get("modelId")).lower()
    model_size = str(plan.get("modelSize") or "0.6B")
    mode = str(plan.get("mode") or "zero_shot")
    topic_count_mode = str(plan.get("topicCountMode") or "fixed")
    num_topics_value = plan.get("numTopics")
    num_topics = str(num_topics_value if num_topics_value is not None else 20)
    max_topics = str(plan.get("maxTopics") or 150)
    batch_size = str(plan.get("batchSize") or 64)
    epochs = str(plan.get("epochs") or 20)
    user_id = str(plan.get("userId") or "local_user")
    vocab_size = str(plan.get("vocabSize") or 5000)
    gpu = str(plan.get("gpu", -1))
    prepare_model = prepare_model_name(model_id)
    experiment_id = str(plan.get("experimentId") or "approved_plan")

    prepare_cmd = [
        "python",
        "prepare_data.py",
        "--dataset",
        dataset_id,
        "--model",
        prepare_model,
        "--model_size",
        model_size,
        "--mode",
        mode,
        "--vocab_size",
        vocab_size,
        "--batch_size",
        batch_size,
        "--gpu",
        gpu,
        "--user_id",
        user_id,
        "--force",
    ]

    raw_input = plan.get("rawInput")
    if raw_input:
        prepare_cmd.extend(["--clean", "--raw-input", str(raw_input)])

    if model_id in {"lda", "hdp", "stm", "btm"}:
        prepare_cmd.append("--bow-only")

    # Column bindings are analysis inputs, not merely model switches.  Preserve
    # them for every baseline so post-hoc temporal/group visualizations can use
    # the same approved document ordering even when the fitted model is static.
    time_column = plan.get("timeColumn")
    if time_column:
        prepare_cmd.extend(["--with-time", "--time_column", str(time_column)])

    covariates = plan.get("covariateColumns") or []
    if covariates:
        prepare_cmd.extend(["--covariate_columns", *[str(value) for value in covariates]])

    def experiment_command(
        target_model: str,
        seed: int,
        suffix: str,
    ) -> dict[str, Any]:
        target_mode = mode if target_model == "theta" else "unsupervised"
        argv = [
            "python",
            "run_pipeline.py",
            "--dataset",
            dataset_id,
            "--models",
            target_model,
            "--mode",
            target_mode,
            "--vocab_size",
            vocab_size,
            "--batch_size",
            batch_size,
            "--gpu",
            gpu,
            "--user_id",
            user_id,
            "--model_size",
            model_size,
            "--force",
            "--task_name",
            f"{experiment_id}__{suffix}",
        ]
        if target_model == "hdp":
            argv.extend(["--max_topics", max_topics])
        elif target_model == "bertopic" and topic_count_mode == "auto":
            argv.extend(["--num_topics", "0"])
        else:
            argv.extend(["--num_topics", num_topics])

        if target_model == "bertopic":
            bertopic_flags = {
                "nNeighbors": ("--n_neighbors", 15),
                "nComponents": ("--n_components", 5),
                "minClusterSize": ("--min_cluster_size", 10),
                "topNWords": ("--top_n_words", 10),
            }
            for plan_field, (flag, default) in bertopic_flags.items():
                argv.extend([flag, str(plan.get(plan_field, default))])
            if plan.get("minSamples") is not None:
                argv.extend(["--min_samples", str(plan["minSamples"])])
        if target_model == "btm":
            argv.extend(["--n_iter", epochs])
        elif target_model in {"theta", "dtm", "nvdm", "gsm", "prodlda", "ctm", "etm"}:
            argv.extend(["--epochs", epochs])
        argv.extend(["--random_state", str(seed)])
        return {
            "step": f"run_pipeline_{suffix}",
            "cwd": str(THETA_ROOT / "src" / "models"),
            "argv": argv,
            "sideEffect": "writes an isolated local model experiment",
        }

    protocol = normalized_experiment_protocol(plan)
    experiments: list[dict[str, Any]] = []
    baseline_model = protocol["baselineModelId"]
    if baseline_model:
        for seed in protocol["baselineSeeds"]:
            experiments.append(
                experiment_command(
                    baseline_model,
                    seed,
                    f"baseline_{baseline_model}_s{seed}",
                )
            )
    for seed in protocol["primarySeeds"]:
        experiments.append(experiment_command(model_id, seed, f"primary_{model_id}_s{seed}"))

    return [{
        "step": "prepare_data",
        "cwd": str(THETA_ROOT / "src" / "models"),
        "argv": prepare_cmd,
        "sideEffect": "writes local workspace matrices",
    }, *experiments]


def prepare_model_name(model_id: str) -> str:
    if model_id == "theta":
        return "theta"
    if model_id == "dtm":
        return "dtm"
    return "baseline"


def normalized_experiment_protocol(plan: dict[str, Any]) -> dict[str, Any]:
    raw = plan.get("experimentProtocol")
    if not isinstance(raw, dict) or not raw:
        return {
            "mode": "quick",
            "primarySeeds": [42],
            "baselineModelId": None,
            "baselineSeeds": [],
        }
    mode = str(raw.get("mode") or "").strip().lower()
    primary_seeds = raw.get("primarySeeds")
    baseline_seeds = raw.get("baselineSeeds")
    baseline_model = normalize_optional_string(raw.get("baselineModelId")) or None
    if mode not in {"quick", "comparative", "stability"}:
        raise ValueError(f"Unsupported experiment protocol mode: {mode}")
    if not isinstance(primary_seeds, list) or not primary_seeds:
        raise ValueError("experimentProtocol.primarySeeds must not be empty")
    if not isinstance(baseline_seeds, list):
        raise ValueError("experimentProtocol.baselineSeeds must be an array")
    for seed in [*primary_seeds, *baseline_seeds]:
        if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed <= 2_147_483_647:
            raise ValueError("experiment protocol seeds must be non-negative integers")
    if len(set(primary_seeds)) != len(primary_seeds) or len(set(baseline_seeds)) != len(baseline_seeds):
        raise ValueError("experiment protocol seeds must be unique within each run group")
    if mode == "quick" and (
        len(primary_seeds) != 1 or baseline_model is not None or baseline_seeds
    ):
        raise ValueError("quick experiment protocol must contain one primary run and no baseline")
    if mode == "comparative" and baseline_model is None:
        raise ValueError("comparative experiment protocol requires a baseline model")
    if mode == "stability" and len(primary_seeds) < 3:
        raise ValueError("stability experiment protocol requires at least three primary seeds")
    if baseline_model is None and baseline_seeds:
        raise ValueError("baseline seeds require a baseline model")
    if baseline_model is not None and not baseline_seeds:
        raise ValueError("baseline model requires at least one seed")
    if baseline_model == str(plan.get("modelId") or "").strip().lower():
        raise ValueError("baseline model must differ from the primary model")
    if len(primary_seeds) + len(baseline_seeds) > 6:
        raise ValueError("experiment protocol may run at most six experiments")
    return {
        "mode": mode,
        "primarySeeds": primary_seeds,
        "baselineModelId": baseline_model.lower() if baseline_model else None,
        "baselineSeeds": baseline_seeds,
    }


def expected_training_artifacts(plan: dict[str, Any]) -> list[dict[str, str]]:
    dataset_id = str(plan.get("datasetId"))
    model_id = str(plan.get("modelId")).lower()
    user_id = str(plan.get("userId") or "local_user")
    workspace_path = (
        f"third_party/THETA/result/baseline/{dataset_id}/data"
        if model_id == "dtm"
        else f"third_party/THETA/data/workspace/{dataset_id}/{user_id}"
    )
    experiment_id = str(plan.get("experimentId") or "approved_plan")
    artifacts = [{
        "kind": "workspace",
        "path": workspace_path,
        "description": "Prepared matrices, vocabulary, approved time slices, metadata dimensions and optional embeddings.",
    }]
    protocol = normalized_experiment_protocol(plan)
    baseline_model = protocol["baselineModelId"]
    if baseline_model:
        for seed in protocol["baselineSeeds"]:
            artifacts.append({
                "kind": "results_baseline",
                "path": f"third_party/THETA/result/{user_id}/{dataset_id}/{baseline_model}/{experiment_id}__baseline_{baseline_model}_s{seed}",
                "description": f"Plan-bound {baseline_model.upper()} comparison run (seed {seed}).",
            })
    for seed in protocol["primarySeeds"]:
        artifacts.append({
            "kind": "results",
            "path": f"third_party/THETA/result/{user_id}/{dataset_id}/{model_id}/{experiment_id}__primary_{model_id}_s{seed}",
            "description": f"Plan-bound primary-model run (seed {seed}).",
        })
    return artifacts


def bind_training_run_namespace(
    commands: list[dict[str, Any]],
    expected_artifacts: list[dict[str, Any]],
    training_run_id: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Replace the approved plan namespace with an attempt-specific namespace.

    This only changes the output namespace; all model/data arguments remain the
    ones reviewed in the dry run. Retries therefore cannot overwrite or inherit
    another attempt's result directory.
    """
    runtime_commands = json.loads(stable_json(commands))
    for command in runtime_commands:
        argv = command.get("argv")
        if not str(command.get("step") or "").startswith("run_pipeline_") or not isinstance(argv, list):
            continue
        if "--task_name" not in argv:
            raise ValueError("run_pipeline command must bind --task_name")
        index = argv.index("--task_name") + 1
        if index >= len(argv):
            raise ValueError("run_pipeline --task_name is missing its value")
        current = str(argv[index])
        suffix = current.split("__", 1)[1] if "__" in current else "primary"
        argv[index] = f"{training_run_id}__{suffix}"

    runtime_artifacts = json.loads(stable_json(expected_artifacts))
    for artifact in runtime_artifacts:
        if str(artifact.get("kind") or "").startswith("results"):
            current_path = Path(str(artifact["path"]))
            suffix = current_path.name.split("__", 1)[1] if "__" in current_path.name else "primary"
            artifact["path"] = str(current_path.parent / f"{training_run_id}__{suffix}")
            artifact["description"] = (
                "Exact training-run-bound model metrics, topic words, visualizations and exports."
            )
    return runtime_commands, runtime_artifacts


def bind_result_artifacts(expected_artifacts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    bound: list[dict[str, Any]] = []
    for expected in expected_artifacts:
        raw_path = Path(str(expected.get("path") or ""))
        artifact_path = raw_path if raw_path.is_absolute() else PROJECT_ROOT / raw_path
        artifact_path = artifact_path.resolve()
        exists = artifact_path.exists()
        if artifact_path.is_file():
            file_type = "file"
            size_bytes: int | None = artifact_path.stat().st_size
            content_hash: str | None = sha256_file(artifact_path)
        elif artifact_path.is_dir():
            file_type = "directory"
            files = sorted(path for path in artifact_path.rglob("*") if path.is_file())
            size_bytes = sum(path.stat().st_size for path in files)
            tree_digest = hashlib.sha256()
            for path in files:
                relative = path.relative_to(artifact_path).as_posix()
                tree_digest.update(relative.encode("utf-8"))
                tree_digest.update(b"\0")
                tree_digest.update(sha256_file(path).encode("ascii"))
                tree_digest.update(b"\n")
            content_hash = tree_digest.hexdigest()
        else:
            file_type = "missing"
            size_bytes = None
            content_hash = None
        bound.append(
            {
                "kind": str(expected.get("kind") or "artifact"),
                "path": str(artifact_path),
                "description": str(expected.get("description") or ""),
                "exists": exists,
                "fileType": file_type,
                "sizeBytes": size_bytes,
                "sha256": content_hash,
            }
        )
    return bound


def assess_result_quality(
    result_artifacts: list[dict[str, Any]],
    model_id: str = "unknown",
) -> dict[str, Any]:
    """Run shared gates plus model-specific diagnostics on bound output."""
    model_id = str(model_id or "unknown").strip().lower()
    profile = {
        "lda": {"unique_fail": 0.4, "unique_warn": 0.6, "variation_fail": 1e-4, "variation_warn": 1e-3},
        "btm": {"unique_fail": 0.35, "unique_warn": 0.55, "variation_fail": 1e-4, "variation_warn": 1e-3},
        "hdp": {"unique_fail": 0.4, "unique_warn": 0.6, "variation_fail": 1e-5, "variation_warn": 5e-4},
        "dtm": {"unique_fail": 0.4, "unique_warn": 0.65, "variation_fail": 1e-4, "variation_warn": 1e-3},
        "stm": {"unique_fail": 0.4, "unique_warn": 0.6, "variation_fail": 1e-4, "variation_warn": 1e-3},
        "bertopic": {"unique_fail": 0.5, "unique_warn": 0.7, "variation_fail": 1e-5, "variation_warn": 5e-4},
        "theta": {"unique_fail": 0.5, "unique_warn": 0.7, "variation_fail": 1e-4, "variation_warn": 1e-3},
    }.get(model_id, {"unique_fail": 0.4, "unique_warn": 0.6, "variation_fail": 1e-4, "variation_warn": 1e-3})
    checks: list[dict[str, Any]] = []
    result_dirs = [
        Path(str(item["path"]))
        for item in result_artifacts
        if item.get("kind") == "results" and item.get("exists")
    ]
    workspace_dirs = [
        Path(str(item["path"]))
        for item in result_artifacts
        if item.get("kind") == "workspace" and item.get("exists")
    ]
    if not result_dirs:
        return {
            "status": "failed",
            "checks": [{
                "code": "RESULT_DIRECTORY_MISSING",
                "status": "fail",
                "detail": "The run-bound result directory is missing.",
            }],
            "assessedAt": utc_now_iso(),
            "modelId": model_id,
            "profileVersion": "2.1.0",
        }

    result_dir = result_dirs[0]
    topic_files = sorted(result_dir.rglob("topic_words*.json"))
    theta_files = sorted(result_dir.rglob("theta*.npy"))
    beta_files = sorted(result_dir.rglob("beta*.npy"))
    signatures: list[tuple[str, ...]] = []
    for topic_file in topic_files:
        try:
            payload = json.loads(topic_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        values = list(payload.values()) if isinstance(payload, dict) else payload
        if not isinstance(values, list):
            continue
        for words in values:
            if isinstance(words, list):
                signatures.append(tuple(str(word).strip().lower() for word in words[:10]))
    signature_source = "topic_words"
    if not signatures and beta_files and workspace_dirs:
        try:
            import numpy as np

            vocab_files = sorted(
                path
                for workspace_dir in workspace_dirs
                for path in workspace_dir.rglob("vocab.json")
            )
            if vocab_files:
                vocab_payload = json.loads(vocab_files[0].read_text(encoding="utf-8"))
                if isinstance(vocab_payload, list):
                    vocab = [str(item) for item in vocab_payload]
                elif isinstance(vocab_payload, dict):
                    candidate = vocab_payload.get("vocab")
                    if isinstance(candidate, list):
                        vocab = [str(item) for item in candidate]
                    else:
                        indexed = sorted(
                            (
                                (int(index), str(word))
                                for word, index in vocab_payload.items()
                                if isinstance(index, int) or str(index).isdigit()
                            ),
                            key=lambda item: item[0],
                        )
                        vocab = [word for _, word in indexed]
                else:
                    vocab = []
                beta = np.load(beta_files[0], allow_pickle=False)
                if beta.ndim == 3:
                    beta = beta[-1]
                if beta.ndim == 2 and vocab and beta.shape[1] <= len(vocab):
                    for row in beta:
                        top_indices = np.argsort(row)[::-1][:10]
                        signatures.append(
                            tuple(vocab[int(index)].strip().lower() for index in top_indices)
                        )
                    signature_source = "beta+vocab"
        except (ImportError, OSError, ValueError, json.JSONDecodeError):
            signatures = []
    checks.append({
        "code": "CORE_OUTPUTS_PRESENT",
        "status": "pass" if signatures and theta_files and beta_files else "fail",
        "detail": (
            f"topic signatures={len(signatures)} ({signature_source}), "
            f"theta files={len(theta_files)}, beta files={len(beta_files)}"
        ),
    })
    if signatures:
        unique_ratio = len(set(signatures)) / len(signatures)
        checks.append({
            "code": "TOPIC_DIVERSITY",
            "status": "fail" if unique_ratio < profile["unique_fail"] else ("warn" if unique_ratio < profile["unique_warn"] else "pass"),
            "detail": f"{len(set(signatures))}/{len(signatures)} unique top-word signatures ({unique_ratio:.3f}).",
            "value": unique_ratio,
        })
    else:
        checks.append({
            "code": "TOPIC_DIVERSITY",
            "status": "fail",
            "detail": "No readable topic-word signatures were found.",
        })

    try:
        import numpy as np

        numeric_ok = True
        variation_values: list[float] = []
        for array_path in [*theta_files, *beta_files]:
            array = np.load(array_path, allow_pickle=False)
            numeric_ok = numeric_ok and bool(np.isfinite(array).all())
            if array_path in theta_files and array.ndim == 2 and array.shape[0] > 1:
                variation_values.append(float(np.mean(np.std(array, axis=0))))
        checks.append({
            "code": "NUMERICAL_FINITE",
            "status": "pass" if numeric_ok else "fail",
            "detail": "All theta/beta arrays are finite." if numeric_ok else "NaN or infinite values found in theta/beta arrays.",
        })
        if variation_values:
            variation = min(variation_values)
            checks.append({
                "code": "DOCUMENT_TOPIC_VARIATION",
                "status": "fail" if variation < profile["variation_fail"] else ("warn" if variation < profile["variation_warn"] else "pass"),
                "detail": f"Mean document-topic standard deviation={variation:.6g}.",
                "value": variation,
            })

        # Model-specific gates are intentionally artifact-derived and never
        # substitute one metric for another.
        if model_id == "dtm":
            temporal_files = sorted(result_dir.rglob("beta_over_time*.npy"))
            if not temporal_files:
                checks.append({
                    "code": "DTM_TEMPORAL_OUTPUT_PRESENT",
                    "status": "fail",
                    "detail": "DTM did not produce beta_over_time.",
                })
            else:
                temporal_beta = np.load(temporal_files[0], allow_pickle=False)
                valid_shape = temporal_beta.ndim == 3 and temporal_beta.shape[0] >= 2
                checks.append({
                    "code": "DTM_TEMPORAL_OUTPUT_PRESENT",
                    "status": "pass" if valid_shape else "fail",
                    "detail": f"beta_over_time shape={tuple(temporal_beta.shape)}.",
                })
                if valid_shape and np.isfinite(temporal_beta).all():
                    delta = float(np.mean(np.abs(temporal_beta[1:] - temporal_beta[:-1])))
                    checks.append({
                        "code": "DTM_ADJACENT_SLICE_CHANGE",
                        "status": "warn" if delta < 1e-7 or delta > 0.05 else "pass",
                        "detail": f"Mean adjacent topic-word absolute change={delta:.6g}; extreme values require review.",
                        "value": delta,
                    })
        elif model_id == "stm":
            covariate_files = sorted(result_dir.rglob("covariate_info*.json"))
            checks.append({
                "code": "STM_COVARIATE_OUTPUT_PRESENT",
                "status": "pass" if covariate_files else "fail",
                "detail": f"covariate info files={len(covariate_files)}.",
            })
        elif model_id == "bertopic" and theta_files:
            theta = np.load(theta_files[0], allow_pickle=False)
            empty_ratio = float(np.mean(np.sum(theta, axis=1) <= 1e-8)) if theta.ndim == 2 else 1.0
            checks.append({
                "code": "BERTOPIC_UNASSIGNED_DOCUMENT_RATIO",
                "status": "fail" if empty_ratio > 0.5 else ("warn" if empty_ratio > 0.2 else "pass"),
                "detail": f"Documents without topic mass={empty_ratio:.3f}.",
                "value": empty_ratio,
            })
        elif model_id == "hdp" and theta_files:
            theta = np.load(theta_files[0], allow_pickle=False)
            effective_topics = int(np.sum(np.mean(theta, axis=0) >= 1e-4)) if theta.ndim == 2 else 0
            checks.append({
                "code": "HDP_EFFECTIVE_TOPIC_COUNT",
                "status": "fail" if effective_topics < 2 else "pass",
                "detail": f"Effective topics with mean mass >=1e-4: {effective_topics}.",
                "value": effective_topics,
            })
    except (ImportError, OSError, ValueError) as exc:
        checks.append({
            "code": "NUMERICAL_FINITE",
            "status": "warn",
            "detail": f"Numerical quality check could not run: {exc}",
        })

    seed_topic_sets: list[list[set[str]]] = []
    for seed_dir in result_dirs:
        seed_files = sorted(seed_dir.rglob("topic_words*.json"))
        if not seed_files:
            continue
        try:
            payload = json.loads(seed_files[0].read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        values = list(payload.values()) if isinstance(payload, dict) else payload
        if isinstance(values, list):
            seed_topic_sets.append([
                {str(word).strip().lower() for word in words[:10]}
                for words in values
                if isinstance(words, list)
            ])
    if len(seed_topic_sets) >= 2:
        similarities: list[float] = []
        reference = seed_topic_sets[0]
        for candidate in seed_topic_sets[1:]:
            for topic in reference:
                best = max(
                    (
                        len(topic & other) / max(1, len(topic | other))
                        for other in candidate
                    ),
                    default=0.0,
                )
                similarities.append(best)
        stability = sum(similarities) / len(similarities) if similarities else 0.0
        checks.append({
            "code": "MULTI_SEED_TOPIC_STABILITY",
            "status": "fail" if stability < 0.15 else ("warn" if stability < 0.3 else "pass"),
            "detail": f"Mean best-match top-word Jaccard across seeds={stability:.3f}.",
            "value": stability,
        })

    statuses = {str(check["status"]) for check in checks}
    status = "failed" if "fail" in statuses else ("warning" if "warn" in statuses else "passed")
    return {
        "status": status,
        "checks": checks,
        "assessedAt": utc_now_iso(),
        "modelId": model_id,
        "profileVersion": "2.1.0",
    }


TRAINING_RUN_SELECT_COLUMNS = """
    training_run_id, plan_id, plan_hash, approval_id,
    plan_review_approval_id, training_review_approval_id, dry_run_hash,
    idempotency_key, attempt, retry_of_training_run_id, retry_reason,
    status, progress, command_json, artifact_json, result_json, quality_json,
    cancellation_json, error_message, failure_json, quarantine_reason,
    pid, runner_pid, active_pid, current_step, log_path,
    python_executable, python_version, python_environment,
    started_at, finished_at, created_at, updated_at
"""


def select_training_run(
    conn: sqlite3.Connection,
    *,
    training_run_id: str = "",
    idempotency_key: str = "",
) -> sqlite3.Row | None:
    if training_run_id:
        return conn.execute(
            f"SELECT {TRAINING_RUN_SELECT_COLUMNS} FROM training_runs WHERE training_run_id = ?",
            (training_run_id,),
        ).fetchone()
    if idempotency_key:
        return conn.execute(
            f"SELECT {TRAINING_RUN_SELECT_COLUMNS} FROM training_runs WHERE idempotency_key = ?",
            (idempotency_key,),
        ).fetchone()
    raise ValueError("training_run_id or idempotency_key is required")


def assert_training_run_binding(
    row: sqlite3.Row,
    *,
    plan_id: str,
    plan_hash: str,
    plan_review_approval_id: str,
    training_review_approval_id: str,
    dry_run_hash: str,
) -> None:
    expected = {
        "plan_id": plan_id,
        "plan_hash": plan_hash,
        "plan_review_approval_id": plan_review_approval_id,
        "training_review_approval_id": training_review_approval_id,
        "dry_run_hash": dry_run_hash,
    }
    for column, value in expected.items():
        if str(row[column] or "") != value:
            raise ValueError(
                f"Idempotency key is already bound to a different {column}"
            )


def training_run_response(
    row: sqlite3.Row,
    process_started: bool,
    message: str,
) -> dict[str, Any]:
    commands = json.loads(row["command_json"])
    phase = training_phase_from_step(str(row["current_step"] or "queued"), commands)
    return {
        "schemaVersion": TRAINING_RUNTIME_SCHEMA_VERSION,
        "trainingRunId": row["training_run_id"],
        "attempt": int(row["attempt"] or 1),
        "retryOfTrainingRunId": row["retry_of_training_run_id"] or None,
        "idempotencyKey": row["idempotency_key"],
        "planId": row["plan_id"],
        "planHash": row["plan_hash"],
        "planReviewApprovalId": row["plan_review_approval_id"],
        "trainingReviewApprovalId": row["training_review_approval_id"],
        "dryRunHash": row["dry_run_hash"],
        "status": row["status"],
        "progress": row["progress"],
        "processStarted": process_started,
        "pid": int(row["pid"]) if row["pid"] else None,
        "runnerPid": int(row["runner_pid"]) if row["runner_pid"] else None,
        "activePid": int(row["active_pid"]) if row["active_pid"] else None,
        "currentStep": row["current_step"] or "unknown",
        "currentPhase": phase["currentPhase"],
        "phaseContext": phase["phaseContext"],
        "phaseUpdatedAt": row["updated_at"],
        "logPath": row["log_path"] or None,
        "pythonExecutable": row["python_executable"] or str(Path(PYTHON_BIN).resolve()),
        "pythonVersion": row["python_version"] or platform.python_version(),
        "pythonEnvironment": row["python_environment"] or None,
        "commands": commands,
        "analysisBindings": analysis_bindings_from_commands(commands),
        "expectedArtifacts": json.loads(row["artifact_json"]),
        "resultArtifacts": json.loads(row["result_json"] or "[]"),
        "executionStatus": row["status"],
        "quality": json.loads(row["quality_json"] or "{}"),
        "errorMessage": row["error_message"] or None,
        "failure": json.loads(row["failure_json"] or "null"),
        "quarantineReason": row["quarantine_reason"] or None,
        "cancellation": json.loads(row["cancellation_json"] or "null"),
        "startedAt": row["started_at"] or None,
        "finishedAt": row["finished_at"] or None,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "message": message,
    }


def persist_quality_reassessment(
    training_run_id: str,
    artifacts: list[dict[str, Any]],
    quality: dict[str, Any],
) -> dict[str, Any]:
    assessed_at = str(quality.get("assessedAt") or utc_now_iso())
    artifact_hashes = [
        {"path": str(item.get("path") or "unknown"), "sha256": item.get("sha256")}
        for item in artifacts
    ]
    artifact_set_hash = sha256_json(artifact_hashes)
    material = {
        "trainingRunId": training_run_id,
        "artifactSetHash": artifact_set_hash,
        "artifactHashes": artifact_hashes,
        "modelId": str(quality.get("modelId") or "unknown"),
        "profileVersion": str(quality.get("profileVersion") or "unknown"),
        "qualityStatus": str(quality.get("status") or "warning"),
        "checks": quality.get("checks") or [],
        "assessedAt": assessed_at,
    }
    receipt = {
        "receiptId": "quality_reassessment_" + sha256_json(material)[:20],
        **material,
    }
    with connect_state_db() as conn:
        init_state_db(conn)
        conn.execute(
            """
            INSERT INTO quality_reassessments
                (receipt_id, training_run_id, artifact_set_hash, receipt_json, assessed_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                receipt["receiptId"],
                training_run_id,
                artifact_set_hash,
                stable_json(receipt),
                assessed_at,
            ),
        )
        record_event(
            conn,
            "training.quality_reassessed",
            "training_run",
            training_run_id,
            receipt,
        )
    return receipt


def training_phase_from_step(step: str, commands: list[dict[str, Any]]) -> dict[str, Any]:
    normalized = step.removesuffix("_completed")
    phase = "preparing"
    if normalized in {"prepare_data", "data_prepared"}:
        phase = "preprocessing"
    elif normalized.startswith("run_pipeline"):
        phase = "training"
    elif normalized.startswith("evaluate"):
        phase = "evaluating"
    elif normalized.startswith("generate_visualizations") or normalized.startswith("verify_visualizations"):
        phase = "visualizing"
    elif normalized in {"bind_results", "result_binding"}:
        phase = "packaging"
    elif normalized == "completed":
        phase = "completed"

    training_steps = [
        str(command.get("step") or "")
        for command in commands
        if str(command.get("step") or "").startswith("run_pipeline")
    ]
    model_id = None
    seed = None
    run_index = None
    match = re.match(r"^run_pipeline_(?:primary|baseline)_([a-z0-9_-]+)_s(\d+)$", normalized)
    if match:
        model_id = match.group(1)
        seed = int(match.group(2))
        if normalized in training_steps:
            run_index = training_steps.index(normalized) + 1
    return {
        "currentPhase": phase,
        "phaseContext": {
            "modelId": model_id,
            "seed": seed,
            "runIndex": run_index,
            "totalRuns": len(training_steps) or None,
        },
    }


def analysis_bindings_from_commands(commands: list[dict[str, Any]]) -> dict[str, Any]:
    prepare = next(
        (
            command.get("argv", [])
            for command in commands
            if command.get("step") == "prepare_data"
        ),
        [],
    )

    def value_after(flag: str) -> str | None:
        if flag not in prepare:
            return None
        index = prepare.index(flag) + 1
        return str(prepare[index]) if index < len(prepare) else None

    covariate_columns: list[str] = []
    if "--covariate_columns" in prepare:
        index = prepare.index("--covariate_columns") + 1
        while index < len(prepare) and not str(prepare[index]).startswith("--"):
            covariate_columns.append(str(prepare[index]))
            index += 1
    return {
        "timeColumn": value_after("--time_column"),
        "covariateColumns": covariate_columns,
        "metadataColumns": [],
        "temporalArtifactsRequested": "--with-time" in prepare,
        "groupArtifactsRequested": bool(covariate_columns),
    }


def spawn_training_runner(training_run_id: str) -> int:
    env = os.environ.copy()
    python_path = str(PROJECT_ROOT)
    if env.get("PYTHONPATH"):
        env["PYTHONPATH"] = python_path + os.pathsep + env["PYTHONPATH"]
    else:
        env["PYTHONPATH"] = python_path

    kwargs: dict[str, Any] = {
        "cwd": str(PROJECT_ROOT),
        "env": env,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "stdin": subprocess.DEVNULL,
    }
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True

    process = subprocess.Popen(
        [PYTHON_BIN, "-m", "theta_agent_bridge.runner", training_run_id],
        **kwargs,
    )
    return int(process.pid)


def tail_log_lines(log_path: str | None, limit: int = 80) -> list[str]:
    if not log_path or limit <= 0:
        return []
    path = Path(log_path)
    if not path.exists():
        return []
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    return lines[-max(1, min(limit, 500)) :]


def pid_exists(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
    except OSError:
        return False
    return True


def reconcile_training_run(conn: sqlite3.Connection, row: sqlite3.Row) -> sqlite3.Row:
    status = str(row["status"])
    if status not in {"queued", "running", "cancel_requested"}:
        return row
    if pid_exists(row["runner_pid"] or row["pid"]):
        return row

    return quarantine_training_run(
        conn,
        row,
        "Training runner is absent while the persisted run is non-terminal.",
        source="status_reconcile",
    )


def quarantine_training_run(
    conn: sqlite3.Connection,
    row: sqlite3.Row,
    reason: str,
    *,
    source: str,
) -> sqlite3.Row:
    now = utc_now_iso()
    conn.execute(
        """
        UPDATE training_runs
        SET status = 'quarantined', quarantine_reason = ?, error_message = ?,
            updated_at = ?
        WHERE training_run_id = ?
        """,
        (reason, reason, now, row["training_run_id"]),
    )
    record_event(
        conn,
        "training.quarantined",
        "training_run",
        row["training_run_id"],
        {
            "trainingRunId": row["training_run_id"],
            "previousStatus": str(row["status"]),
            "status": "quarantined",
            "reason": reason,
            "source": source,
        },
    )
    updated = select_training_run(conn, training_run_id=row["training_run_id"])
    assert updated is not None
    return updated


@contextmanager
def connect_state_db() -> Iterator[sqlite3.Connection]:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(STATE_DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_state_db(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS training_plans (
            plan_id TEXT PRIMARY KEY,
            plan_hash TEXT NOT NULL,
            plan_json TEXT NOT NULL,
            rationale TEXT NOT NULL DEFAULT '',
            valid INTEGER NOT NULL,
            validation_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS plan_approvals (
            approval_id TEXT PRIMARY KEY,
            plan_id TEXT NOT NULL,
            plan_hash TEXT NOT NULL,
            approved_by TEXT NOT NULL,
            approval_note TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            FOREIGN KEY(plan_id) REFERENCES training_plans(plan_id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS training_runs (
            training_run_id TEXT PRIMARY KEY,
            plan_id TEXT NOT NULL,
            plan_hash TEXT NOT NULL,
            approval_id TEXT NOT NULL,
            plan_review_approval_id TEXT NOT NULL DEFAULT '',
            training_review_approval_id TEXT NOT NULL DEFAULT '',
            dry_run_hash TEXT NOT NULL DEFAULT '',
            idempotency_key TEXT NOT NULL,
            attempt INTEGER NOT NULL DEFAULT 1,
            retry_of_training_run_id TEXT NOT NULL DEFAULT '',
            retry_reason TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL,
            progress INTEGER NOT NULL DEFAULT 0,
            command_json TEXT NOT NULL,
            artifact_json TEXT NOT NULL,
            result_json TEXT NOT NULL DEFAULT '[]',
            quality_json TEXT NOT NULL DEFAULT '{}',
            cancellation_json TEXT NOT NULL DEFAULT '',
            error_message TEXT NOT NULL DEFAULT '',
            failure_json TEXT NOT NULL DEFAULT '',
            quarantine_reason TEXT NOT NULL DEFAULT '',
            pid INTEGER,
            runner_pid INTEGER,
            active_pid INTEGER,
            current_step TEXT NOT NULL DEFAULT '',
            log_path TEXT NOT NULL DEFAULT '',
            python_executable TEXT NOT NULL DEFAULT '',
            python_version TEXT NOT NULL DEFAULT '',
            python_environment TEXT NOT NULL DEFAULT '',
            started_at TEXT NOT NULL DEFAULT '',
            finished_at TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT NOT NULL,
            subject_type TEXT NOT NULL,
            subject_id TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS quality_reassessments (
            receipt_id TEXT PRIMARY KEY,
            training_run_id TEXT NOT NULL,
            artifact_set_hash TEXT NOT NULL,
            receipt_json TEXT NOT NULL,
            assessed_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS rag_documents (
            collection_name TEXT NOT NULL,
            document_id TEXT NOT NULL,
            source_path TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            suffix TEXT NOT NULL,
            title TEXT NOT NULL,
            encoding TEXT NOT NULL,
            byte_size INTEGER NOT NULL,
            content_hash TEXT NOT NULL,
            indexed_at TEXT NOT NULL,
            PRIMARY KEY(collection_name, document_id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS rag_chunks (
            collection_name TEXT NOT NULL,
            chunk_id TEXT NOT NULL,
            document_id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            start_char INTEGER NOT NULL,
            end_char INTEGER NOT NULL,
            text TEXT NOT NULL,
            token_json TEXT NOT NULL,
            PRIMARY KEY(collection_name, chunk_id),
            FOREIGN KEY(collection_name, document_id) REFERENCES rag_documents(collection_name, document_id)
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_rag_chunks_collection ON rag_chunks(collection_name)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_rag_documents_collection ON rag_documents(collection_name)"
    )
    ensure_column(conn, "training_runs", "pid", "INTEGER")
    ensure_column(conn, "training_runs", "runner_pid", "INTEGER")
    ensure_column(conn, "training_runs", "active_pid", "INTEGER")
    ensure_column(
        conn,
        "training_runs",
        "plan_review_approval_id",
        "TEXT NOT NULL DEFAULT ''",
    )
    ensure_column(
        conn,
        "training_runs",
        "training_review_approval_id",
        "TEXT NOT NULL DEFAULT ''",
    )
    ensure_column(conn, "training_runs", "dry_run_hash", "TEXT NOT NULL DEFAULT ''")
    ensure_column(conn, "training_runs", "attempt", "INTEGER NOT NULL DEFAULT 1")
    ensure_column(
        conn,
        "training_runs",
        "retry_of_training_run_id",
        "TEXT NOT NULL DEFAULT ''",
    )
    ensure_column(conn, "training_runs", "retry_reason", "TEXT NOT NULL DEFAULT ''")
    ensure_column(conn, "training_runs", "result_json", "TEXT NOT NULL DEFAULT '[]'")
    ensure_column(conn, "training_runs", "quality_json", "TEXT NOT NULL DEFAULT '{}'")
    ensure_column(conn, "training_runs", "failure_json", "TEXT NOT NULL DEFAULT ''")
    ensure_column(
        conn,
        "training_runs",
        "cancellation_json",
        "TEXT NOT NULL DEFAULT ''",
    )
    ensure_column(
        conn,
        "training_runs",
        "quarantine_reason",
        "TEXT NOT NULL DEFAULT ''",
    )
    ensure_column(conn, "training_runs", "current_step", "TEXT NOT NULL DEFAULT ''")
    ensure_column(conn, "training_runs", "log_path", "TEXT NOT NULL DEFAULT ''")
    ensure_column(
        conn,
        "training_runs",
        "python_executable",
        "TEXT NOT NULL DEFAULT ''",
    )
    ensure_column(
        conn,
        "training_runs",
        "python_version",
        "TEXT NOT NULL DEFAULT ''",
    )
    ensure_column(
        conn,
        "training_runs",
        "python_environment",
        "TEXT NOT NULL DEFAULT ''",
    )
    ensure_column(conn, "training_runs", "started_at", "TEXT NOT NULL DEFAULT ''")
    ensure_column(conn, "training_runs", "finished_at", "TEXT NOT NULL DEFAULT ''")
    migrate_training_run_bindings(conn)
    conn.execute(
        """
        UPDATE training_runs
        SET runner_pid = pid
        WHERE runner_pid IS NULL AND pid IS NOT NULL
        """
    )
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_training_runs_idempotency ON training_runs(idempotency_key)"
    )


def migrate_training_run_bindings(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """
        SELECT training_run_id, plan_id, plan_hash, approval_id,
               plan_review_approval_id, training_review_approval_id, dry_run_hash
        FROM training_runs
        """
    ).fetchall()
    for row in rows:
        plan_review_id = str(row["plan_review_approval_id"] or "")
        if not re.fullmatch(r"approval_[a-f0-9]{20}", plan_review_id):
            plan_review_id = (
                "approval_"
                + sha256_json(
                    {
                        "legacyTrainingRunId": row["training_run_id"],
                        "approvalType": "human_plan_review",
                    }
                )[:20]
            )
        training_review_id = str(row["training_review_approval_id"] or row["approval_id"] or "")
        if not re.fullmatch(r"approval_[a-f0-9]{20}", training_review_id):
            training_review_id = (
                "approval_"
                + sha256_json(
                    {
                        "legacyTrainingRunId": row["training_run_id"],
                        "approvalType": "human_training_review",
                    }
                )[:20]
            )
        dry_run_hash = str(row["dry_run_hash"] or "")
        if not re.fullmatch(r"[a-f0-9]{64}", dry_run_hash):
            dry_run_hash = sha256_json(
                {
                    "legacyTrainingRunId": row["training_run_id"],
                    "planId": row["plan_id"],
                    "planHash": row["plan_hash"],
                }
            )
        if (
            row["approval_id"] == training_review_id
            and row["plan_review_approval_id"] == plan_review_id
            and row["training_review_approval_id"] == training_review_id
            and row["dry_run_hash"] == dry_run_hash
        ):
            continue
        conn.execute(
            """
            UPDATE training_runs
            SET approval_id = ?, plan_review_approval_id = ?,
                training_review_approval_id = ?, dry_run_hash = ?
            WHERE training_run_id = ?
            """,
            (
                training_review_id,
                plan_review_id,
                training_review_id,
                dry_run_hash,
                row["training_run_id"],
            ),
        )


def ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def record_event(
    conn: sqlite3.Connection,
    event_type: str,
    subject_type: str,
    subject_id: str,
    payload: dict[str, Any],
) -> None:
    conn.execute(
        """
        INSERT INTO agent_events
            (event_type, subject_type, subject_id, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (event_type, subject_type, subject_id, stable_json(payload), utc_now_iso()),
    )


def stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_json(value: Any) -> str:
    return hashlib.sha256(stable_json(value).encode("utf-8")).hexdigest()


def utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )
