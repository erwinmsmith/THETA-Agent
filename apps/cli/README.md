# Research Agent CLI

This package is the terminal adapter for THETA Agent. It owns command parsing,
interactive input, and terminal rendering. Agent behavior is implemented in
the repository-level `agent/` package.

THETA execution is delegated to `tools/THETA_tools` and the ignored
`third_party/THETA` checkout. Agent governance and runtime contracts come from
the single ignored `third_party/Hypha` checkout.

## Setup

From the repository root:

```bash
npm run deps:ensure
npm run python:sync
npm run hypha:install
npm run hypha:build
pnpm install --frozen-lockfile
npm run build
```

## Run

Verify the local environment:

```bash
npm run doctor
```

Start the interactive research agent:

```bash
npm start
```

Show the complete command reference:

```bash
pnpm --filter @theta-agent/cli run cli -- --help
```

Use `--json` for machine-readable output. Runtime state is written beneath
`.theta_agent/` and is excluded from Git.

## Adapter map

- `src/cli.ts` dispatches direct operator commands.
- `src/agent-cli.ts` runs the conversational REPL.
- `src/theta-workflow-cli.ts` adapts workflow commands.
- `src/presentation/terminal-renderer.ts` renders terminal output.

## Safety and environment

The language model is never the execution authority. Deterministic contracts
control tool availability, permissions, validation, plan hashes, approvals,
training, cancellation, and audit records.

Python is managed only through uv. `THETA_AGENT_TOOLS_PYTHON` may select an
explicit uv environment; Conda is not used.

Documentation and source-code comments are written in English. Runtime strings
may contain the languages that the product localizes or parses.
