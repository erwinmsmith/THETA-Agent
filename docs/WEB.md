# Web Conversational Interface

THETA Agent ships a conversational web frontend under `apps/web`, styled with
the DeepSeek Harness UI framework (MIT, see `apps/web/THIRD_PARTY_NOTICES.md`).
It is a thin presentation adapter: every action is submitted to the governed
THETA 2.0 API and every approval gate stays enforced by the domain FSM.

## Run

```bash
npm run build        # builds web + cli + api
npm run start:api    # serves the app at http://127.0.0.1:4318/ (UI + API)
```

The API server serves `apps/web/dist` on the same origin, so the UI and
`/api/v2/*` share one port. During frontend development:

```bash
pnpm --filter @theta-agent/web run dev   # Vite dev server on 5173
```

## Layout

- **Left** — research run list (status dot, current state).
- **Center** — conversational thread: user messages and assistant responses
  rendered as markdown (GFM + TeX math + code highlighting). The pending
  human gate renders inline above the composer as a structured form:
  dataset understanding confirmation (per-column roles), research intent
  confirmation, plan approval with degradation opt-in, training start
  approval. Natural-language correction works alongside the forms.
- **Right** — detail panel with four synced tabs:
  - `状态` status presentation, progress, state path, next actions
  - `工具` governed tool-call trace (phase, tool id, payload inspector)
  - `推理` decision-gap Q&A history, intent summary, model recommendation,
    plan rationale, reasoning-typed events
  - `事件` full runtime event stream with expandable payloads

Live updates arrive through the SSE stream
(`GET /api/v2/runs/:id/stream`); the client falls back to polling after
reconnects.

## API surface used by the frontend

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v2/runs` | run catalog |
| `GET /api/v2/runs/:id` | detail bundle (status, identity, plan, results) |
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
