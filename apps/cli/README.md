# Research Agent CLI

This package is the primary conversational surface of THETA Agent. It owns the
agent experience: research intake, dataset understanding, evidence retrieval,
model recommendation, deterministic planning, human approvals, governed tool
execution, progress monitoring, result interpretation, and operator commands.

THETA is currently the first supported research domain. Domain-specific model
execution is delegated to `packages/theta_agent_bridge` and the ignored local
checkout at `third_party/THETA`. Agent governance and runtime contracts are
provided by the ignored local checkout at `third_party/Hypha`.

## Requirements

- Node.js 22.5 or newer
- A built, pinned Hypha checkout
- The uv-managed Python environment at the repository-root `.venv`
- A pinned THETA checkout for model operations

From the repository root, materialize upstream dependencies first:

```bash
npm run deps:sync
npm --prefix third_party/Hypha ci --ignore-scripts
npm --prefix third_party/Hypha run build:packages
uv sync
```

Then install and build this package:

```bash
pnpm --dir apps/cli install --frozen-lockfile
pnpm --dir apps/cli run build
```

## Run

Verify the local environment:

```bash
pnpm --dir apps/cli run cli -- doctor
```

Start the interactive research agent:

```bash
pnpm --dir apps/cli run cli -- repl
```

Show the complete command reference:

```bash
pnpm --dir apps/cli run cli -- --help
```

Use `--json` for machine-readable output. Runtime state is written beneath
`.theta_agent/` and is excluded from Git.

## Safety model

The language model is never the execution authority. It may interpret bounded
research intent and propose evidence-backed choices, while deterministic local
contracts control tool availability, permissions, validation, plan hashes,
approvals, training, cancellation, and audit records.

External inference is optional. When configured, transfer of sanitized local
context requires the applicable approval gate. Credentials are loaded from
the repository-root `.env` file by default and are never printed by `doctor`.

`THETA_AGENT_BRIDGE_PYTHON` is an escape hatch for an explicitly selected uv
environment; the project does not use Conda environments.

## Package map

- `src/agent` owns research-intent interpretation and clarification.
- `src/conversation` owns turns, commands, and workflow coordination.
- `src/planner` and `src/planning` own evidence-bound proposals and canonical
  executable plans.
- `src/tools` owns governed tool registrations and the THETA bridge adapter.
- `src/rag` and `knowledge` own local evidence retrieval and capability truth.
- `src/storage` owns conversation, run, and research state.
- `src/presentation` owns localized terminal responses.
- `src/theta-domain.ts` owns the current THETA workflow domain contract.

## Validation

Run a fast static check:

```bash
pnpm --dir apps/cli run typecheck
```

Run the runtime and bridge tests, then build the CLI:

```bash
pnpm --dir apps/cli run test
pnpm --dir apps/cli run build
```

The full release gate is available as `pnpm --dir apps/cli run release:verify`.

## Language policy

Documentation and source-code comments are written in English. Runtime strings
and tests may contain the language they localize or parse; these strings are
product data rather than repository documentation.
