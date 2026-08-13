# Conversational Agent Contracts

## Execution Boundary

The conversational path is:

```text
CLI / REPL
  -> ConversationService
  -> ThetaTurnOrchestrator
  -> ThetaConversationWorkflowExecutor
  -> ThetaWorkflowService
  -> Hypha bounded FSM driver
  -> state-scoped GovernedToolRunner
  -> THETA_tools
```

The conversation layer routes input and formats output. Canonical Run state is
derived from Runtime events.

## Persisted Records

The selected Runtime SQLite database stores:

- conversation sessions and active Run references;
- user and assistant messages;
- structured turn interpretations;
- recoverable turn metadata;
- immutable `ResearchBrief` revisions.

These records support conversation recovery but do not replace Run events.
Replay reads canonical events only and does not call a language-model provider or execute tools.

## Field Authority

System-observed dataset identity, columns, hashes, and execution receipts
cannot be overwritten by language output. User-provided research intent and
constraints are merged through explicit field-authority rules. Conflicts stay
visible until resolved.

## FSM Routing

Normal text is routed according to the persisted FSM state:

- `ResearchClarification`: interpret a research answer;
- `ColumnConfirmation`: interpret column roles;
- other states: allow only bounded read intents such as status, evidence,
  local RAG search, and model catalog.

The language component cannot choose an arbitrary transition or tool. Tool
proposals must be present in the state allowlist and pass schema, permission,
policy, approval, trace, and Harness checks.

## Recovery

Each turn records enough metadata to identify interrupted work. Restarting the
CLI restores the conversation session and active Run reference. Workflow
recovery then derives the current state from events; unknown execution state
is quarantined instead of guessed or restarted.
