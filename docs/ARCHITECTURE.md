# Architecture

## Product boundary

THETA Agent is a conversational auto-research agent. Its durable product
boundary is the research loop: understand intent and data, gather evidence,
propose a plan, obtain approval, execute governed tools, monitor progress, and
explain results. Topic modeling is the first capability, not the identity of
the application.

## Layer model

```text
CLI / API / Web adapters
        |
Agent bootstrap, conversation, and research orchestration
        |
Skills, planning, policy, approvals, memory, and Hypha runtime
        |
Domain contracts <----> Governed tool registry
                              |
                         THETA tools
                              |
                    Ignored THETA checkout
```

The repository has seven ownership areas:

1. `agent` owns conversation, orchestration, runtime composition, approvals,
   memory, application services, and the central bootstrap.
2. `domain` owns pure research contracts and the workflow specification. It
   does not contain a nested THETA directory; THETA executes through tools.
3. `tools` owns Hypha tool registration, capability implementations, and the
   `THETA_tools` Python protocol.
4. `skills` owns project skill definitions. The skill registry also loads
   Hypha built-ins from the shipped `@codesoul-co/hypha-skills` package data.
5. `knowledge` owns evidence manifests and model capability cards.
6. `apps/cli`, `apps/api`, and `apps/web` are thin input/output adapters;
   the web UI renders only what the API exposes and never decides policy.
7. `third_party/THETA` is the single standard upstream checkout and remains
   ignored. Hypha is consumed through the published `@codesoul-co/hypha-*` npm
   release line; no Hypha source is copied into the project.

## Dependency direction

Applications depend only on the public Agent API. Agent services compose the
domain, skills, and tools. Tools depend on domain contracts and may call the
ignored THETA checkout. Hypha provides framework contracts to these layers.
Neither upstream checkout imports project code, and `domain` never depends on
tool implementations.

## Compute execution boundary

The Agent resolves an unspecified device through one compute policy before a
plan reaches THETA. The current policy is `local` execution with `cpu` as the
default. Canonical plans store the resolved device, and the Python runner
explicitly hides accelerators for CPU commands so upstream auto-detection
cannot change the approved plan. `GET /api/v2/runtime` exposes this safe
profile together with registry counts; the web UI only renders it.

Future scheduling belongs behind the compute backend boundary. A scheduler
adapter must own dispatch, cancellation, status, and artifact transport while
preserving the existing plan, approval, tool audit, and result contracts. An
unknown `THETA_COMPUTE_BACKEND` currently fails closed instead of silently
falling back to local execution.

New generic behavior is named for research concepts rather than THETA. A new
execution backend is added through registered tools and skills instead of by
expanding the CLI.

## Registration lifecycle

`agent/src/bootstrap.ts` is the composition root. Startup creates the Hypha
`ToolRegistry`, loads the project and Hypha `SkillRegistry` entries, registers
the domain pack, and fails if the domain references an unknown tool or skill.
`npm run test:registries` provides a standalone registration smoke test.

## Upstream lifecycle

`config/upstreams.lock.json` records the repository, tracking branch, reviewed
revision, local directory, and license for each standard upstream.
`scripts/upstreams.mjs` provides four operations:

- `ensure` clones the latest tracking-branch revision only when a checkout is
  missing, leaves an existing checkout untouched, and reports its status
  against the reviewed pin.
- `sync` materializes the exact reviewed revisions.
- `update` advances clean local checkouts and rewrites the pins for review.

An upstream update is complete only after the registry test, project build,
Python tests, and an end-to-end dry run pass. Never commit `third_party/`
content.

## Extension contract

A future research capability should provide:

- capability cards and evidence sources;
- Hypha skill definitions;
- governed tool definitions and permission scopes;
- deterministic validation and execution boundaries;
- result normalization for the common presentation layer;
- focused tests and fixtures.

It should reuse the Agent conversation, approval, storage, audit, and runtime
services.
