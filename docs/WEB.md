# Web Conversational Interface

THETA Agent ships a conversational research workspace under `apps/web`. Its
interaction patterns are adapted from the DeepSeek Harness UI framework (MIT,
see `apps/web/THIRD_PARTY_NOTICES.md`), while all product branding and workflow
behavior are THETA-specific. The app remains a thin presentation adapter:
every action is submitted to the governed THETA 2.0 API and every approval
gate stays enforced by the domain FSM.

## Run

```bash
npm run build        # builds web + cli + api
npm run start:api    # serves the app at http://127.0.0.1:4318/ (UI + API)
```

The API server serves `apps/web/dist` on the same origin, so the UI and
`/api/v2/*` share one port. During frontend development:

```bash
pnpm --filter @theta-agent/web run dev   # Vite dev server on 5173
pnpm --filter @theta-agent/web run typecheck
```

## Layout

- **Top** — current task, compute backend/device, live-stream health, and the
  global inference provider and model selector. DeepSeek is selected when the
  default environment is configured; unavailable providers are visible but
  disabled.
- **Left** — research run catalog with automatic restoration, status, current
  state, relative update time, create, and delete actions.
- **Center** — conversational thread: user messages and assistant responses
  rendered as markdown (GFM + TeX math + code highlighting). The pending
  human gate renders inline above the composer as a structured card selected
  by the backend FSM interaction contract:
  dataset understanding confirmation (per-column roles), research intent
  confirmation, plan approval with degradation opt-in, training start
  approval. Natural-language correction works alongside the forms.
- **FSM trace** — the thread shows the current state goal, observation,
  selected decision, allowed Tools, candidate transitions, and recent governed
  reasoning events. This is a concise decision record, not hidden model
  chain-of-thought.
- **Right** — detail panel with four synced tabs:
  - `状态` status presentation, progress, state path, next actions
  - `工具` governed tool-call trace (phase, tool id, payload inspector)
  - `推理` decision-gap Q&A history, intent summary, model recommendation,
    plan rationale, reasoning-typed events
  - `事件` full runtime event stream with expandable payloads

`新建研究任务` can reuse a registered dataset or upload CSV, TSV, JSON,
JSONL, TXT, Excel, or Parquet. The creation dialog accepts a research goal and
can opt into deterministic planning. On narrow screens the catalog and run
inspector become mutually exclusive drawers so the agent thread stays usable.
When no Run is active, the FSM `Intake` interaction automatically renders the
same dataset-upload capability as the primary Agent card.

Live updates arrive through the SSE stream
(`GET /api/v2/runs/:id/stream`); the client falls back to polling after
reconnects.

## API surface used by the frontend

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v2/health` | full Agent, registry, upstream, Python, and storage diagnostics |
| `GET /api/v2/runtime` | safe compute policy and registered capability counts |
| `GET /api/v2/runs` | run catalog |
| `POST /api/v2/runs` | create a governed research run |
| `GET /api/v2/runs/:id` | detail bundle (status, identity, plan, results) |
| `DELETE /api/v2/runs/:id` | delete a local run and its result artifacts |
| `GET /api/v2/datasets` | registered dataset catalog |
| `POST /api/v2/datasets/upload` | validate, store, and register an upload |
| `GET/POST /api/v2/inference` | inspect or update the inference selection |
| `GET /api/v2/runs/:id/status` | status + dataset facts/understanding + research brief |
| `GET /api/v2/runs/:id/conversation` | message history |
| `POST /api/v2/runs/:id/messages` | natural-language turn (REPL orchestrator) |
| `POST /api/v2/runs/:id/actions` | governed approvals and corrections |
| `GET /api/v2/runs/:id/events` | runtime + tool events with payloads (`after=` cursor) |
| `GET /api/v2/runs/:id/reasoning` | reasoning bundle for the 推理 tab |
| `GET /api/v2/runs/:id/stream` | SSE live sync |

Contract types live in `agent/src/api/contracts.ts`; the web client mirrors
them in `apps/web/src/api/client.ts`. Keep both in sync when extending the
API.
