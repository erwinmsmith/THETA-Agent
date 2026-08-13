# Architecture

## Product boundary

THETA Agent is a conversational auto-research agent. Its durable product
boundary is the research loop: understand intent and data, gather evidence,
propose a plan, obtain approval, execute governed tools, monitor progress, and
explain results. Topic modeling is the first capability, not the identity of
the application.

## Layer model

```text
CLI / API adapters
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
   Hypha built-ins directly from the ignored checkout.
5. `knowledge` owns evidence manifests and model capability cards.
6. `apps/cli` and `apps/api` are thin input/output adapters.
7. `third_party/Hypha` and `third_party/THETA` are the two standard upstream
   checkouts and remain ignored.

There is one Hypha checkout. File dependencies and the skill loader both refer
to that same ignored directory; no Hypha source is duplicated in the project.

## Dependency direction

Applications depend only on the public Agent API. Agent services compose the
domain, skills, and tools. Tools depend on domain contracts and may call the
ignored THETA checkout. Hypha provides framework contracts to these layers.
Neither upstream checkout imports project code, and `domain` never depends on
tool implementations.

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
