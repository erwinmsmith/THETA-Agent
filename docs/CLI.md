# THETA Agent CLI reference

English | [简体中文](CLI.zh-CN.md)

This is the complete user-facing reference for the direct CLI and the
interactive REPL. Run commands from the repository root after completing the
README setup.

## Command forms and conventions

```bash
npm run cli -- <command> [options]
npm start
```

After installation, `theta <command>` is equivalent to `npm run cli --
<command>`. Examples use the repository command so they also work in a local
checkout.

Common placeholders:

- `<run-id>` is the durable workflow ID printed by `start` or `workflow run`.
- `<training-run-id>` is the execution ID printed after training starts.
- `<dataset-ref>` is the opaque reference printed by `dataset register`.
- `--runtime-db <path>` selects another SQLite runtime; omit it to use
  `.theta_agent/theta-workflow.sqlite`.
- `--json` requests a machine-readable response where supported.
- A command that requests approval without `--approve` performs only a safe
  preview. Review its output and repeat with `--approve` to execute.

Use Node.js from `.nvmrc`:

```bash
nvm use
npm run build
npm run cli -- --help
```

## Recommended conversational workflow

For normal research, use the REPL. It owns the whole Agent conversation,
clarification, planning, approval, training, and results journey:

```bash
npm start
```

```text
/start fixtures/sample.jsonl
Answer the research questions in natural language.
/next
/plan
/approve-plan
/start-training
/follow
/results
/summary
/exit
```

The direct low-level commands are intended for automation, diagnostics, and
contract testing. Do not mix receipts, plan hashes, or approval IDs from
different Runs.

## Environment and models

DeepSeek is the default provider. Copy the template and set the key manually,
or securely import DeepSeek variables from a sibling Hypha checkout:

```bash
cp .env.example .env
npm run env:import:hypha
```

The import command copies only DeepSeek-related variables, never prints the
key, and writes `.env` with local-only permissions. A custom source file can be
passed as the first argument:

```bash
npm run env:import:hypha -- /absolute/path/to/Hypha/.env
```

### `model list`, `model current`, `model use`, `model reset`

Inspect provider readiness, inspect the current model, save an explicit
selection, or clear it and return to the `.env` default:

```bash
npm run cli -- model list
npm run cli -- model current --json
npm run cli -- model use --provider deepseek --model deepseek-chat
npm run cli -- model reset
```

Supported provider IDs are `deepseek`, `minimax`, `openai`, `openrouter`,
`ollama`, and `custom`. The saved selection is stored in ignored local runtime
state; API keys remain in `.env`.

### `language intent`

Classify bounded, read-only intent. Without `--approve`, external inference is
not authorized and the command returns its governed approval result or local
fallback.

```bash
npm run cli -- language intent --text "show the current model catalog"
npm run cli -- language intent --text "show the current model catalog" --approve --json
```

### `language question`

Improve the wording of a research question without changing workflow state:

```bash
npm run cli -- language question \
  --text "Which themes changed?" \
  --field researchQuestion \
  --reason "Clarify the time comparison" \
  --approve
```

### `language explain`

Explain an existing deterministic recommendation. `--confidence` accepts
`low`, `medium`, or `high`; reason codes and warnings are comma-separated.

```bash
npm run cli -- language explain \
  --model-id lda --score 80 --confidence medium \
  --reason-codes TEXT_PROFILE_MATCH \
  --warnings NO_EVIDENCE_AVAILABLE \
  --evidence "LDA supports interpretable corpus-level topics." \
  --approve
```

## Diagnostics and evidence

### `doctor`

Checks Node, pnpm, uv/Python, Hypha, THETA, registries, SQLite, knowledge,
hardware visibility, and the selected inference provider. Warnings preserve a
usable deterministic system; failures block required capabilities.

```bash
npm run doctor
npm run cli -- doctor --json
```

### `rag build` and `rag status`

Build or inspect the governed local evidence index:

```bash
npm run cli -- rag status
npm run cli -- rag build
npm run cli -- rag status --json
```

### `audit export` and `evidence show`

Both read persisted evidence for a workflow Run. `audit export` emphasizes the
canonical event/tool trace; `evidence show` uses the Agent presentation.

```bash
npm run cli -- audit export --run-id <run-id> --json
npm run cli -- evidence show --run-id <run-id>
```

## Durable Agent commands

### `start`

Starts the same V2 workflow used by the REPL. Use either `--file` or a complete
`--input` JSON object. Optional flags include `--dataset-id`, `--goal`,
`--sample-size`, `--run-id`, `--runtime-db`, `--approved-by`,
`--approve-plans`, `--approve-training`, and `--json`. Training approval
requires plan approval.

```bash
npm run cli -- start --file fixtures/sample.jsonl \
  --goal "Discover stable themes and temporal changes" \
  --sample-size 10

npm run cli -- start --input fixtures/cli/workflow-input.json --json
```

### `resume`

Resumes a persisted Run. It can resolve an approval with `--approve` or
`--reject`, or submit a JSON answer/confirmation. Do not pass `--approve` and
`--reject` together.

```bash
npm run cli -- resume --run-id <run-id>
npm run cli -- resume --run-id <run-id> --approve
npm run cli -- resume --run-id <run-id> --answers fixtures/research-answers.json
npm run cli -- resume --run-id <run-id> --columns fixtures/column-confirmation.json
```

For V2-specific dataset confirmation, decision answers, and plan adjustment,
use the equivalent `workflow resume` flags documented below.

### `answer` and `columns`

Submit a single natural-language turn outside the REPL. Both require the Run
ID; `--session-id` can isolate an automation session.

```bash
npm run cli -- answer --run-id <run-id> \
  --text "Compare topic prevalence by category and over time"

npm run cli -- columns --run-id <run-id> \
  --text "text is the document, created_at is time, id is the identifier"
```

### `status`

Reads the canonical workflow projection without advancing the Run:

```bash
npm run cli -- status --run-id <run-id>
npm run cli -- status --run-id <run-id> --json
```

### `plan show` and Run-level `plan approve`

Show the candidate/canonical plan or approve a Run waiting at
`HumanPlanReview`. The Run-level form is selected by `--run-id` and is distinct
from the low-level `--plan-id` compatibility command.

```bash
npm run cli -- plan show --run-id <run-id>
npm run cli -- plan approve --run-id <run-id> --approved-by local_user
```

### `train status` and `train cancel`

These Agent aliases inspect or cancel a training execution. `--log-limit` is a
positive integer up to 500. Cancellation is preview-only until repeated with
`--approve`.

```bash
npm run cli -- train status --run-id <training-run-id> --log-limit 100
npm run cli -- train cancel --run-id <training-run-id> --reason "Wrong input"
npm run cli -- train cancel --run-id <training-run-id> --reason "Wrong input" --approve
```

### `repl`

Opens the persistent conversational Agent. Optionally attach an existing Run
or use another database:

```bash
npm run cli -- repl
npm run cli -- repl --run-id <run-id>
npm run cli -- repl --run-id <run-id> --runtime-db .theta_agent/custom.sqlite
```

## Dataset and model utility commands

### `dataset inspect`

Reads format, encoding, rows, columns, and bounded samples without registering
the dataset:

```bash
npm run cli -- dataset inspect --file fixtures/sample.jsonl --sample-size 5
```

### `dataset detect-columns`

Scores likely text, time, ID, and metadata columns:

```bash
npm run cli -- dataset detect-columns --file fixtures/sample.jsonl --sample-size 10
```

### `dataset register`

Copies/registers an allowed local dataset in the local registry and returns a
`datasetRef`:

```bash
npm run cli -- dataset register --file fixtures/sample.jsonl --json
```

### `dataset explore`

Explores only a previously registered reference. Use the `datasetRef` returned
by `dataset register`:

```bash
npm run cli -- dataset explore --dataset-ref <dataset-ref> --sample-size 5
```

### `dataset understanding`

Reads the validated V2 understanding associated with a Run:

```bash
npm run cli -- dataset understanding --run-id <run-id> --json
```

### `dataset confirm`

Validates the supplied confirmation against observed columns and resumes the
same Run:

```bash
npm run cli -- dataset confirm --run-id <run-id> \
  --file fixtures/cli/dataset-confirmation.json
```

### `models`

Lists the THETA model catalog through the governed tool registry:

```bash
npm run cli -- models
npm run cli -- models --json
```

### `recommend`

Runs the deterministic recommender from a normalized profile and confirmed
columns. `--max-topics` must be positive.

```bash
npm run cli -- recommend \
  --profile fixtures/data-profile.json \
  --columns fixtures/model-recommend-columns.json \
  --goal "Find interpretable themes" \
  --max-topics 12
```

## Low-level plan and training commands

These commands expose governed Tool contracts. Prefer the REPL for real work,
because it creates hash-bound records and approval receipts in the correct
order.

### `plan validate`

Validates the `validatedPlan` inside a Planner V2 bundle without writing state:

```bash
npm run cli -- plan validate --file <planner-v2-bundle.json>
```

### `plan create`

Requests creation without `--approve`; repeat with `--approve` after review.
The input must contain the validated plan, facts, confirmation, intent,
planner input/decision, evidence bundle, validation result, and DomainPack
identity from one workflow.

```bash
npm run cli -- plan create --file <planner-v2-bundle.json>
npm run cli -- plan create --file <planner-v2-bundle.json> --approve
```

### Low-level `plan approve`

This compatibility command is selected by `--plan-id`, not `--run-id`. It
requires the exact ID/hash emitted by `plan create`:

```bash
npm run cli -- plan approve \
  --plan-id <plan-id> --plan-hash <plan-hash> \
  --approved-by local_user --note "Reviewed" --approve
```

### `training dry-run`

Input fields are `plan`, `planReview`, and `datasetPath`. It validates the
complete binding and never starts training:

```bash
npm run cli -- training dry-run --file <dry-run-request.json>
```

### `training start`

Input fields are `plan`, `planReview`, `dryRun`, `trainingReview`, and an
optional `idempotencyKey`. The command previews unless `--approve` is present.
All records must share the same plan/hash chain.

```bash
npm run cli -- training start --file <training-start-request.json>
npm run cli -- training start --file <training-start-request.json> --approve
```

### `training status` and `training cancel`

These are direct governed-tool forms of the Agent aliases:

```bash
npm run cli -- training status --run-id <training-run-id> --log-limit 100
npm run cli -- training cancel --run-id <training-run-id> --reason "Stop requested"
npm run cli -- training cancel --run-id <training-run-id> --reason "Stop requested" --approve
```

Static plan/dry-run/start fixtures are deliberately not provided: their hashes
and approval IDs would be invalid for another Run. See
`fixtures/cli/README.md`.

## Workflow contract commands

### `workflow compile`

Compiles the DomainPack and prints its FSM, tool references, and contract
hashes:

```bash
npm run cli -- workflow compile
```

### `workflow run`

The explicit form of `start`. V2 is the default. Useful flags are `--file` or
`--input`, `--goal`, `--sample-size`, `--planner-mode provider|deterministic`,
`--run-id`, `--runtime-db`, `--approve-plans`, `--approve-training`,
`--approved-by`, and `--json`.

```bash
npm run cli -- workflow run --input fixtures/cli/workflow-input.json
npm run cli -- workflow run --file fixtures/sample.jsonl \
  --planner-mode deterministic --json
```

### `workflow resume`

Resumes a wait with one applicable input. Available flags are `--answers`,
`--columns`, `--dataset-confirmation`, `--decision-answer`,
`--plan-adjustment`, `--approve`, and `--reject`.

```bash
npm run cli -- workflow resume --run-id <run-id> \
  --dataset-confirmation fixtures/cli/dataset-confirmation.json
npm run cli -- workflow resume --run-id <run-id> \
  --decision-answer "Use medium topic granularity"
npm run cli -- workflow resume --run-id <run-id> \
  --plan-adjustment fixtures/cli/plan-adjustment.json
npm run cli -- workflow resume --run-id <run-id> --approve
```

### `workflow status`, `workflow trace`, and `workflow replay`

Status reads the projection, trace exports canonical/tool events, and replay
constructs a deterministic replay without calling providers or executing tools:

```bash
npm run cli -- workflow status --run-id <run-id>
npm run cli -- workflow trace --run-id <run-id> --json
npm run cli -- workflow replay --run-id <run-id> --json
```

### `demo`

Runs a local governed showcase. It never starts training. Without `--approve`
it stops at the plan review preview:

```bash
npm run cli -- demo
npm run cli -- demo --approve
```

## Interactive REPL commands

Natural-language text without `/` is routed according to the current workflow
state. Slash commands are deterministic controls.

| Command | Purpose and example |
| --- | --- |
| `/help` | Show the built-in command summary. |
| `/start <file>` | Start and activate a Run: `/start fixtures/sample.jsonl`. |
| `/answer <text>` | Explicit research answer: `/answer Compare categories over time`. |
| `/columns <text>` | Confirm roles: `/columns text is content; created_at is time`. |
| `/llm on\|off` | Grant or revoke provider assistance for this conversation. |
| `/model` | Show the current provider/model. |
| `/model list` | Show all providers and readiness. |
| `/model use <provider> <model>` | Persist a model: `/model use deepseek deepseek-chat`. |
| `/model reset` | Return to the `.env` default. |
| `/brief` | Show the current persisted research brief. |
| `/history` | Show recent persisted conversation messages. |
| `/next` | Show the recommended next action. |
| `/done` | Finish the current research interview using validated/defaulted answers. |
| `/details [section] [page]` | Page through the prior raw response: `/details evidence 2`. |
| `/status [runId]` | Show active or named Run status. |
| `/why [all\|model\|parameters\|protocol\|evidence] [runId]` | Explain a decision: `/why model`. |
| `/evidence [runId]` | Show governed evidence. |
| `/plan [runId]` | Show candidate or canonical plan. |
| `/approve-plan [runId]` | Approval 1/2; creates the canonical plan. |
| `/approve-plan --accept-degradation` | Explicitly accept reported capability degradation. |
| `/start-training [runId]` | Approval 2/2; starts the bound training execution. |
| `/approve [runId]` | Compatibility approval for the current wait. |
| `/adjust <text>` | Request a plan revision: `/adjust use 8 topics and CPU`. |
| `/follow` | Follow training until a terminal state; Ctrl-C detaches only. |
| `/logs` | Show recent training logs. |
| `/results` | List validated result artifacts. |
| `/open-results` | Open the active local results directory. |
| `/summary` | Interpret persisted metrics and artifacts. |
| `/runs` | List local durable Runs. |
| `/cancel <reason>` | Preview cancellation. |
| `/cancel <reason> --confirm` | Confirm cancellation of the active execution. |
| `/retry` | Resume a failed Run or create a bound retry attempt. |
| `/reevaluate` | Recompute quality from existing artifacts without retraining. |
| `/save [runId]` | Generate deterministic replay output. |
| `/back` | Clear the active Run but keep persisted data. |
| `/exit` | Close the REPL. |

## Exit codes and troubleshooting

- `0`: command completed or returned a non-blocking preview.
- `1`: invalid arguments, missing input, policy/tool error, or unsupported command.
- `2`: Doctor found a blocking failure, a workflow failed, or plan validation
  rejected the plan.

Useful checks:

```bash
npm run deps:ensure
npm run build
npm run doctor
npm run test:docs
```

If Node reports that `node:sqlite` is unavailable, run `nvm use`; Node 22.5 or
newer is required. If provider status is incomplete, check `.env` and run
`npm run cli -- model list`. Never commit `.env`, `.theta_agent/`, datasets,
upstream source, or training artifacts.
