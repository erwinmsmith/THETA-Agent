# Repository Guidelines

## Project Structure & Module Organization

Keep orchestration in `agent/src/`, research contracts in `domain/src/`, and governed integrations in `tools/src/`. THETA Python adapters and tests live under `tools/THETA_tools/`. User-facing adapters belong in `apps/cli/`, `apps/api/`, and `apps/web/`; they must not own domain logic. Skills are in `skills/`, evidence data in `knowledge/`, examples in `fixtures/`, and maintenance checks in `scripts/`. Treat `third_party/`, `.theta_agent/`, datasets, results, and build output as local-only artifacts.

## Build, Test, and Development Commands

- `npm run deps:ensure`: verify required upstream checkouts without committing them.
- `npm run python:sync`: create/update the uv-managed Python environment.
- `pnpm install --frozen-lockfile`: install the JavaScript workspace.
- `npm run build`: compile domain, tools, agent, CLI, API, and web packages.
- `npm start`: launch the conversational CLI; `npm run start:api` launches the API.
- `pnpm --filter @theta-agent/web run dev`: run the Vite frontend locally.
- `npm run validate`: check dependency boundaries and CLI documentation coverage.
- `npm run test:python`, `test:providers`, and `test:registries`: run targeted checks.

## Coding Style & Naming Conventions

Use two-space indentation, semicolons, ESM imports, and single quotes in TypeScript. Prefer strict schemas and explicit boundary types. Use `kebab-case.ts` filenames, `PascalCase` React components/classes, and `camelCase` functions. Python uses four spaces, `snake_case`, and `test_*.py` test names. Keep source comments in English; `README.zh-CN.md` and `docs/*.zh-CN.md` are intentional translations. No repository-wide formatter is configured, so preserve nearby style.

## Testing Guidelines

Add focused tests beside the affected subsystem or under `tools/THETA_tools/tests/`. Update `scripts/check-*.mjs` when changing registries, providers, documentation, or dependency rules. Before handoff, run `npm run build`, `npm run validate`, and relevant targeted tests. Never depend on live paid model calls or committed secrets.

## Commit & Pull Request Guidelines

Recent history favors concise Conventional Commit subjects such as `fix(web): restore base stylesheet import` and `feat(api): complete the conversational API surface`. Keep commits scoped and imperative. PRs should explain the change, user impact, validation performed, and linked issue; include screenshots for web UI changes and sample CLI output for command changes. Target `dev` for development work, keep unrelated changes out of the diff, and promote only validated release-ready changes to `main`.

## Security & Configuration

Copy `.env.example` to `.env`; never commit API keys. Use `uv`, not Conda. Do not vendor THETA or Hypha source—local upstream checkouts remain ignored.
