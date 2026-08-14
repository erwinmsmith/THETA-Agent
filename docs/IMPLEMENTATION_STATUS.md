# Implementation Status and Gaps

This document distinguishes shipped behavior from planned work. It is the
reference for product claims in the CLI and Web UI.

## Available now

- Conversation-first Web and CLI adapters backed by one Agent orchestration
  layer.
- DeepSeek as the default provider, with runtime switching among configured
  providers and models.
- SQLite conversation history, rename/delete operations, working-memory
  summaries, structured research interview revisions, and Run promotion.
- Semantic pre-Run routing with schema validation. Dataset upload appears only
  when the Agent requests it; deterministic fallback never selects a Tool by
  keyword.
- Pre-Run questions may use the read-only local evidence search and model
  catalog Tools; every call still passes schema routing and the Tool policy.
- Hypha-governed Tool execution with permission, policy, lifecycle, validation,
  and audit events. Search and Tool results are visible as expandable activity.
- FSM-backed accept/reject checkpoints for dataset understanding, research
  intent, plan creation, and training start.
- CPU-default local execution, normalized result visualizations/tables/metrics,
  follow-up result analysis, and artifact archive download.
- Light/dark/system themes and Chinese/English interface preferences.

## Known gaps

- Message queuing is currently client-side and sequential. A server-owned job
  queue is required for multi-device recovery and process restarts.
- Working memory is a bounded SQLite projection, not semantic/vector long-term
  memory. Cross-project recall and user-controlled memory editing are pending.
- Folder upload registers supported files individually; dataset bundles and
  resumable transfer are not yet modeled as first-class backend resources.
- Result preview supports normalized image/HTML assets and tables. Rich notebook,
  very large table, and collaborative annotation viewers are pending.
- Compute scheduling is not implemented. The execution boundary defaults to
  local CPU and is designed for a future scheduler adapter.
- Search currently targets the local THETA evidence index. External Web search
  requires a separately registered, policy-scoped Tool and source citations.
- Localization covers the main workspace; some backend-generated research
  presentation text remains Chinese until presentation contracts carry locale.

Do not mark a gap as complete until its contracts, persistence, UI, tests, and
documentation all ship together.
