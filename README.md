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

## Prerequisites

- Git
- Node.js 22.5 or newer
- pnpm through Corepack
- uv 0.11 or newer; uv manages the pinned Python 3.12 environment

## Quick start

### 1. Clone THETA Agent

Use `main` for the release-ready product or switch to `dev` for active
development:

```bash
git clone https://github.com/erwinmsmith/THETA-Agent.git
cd THETA-Agent
# Optional for contributors:
git switch dev
```

### 2. Clone THETA and Hypha

The recommended command reads `config/upstreams.lock.json`, clones both
repositories into the ignored `third_party/` directory, and checks out the
exact reviewed revisions:

```bash
npm run deps:sync
npm run deps:status
```

If you prefer to clone the upstream repositories yourself, use these paths and
then run the synchronization command to apply the reviewed revisions:

```bash
mkdir -p third_party
git clone --filter=blob:none --branch main \
  https://github.com/CodeSoul-co/THETA.git third_party/THETA
git clone --filter=blob:none --branch main \
  https://github.com/CodeSoul-co/Hypha.git third_party/Hypha
npm run deps:sync
```

`third_party/` is intentionally ignored. Never add THETA or Hypha source files
to this repository.

### 3. Install dependencies

Install the default local runtime:

```bash
corepack enable
npm run python:sync
npm run hypha:install
npm run hypha:build
npm run cli:install
npm run build
```

The default uv environment supports the bridge, data inspection, tests, and
model catalog. Install the full THETA training stack only when training is
needed:

```bash
npm run python:sync:training
```

The CLI automatically uses `.venv/bin/python` (or the Windows equivalent).

### 4. Configure the optional language provider

The deterministic agent works without an API key. To enable the optional
MiniMax language layer, create a local environment file and fill only the
required values:

```bash
cp .env.example .env
```

`.env` is ignored and must never be committed.

### 5. Verify and start the system

Check the complete local agent environment:

```bash
npm run doctor
```

Start the conversational research agent:

```bash
npm start
```

Example first session:

```text
/start fixtures/sample.jsonl
/next
/brief
/exit
```

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
