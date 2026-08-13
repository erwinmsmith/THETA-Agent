# THETA CLI Agent Tool Contracts

This folder defines the local Tool layer for the Hypha-based THETA CLI Agent.
It does not modify the checked-out `Hypha` framework source.

## Boundary

Tools are the only approved way for the agent runtime to touch THETA data,
plans, training processes, results and local RAG indexes.

The LLM layer must not call Python functions directly. It may request a tool
call, but tool execution is governed by Hypha policies, permission scopes,
idempotency keys, audit records and human approval rules.

## First Tool Set

| Tool ID | Effect | Scope | Purpose |
| --- | --- | --- | --- |
| `theta.dataset.inspect` | read | `theta:dataset:read` | Inspect format, encoding, columns and samples. |
| `theta.dataset.detect_columns` | read | `theta:dataset:read` | Detect text, time and metadata candidates. |
| `theta.dataset.clean_preview` | read | `theta:dataset:read` | Preview cleaning without writing output. |
| `theta.model.catalog` | read | `theta:model:read` | Return normalized model catalog. |
| `theta.model.recommend` | read | `theta:model:read`, `theta:dataset:read` | Recommend model candidates from deterministic constraints. |
| `theta.plan.validate` | read | `theta:plan:read`, `theta:model:read` | Validate a TrainingPlan before approval. |
| `theta.plan.create` v2 | write | `theta:plan:write` | Create a strict canonical planId and planHash after HumanPlanReview. |
| `theta.plan.approve` v1 | write | `theta:plan:approve` | Legacy compatibility command; not used by the DomainPack 3.0 workflow. |
| `theta.training.dry_run` v2 | read | `theta:training:read` | Validate plan review and derive a hash-bound readiness receipt. |
| `theta.training.start` v3 | external_effect | `theta:training:write` | Start or explicitly retry a receipt-bound training attempt. |
| `theta.training.status` v2 | read | `theta:training:read` | Read the strict TrainingReceipt, logs, and lifecycle events. |
| `theta.training.cancel` v2 | irreversible | `theta:training:write` | Record an approved cancellation and process termination receipt. |
| `theta.results.list` | read | `theta:results:read` | List training result artifacts. |
| `theta.results.summarize` | read | `theta:results:read` | Build deterministic result summaries. |
| `theta.rag.index` | write | `theta:rag:write` | Index local evidence documents. |
| `theta.rag.search` | read | `theta:rag:read` | Search local evidence with citations. |
| `theta.events.export` | read | `theta:events:read` | Export local audit events. |
| `theta.events.replay` | read | `theta:events:read` | Replay exported events without side effects. |

## Bridge Status

The first read-only bridge commands are wired through `theta_agent_bridge`:

- `theta.dataset.inspect`
- `theta.dataset.detect_columns`
- `theta.dataset.clean_preview`
- `theta.model.catalog`
- `theta.model.recommend`
- `theta.plan.validate`
- `theta.plan.create`
- `theta.plan.approve`
- `theta.training.dry_run`
- `theta.training.start`
- `theta.training.status`
- `theta.training.cancel`
- `theta.results.list`
- `theta.results.summarize`
- `theta.rag.index`
- `theta.rag.search`
- `theta.events.export`
- `theta.events.replay`

`theta.plan.create` v2 is implemented in TypeScript and returns the canonical
`TrainingPlanRecord`. The DomainPack workflow persists the plan and its
`HumanPlanReview` in Hypha runtime events. `theta.plan.approve` writes only to
the legacy Agent SQLite database and is not consulted by DomainPack 3.0.

`theta.training.dry_run` v2 accepts the canonical plan, the
`HumanPlanReview` receipt, and the dataset path. The Bridge checks dataset
existence and hash, Python and model-script availability, writable working
directory, disk capacity, GPU requirements, and network policy. TypeScript
then creates the stable `DryRunReceipt` and `dryRunHash`; no training process
is spawned.

`theta.training.start` v3 rejects missing, stale, or mismatched plan review,
dry-run, and training review bindings. The idempotency key binds the complete
chain and returns the existing receipt for an already accepted attempt. Failed
runs require a new key, `retryOfTrainingRunId`, and `retryReason`. The runner
executes the resolved `prepare_data.py` and `run_pipeline.py` commands, writes a
UTF-8 log file under
`.theta_agent/runs/<trainingRunId>/training.log`, and updates the
SQLite receipt.

## Approval Authority

The canonical workflow has exactly two business approvals:

1. `HumanPlanReview` binds the reviewer to `planId + planHash`.
2. `HumanTrainingReview` binds a different approval receipt to the same plan
   and to the exact `dryRunHash`.

Hypha human waits and canonical events are authoritative. Python receives and
validates the complete chain but cannot create approvals or advance the FSM.

`theta.training.status` v2 returns a strict `TrainingReceipt`, recent log lines,
and recorded lifecycle events. The receipt binds plan and approval identities,
attempt ancestry, process state, and actual result artifact metadata. If a
runner disappears before reporting a terminal state, reconciliation marks the
run `quarantined`; it never guesses success, failure, cancellation, or an
automatic restart.

`theta.training.cancel` v2 is an irreversible governed operation. Active runs
move to `cancel_requested`; the runner then terminates only its recorded child
process group or tree and marks the run `cancelled`. The cancellation receipt
records the operator, reason, requested time, target PID, graceful outcome, and
forced outcome. Runs without a spawned process can move directly to
`cancelled`.

`theta.results.list` scans local THETA result artifacts under
`third_party/THETA/result` and `.theta_agent/runs`. It can locate artifacts
by `trainingRunId`, `datasetId`, `userId`, `modelId` or an explicit local
`resultRoot`, then returns stable artifact IDs, paths, file kinds, sizes and
optional small previews.

`theta.results.summarize` builds deterministic, non-LLM summaries from result
CSV and JSON artifacts, including topic tables, topic word files, metrics,
configs and visualization inventory.

`theta.rag.index` builds a local lexical evidence index in
`.theta_agent/agent.sqlite`. It accepts files or directories
inside the repository, recursively indexes text-like files, chunks content and
stores document/chunk metadata. It currently supports `.txt`, `.md`, `.csv`,
`.tsv`, `.json`, `.jsonl`, `.yaml`, `.yml`, `.py`, `.ts`, `.tsx`, `.js`,
`.jsx`, `.html` and `.htm`.

`theta.rag.search` searches the local collection deterministically and returns
ranked citations with relative paths, source paths, chunk IDs and text snippets.
It does not call an LLM or external embedding service.

`theta.events.export` reads the local audit log from
`.theta_agent/agent.sqlite` and can filter by event id range,
event type, subject type or subject id. It may include a compact state snapshot
for handoff or inspection.

`theta.events.replay` validates an exported event sequence deterministically,
checks ordering and event hashes, reconstructs subject summaries and can compare
the event export against the current local state database. It performs no tool
execution and has no external side effects.
