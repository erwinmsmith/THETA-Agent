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
- **CPU by default:** unspecified plans execute on the local CPU. The compute
  backend is isolated so a future scheduler can be added without moving policy
  into the CLI, API, or web adapters.

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
third_party/                 Ignored local THETA checkout
```

Hypha is the single base framework, consumed as the published
`@codesoul-co/hypha-*` npm release line. The Agent bootstrap loads Hypha's
built-in skills from the `@codesoul-co/hypha-skills` package, loads project
skills from `skills/`, registers governed tools from `tools/`, and validates
all registrations against the domain workflow. THETA is invoked through those
tools and is never copied into project source.

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

### 2. Clone THETA

Hypha ships as the published `@codesoul-co/hypha-*` npm release line and is
installed by the package manager; it is not a local checkout. THETA remains the
single upstream repository, and `deps:ensure` clones or reports it before
`npm run doctor` and `npm start`. Existing checkouts are never pulled or
overwritten automatically:

```bash
npm run deps:ensure
```

Use `npm run deps:sync` when you specifically need the exact reviewed
revision recorded in `config/upstreams.lock.json`. If you prefer to clone the
upstream repository yourself, use this path and then run the dependency check:

```bash
mkdir -p third_party
git clone --filter=blob:none --branch main \
  https://github.com/CodeSoul-co/THETA.git third_party/THETA
npm run deps:ensure
```

`third_party/` is intentionally ignored. Never add THETA source files to this
repository.

### 3. Install dependencies

Install the default local runtime:

```bash
corepack enable
npm run python:sync
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

Local computation defaults to `THETA_COMPUTE_BACKEND=local` and
`THETA_COMPUTE_DEVICE=cpu`. A plan may explicitly request GPU, but training
subprocesses otherwise hide accelerator devices to prevent upstream automatic
detection. Distributed scheduling is not implemented yet; `local` is the
current execution backend and the extension boundary for that later work.

Set `THETA_LLM_PROVIDER` and `THETA_LLM_MODEL` in `.env` for an environment
default, or switch models without editing the file:

```bash
npm run build
npm run model -- list
npm run model -- use --provider openai --model <model-id>
npm run model -- current
```

The selected provider and model are saved in the ignored
`.theta_agent/inference-selection.json`. The Web settings center can also save
provider overrides and write-only API keys to private, ignored files under
`.theta_agent/` (mode `0600`); keys are never returned by the API. Environment
variables remain supported and take effect when no private override exists.
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

The API server also serves the conversational web interface (built from
`apps/web` by `npm run build`) at `http://127.0.0.1:4318/` — run list,
conversational thread, approval forms, tool-call trace, reasoning panel, and
live SSE updates. The composer selects provider, model, and reasoning type;
the settings button controls LLM API, generation, streaming, and typewriter
behavior plus a separate optional embedding API. These controls never modify
THETA training-model parameters. See [docs/WEB.md](docs/WEB.md).
Current shipped capabilities and explicit limitations are tracked in
[docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).

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

Ensure the THETA checkout exists and inspect its pinned and local states:

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
