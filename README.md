# THETA Agent

English | [简体中文](README.zh-CN.md)

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
agent/                       Agent orchestration, runtime, memory, and services
domain/                      Research contracts and workflow specification
tools/                       Registered tools and the THETA Python adapter
skills/                      Project-owned Agent skills
knowledge/                   Evidence manifests and capability cards
apps/cli/                    Terminal adapter only
apps/api/                    HTTP adapter only
config/                      Reviewed upstream dependency pins
third_party/                 Ignored local THETA and Hypha checkouts
```

Hypha is the single base framework. The Agent bootstrap loads Hypha's built-in
skills directly from `third_party/Hypha`, loads project skills from `skills/`,
registers governed tools from `tools/`, and validates all registrations against
the domain workflow. THETA is invoked through those tools and is never copied
into project source.

## Prerequisites

- Git
- Node.js 22.5 or newer
- pnpm through Corepack
- uv 0.11 or newer; uv manages the pinned Python 3.12 environment

## Quick start

### 1. Clone THETA Agent

```bash
git clone https://github.com/erwinmsmith/THETA-Agent.git
cd THETA-Agent
```

### 2. Clone THETA and Hypha

The repository automatically checks both upstream dependencies before
`npm run doctor` and `npm start`. If either checkout is missing,
`deps:ensure` clones the latest commit from its configured `main` branch into
the ignored `third_party/` directory. The same command reports whether every
local checkout matches its reviewed pin. Existing checkouts are never pulled
or overwritten automatically:

```bash
npm run deps:ensure
```

Use `npm run deps:sync` when you specifically need the exact reviewed
revisions recorded in `config/upstreams.lock.json`.

If you prefer to clone the upstream repositories yourself, use these paths and
then run the dependency check:

```bash
mkdir -p third_party
git clone --filter=blob:none --branch main \
  https://github.com/CodeSoul-co/THETA.git third_party/THETA
git clone --filter=blob:none --branch main \
  https://github.com/CodeSoul-co/Hypha.git third_party/Hypha
npm run deps:ensure
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
pnpm install --frozen-lockfile
npm run build
npm run test:registries
```

When using nvm, run `nvm use` first; `.nvmrc` selects the tested Node release.

The default uv environment supports THETA tools, data inspection, tests, and
model catalog. Install the full THETA training stack only when training is
needed:

```bash
npm run python:sync:training
```

The CLI automatically uses `.venv/bin/python` (or the Windows equivalent).

### 4. Configure and select a language model

The deterministic agent works without an API key. DeepSeek is the default
language provider; the optional language layer also supports MiniMax, OpenAI,
OpenRouter, local Ollama, and any custom
OpenAI-compatible endpoint. Create a local environment file and fill only one
provider's required values:

```bash
cp .env.example .env
```

If a sibling Hypha checkout already contains the DeepSeek key, import only its
DeepSeek configuration without displaying the secret:

```bash
npm run env:import:hypha
```

`.env` is ignored and must never be committed.

Set `THETA_LLM_PROVIDER` and `THETA_LLM_MODEL` in `.env` for an environment
default, or switch models without editing the file:

```bash
npm run build
npm run model -- list
npm run model -- use --provider openai --model <model-id>
npm run model -- current
```

The selected provider and model are saved in the ignored
`.theta_agent/inference-selection.json`; credentials remain only in `.env`.
A saved choice takes precedence over `THETA_LLM_PROVIDER`. Reset it to return
to the environment default:

```bash
npm run model -- reset
```

Inside the interactive Agent, the equivalent commands are `/model list`,
`/model use <provider> <model>`, `/model`, and `/model reset`. `/llm on` enables
language assistance for the current conversation; model selection and consent
are intentionally separate controls.

Provider-specific variables are documented in [.env.example](.env.example).
Ollama normally requires only `OLLAMA_MODEL`; the other built-in remote
providers require their corresponding API key. `npm run doctor` reports the
active selection and whether its configuration is usable.

### 5. Verify and start the system

Check the complete local agent environment:

```bash
npm run doctor
```

Start the conversational research agent:

```bash
npm start
```

Start the optional local HTTP API with:

```bash
npm run start:api
```

Example first session:

```text
/start fixtures/sample.jsonl
/next
/brief
/exit
```

Every direct CLI command and interactive command, including parameters,
approval behavior, examples, exit codes, and troubleshooting, is documented in
the [complete CLI reference](docs/CLI.md). A
[Chinese CLI reference](docs/CLI.zh-CN.md) is also available.

## Updating upstream dependencies

Ensure both checkouts exist and inspect their pinned and local states:

```bash
npm run deps:ensure
```

Fetch the current `main` branches, move the local checkouts to those commits,
and update the reviewed lock file:

```bash
npm run deps:update
```

Review and test the resulting `config/upstreams.lock.json` change before
committing it. Other developers can then reproduce the exact versions with
`npm run deps:sync`.

See [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the complete development and
architecture contracts.

## License

Project-authored code is available under the [MIT License](LICENSE). Locally
downloaded THETA and Hypha sources retain their respective upstream licenses.
