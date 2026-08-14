# Web Research Workspace

`apps/web` is the conversation-first interface for THETA Agent. It is a thin
adapter over the governed API: the backend owns semantic routing, FSM state,
tool policy, memory, approvals, and result contracts. The browser never selects
a Tool by matching words in a message.

## Run

```bash
npm run deps:ensure  # verify or clone missing upstream dependencies
npm run build
npm run start:api    # UI and API: http://127.0.0.1:4318/
```

For frontend development, run the API and Vite separately:

```bash
npm run start:api
VITE_THETA_API_BASE=http://127.0.0.1:4318 \
  pnpm --filter @theta-agent/web run dev
```

The API permits the standard local Vite origins. Add nonstandard development
origins explicitly with `THETA_WEB_ALLOWED_ORIGINS`; do not use a wildcard.

## User experience

- **Start page:** begins as a local blank draft with suggested prompts. Its
  SQLite session is created lazily on the first message, and upload is shown
  only after the Agent's schema-validated semantic decision requests data.
- **Composer:** keeps grouped provider, model, and reasoning-type selection
  beside the message field. Its footer reports cumulative provider-reported
  input/output tokens for the current conversation. New messages can queue
  while the active turn is being processed.
- **History:** draft conversations and research Runs persist in SQLite and can
  be reopened, pinned, renamed, or deleted. These actions use in-app dialogs;
  deleting any history item returns the workspace to the start page.
- **Human checks:** dataset, intent, plan, and training approvals appear as a
  compact accept/reject bar. Rejections may include a reason.
- **Activity:** the thread shows FSM decisions, semantic routing, search,
  governed Tool phases, and result summaries. Expand an item to inspect its
  sanitized input/output. These records are auditable summaries, not private
  model chain-of-thought.
- **Results:** visualizations, topic tables, and metrics open in the right
  sidecar. They can be attached to a follow-up question or downloaded together
  as a `tar.gz` archive.
- **Preferences:** Chinese/English and light/dark/system themes persist locally.
- **Model settings:** the top-bar settings center configures the LLM endpoint,
  write-only API key, reasoning effort, token/temperature limits, timeout,
  provider streaming, and typewriter rendering. Optional embedding settings
  are a separate section and are never confused with THETA training models.

## Model streaming and secrets

OpenAI-compatible providers implement real SSE response parsing and expose
streaming/reasoning capabilities in the provider catalog. Supported text call
paths may consume those deltas; schema-constrained Agent decisions remain
buffered until validation. The conversation UI incrementally reveals each new,
governance-validated answer. FSM decisions and Tool events stream independently
through the Run event channel; private model chain-of-thought is never displayed.

Web-saved settings live in ignored `.theta_agent/inference-settings.json` and
secrets in `.theta_agent/inference-secrets.json`. Both use private `0600`
permissions. The API returns only `apiKeyConfigured`; it never returns a key.
Leaving a key field blank preserves the saved value. Saving settings does not
test or call the provider.

## Persistence and memory

SQLite stores conversation sessions, messages, titles, research brief
revisions, and a compact working-memory projection. The projection records a
summary, recent user goals, message count, and refresh time. Research Runs also
retain the structured interview and evidence revisions used by the FSM. This is
local application memory; semantic/vector long-term memory is not yet shipped.

## Main API surface

| Endpoint | Purpose |
| --- | --- |
| `GET/POST /api/v2/workspace/sessions` | list or create draft conversations |
| `PATCH/DELETE /api/v2/workspace/sessions/:id` | rename or delete a draft |
| `GET /api/v2/workspace/sessions/:id/conversation` | messages, memory, interaction |
| `POST /api/v2/workspace/sessions/:id/messages` | semantic pre-Run conversation |
| `GET/POST /api/v2/runs` | list or create governed Runs |
| `GET/PATCH /api/v2/inference/settings` | read safe model settings or update private local configuration |
| `PATCH/DELETE /api/v2/runs/:id` | rename or delete a Run |
| `GET /api/v2/runs/:id/conversation` | read Run messages and memory |
| `POST /api/v2/runs/:id/messages` | continue a Run or analyze attached results |
| `POST /api/v2/runs/:id/actions` | governed accept/reject/correction actions |
| `GET /api/v2/runs/:id/reasoning` | decision and Tool activity bundle |
| `GET /api/v2/runs/:id/stream` | live status, messages, and event updates |
| `GET /api/v2/runs/:id/results/archive` | download normalized result artifacts |

The shared server serves `apps/web/dist` on the API origin. Contract types live
in `agent/src/api/contracts.ts` and are mirrored in `apps/web/src/api/client.ts`.
