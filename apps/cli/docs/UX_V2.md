# CLI Interaction Contracts

## Purpose

The default THETA CLI presents research and training decisions in concise
Chinese. Machine contracts remain available through `--json`; the interactive
REPL exposes the previous machine response through `/details`.

## Interaction Model

The REPL is a presentation surface over persisted services. It may:

- accept natural-language research and column answers;
- render the current FSM state, explanation, warning, and next action;
- show recommendations, plans, training progress, logs, and results;
- request explicit plan and training decisions.

It must not:

- infer or mutate canonical FSM state locally;
- treat language consent as plan or training approval;
- call Python or provider APIs directly;
- bypass Tool policy, approval, trace, or Harness hooks.

## Response Shape

Human-facing responses are assembled from structured values:

- `title`: current task or decision;
- `summary`: concise outcome grounded in Runtime state;
- `details`: bounded evidence, parameters, or progress;
- `warnings`: risks that require attention;
- `nextAction`: one executable or confirmable next step;
- `rawValue`: machine response available through `/details`.

Errors use the same presentation boundary and include a concrete recovery
action when one is known.

## Human Decisions

Research clarification and column confirmation are FSM waits, not write
approvals. Plan creation and training start are separate decisions with
different receipts. Repeating a decision requires the current persisted wait
to match the requested action.

## Language Assistance

MiniMax is optional. `/llm on` records consent for the persisted conversation
session, while `/llm off` revokes it. Language output is schema-validated and
advisory. Invalid, unavailable, or out-of-scope output falls back to
deterministic interpretation without changing Runtime authority.
