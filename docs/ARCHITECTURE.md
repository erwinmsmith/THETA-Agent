# Architecture

## Product boundary

THETA Agent is a conversational auto-research agent. Its durable product
boundary is the research loop: understand intent and data, gather evidence,
propose a plan, obtain approval, execute governed tools, monitor progress, and
explain results. A statistical model repository is an execution dependency,
not the center of the application.

## Layer model

```text
CLI / future API surfaces
          |
Conversation and research orchestration
          |
Planning, evidence, policy, approvals, memory, and runtime
          |
Research-domain contracts and governed tools
          |
THETA adapter             Future domain adapters
          |
Local upstream engines and infrastructure
```

The current code has four concrete ownership areas:

1. `apps/cli` owns terminal I/O, conversation, intent clarification, planning,
   policy, approvals, evidence retrieval, orchestration, and presentation.
2. `packages/THETA_tools` owns the narrow JSON protocol between the
   TypeScript agent and the THETA Python engine.
3. `third_party/Hypha` supplies the governed agent runtime and tool contracts.
4. `third_party/THETA` supplies model training, evaluation, and visualization.

The last two directories are ignored local checkouts. The repository owns only
their reviewed version pins and integration adapters.

## Dependency direction

Product surfaces may depend on reusable agent services. Agent services may
depend on domain contracts. A domain adapter may depend on an upstream engine.
The inverse dependencies are forbidden: upstream code must not import project
code, and reusable agent services must not acquire THETA-specific behavior.

New generic behavior should be named for research concepts rather than THETA.
New model-specific behavior belongs behind the THETA domain boundary. This
rule enables another domain to reuse the agent without emulating THETA paths,
commands, or data structures.

## Upstream lifecycle

`config/upstreams.lock.json` is the reproducibility contract. It records the
repository, tracking branch, reviewed revision, local directory, and license
for each standard upstream. `scripts/upstreams.mjs` provides four operations:

- `ensure` clones the latest tracking-branch revision only when a checkout is
  missing and leaves existing checkouts untouched.
- `status` compares local checkouts with the reviewed pins.
- `sync` materializes the exact reviewed revisions.
- `update` advances local checkouts to the tracking branches and rewrites the
  pins for review.

An upstream update is complete only after agent contract tests, THETA tools tests,
and an end-to-end dry run pass. Never commit `third_party/` content.

## Extension contract

A future research domain should provide:

- a capability catalog and evidence sources;
- governed tool definitions and permission scopes;
- deterministic plan validation and execution boundaries;
- a tools adapter to its execution engine;
- result normalization for the common presentation layer;
- domain-specific tests and fixtures.

It should reuse the shared conversation, approval, storage, audit, and runtime
services. As the second domain is introduced, those reusable services should
move from `apps/cli` into explicitly domain-neutral packages based on proven
shared contracts rather than speculative abstractions.
