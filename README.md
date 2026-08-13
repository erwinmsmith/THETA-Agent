# THETA Agent

THETA Agent is an agent-first, conversational auto-research system for the
command line. It helps a researcher understand a dataset, clarify a research
question, select an evidence-backed model, review an executable plan, approve
costly actions, monitor training, and interpret the resulting artifacts.

THETA topic modeling is the first research domain, not the architectural
boundary of the product. The repository is organized so that future research
domains can reuse the conversation, planning, governance, tool, memory, and
runtime layers without being coupled to THETA-specific model code.

## Design principles

- **Agent first:** conversation and research orchestration are the product.
- **Domain adapters:** THETA is the first pluggable research capability.
- **Governed execution:** every external action is registered, permissioned,
  auditable, and guarded by explicit human approval where required.
- **Reproducible dependencies:** upstream repositories are pinned to reviewed
  commits in `config/upstreams.lock.json`.
- **Clean ownership:** upstream source is stored only in the ignored
  `third_party/` directory and is never committed to this repository.
- **Local by default:** datasets, model assets, credentials, and run artifacts
  remain outside version control.

## Repository map

```text
apps/cli/                    Conversational agent and operator CLI
packages/theta_agent_bridge Governed Python adapter for the THETA domain
config/                      Reviewed upstream dependency pins
docs/                        Architecture and development policy
scripts/                     Dependency and repository maintenance tools
third_party/                 Ignored local THETA and Hypha checkouts
```

The current implementation in `apps/cli` was imported from the `cli` branch of
`passerby169/AGENT-THETA` and is now maintained as first-party project code.
Its provenance is recorded in [NOTICE](NOTICE).

## Prerequisites

- Git
- Node.js 22.5 or newer
- pnpm through Corepack
- uv 0.11 or newer; uv manages the pinned Python 3.12 environment

## Bootstrap

Clone the repository and materialize the pinned upstream dependencies:

```bash
npm run deps:sync
corepack enable
npm --prefix third_party/Hypha ci --ignore-scripts
npm --prefix third_party/Hypha run build:packages
uv sync
pnpm --dir apps/cli install --frozen-lockfile
pnpm --dir apps/cli run build
```

The default uv environment supports the bridge, data inspection, tests, and
model catalog. Install the full THETA training stack only when training is
needed:

```bash
uv sync --extra training
```

The CLI automatically uses `.venv/bin/python` (or the Windows equivalent).
Then verify the complete local agent environment:

```bash
pnpm --dir apps/cli run cli -- doctor
```

Start the conversational interface:

```bash
pnpm --dir apps/cli run cli -- repl
```

Real credentials belong in `.env`, which is ignored. Start from `.env.example`
and never commit API keys.

## Updating upstream dependencies

Inspect the pinned and local states:

```bash
npm run deps:status
```

Fetch the current `main` branches, move the local checkouts to those commits,
and update the reviewed lock file:

```bash
npm run deps:update
```

Review and test the resulting `config/upstreams.lock.json` change before
committing it. Other developers can then reproduce the exact versions with
`npm run deps:sync`.

## Branch policy

- `main` contains release-ready, production-quality code.
- `dev` is the integration branch for active development.
- Feature and fix branches merge into `dev` first.
- A tested release candidate is promoted from `dev` to `main`.

See [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the complete development and
architecture contracts.

## License

Project-authored code is available under the [MIT License](LICENSE). Locally
downloaded THETA and Hypha sources retain their respective upstream licenses.
