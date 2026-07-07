# @plurnk/plurnk-agui

The [AG-UI](https://docs.ag-ui.com) bridge for the plurnk daemon: **a client of the plurnk
JSON-RPC wire, a server of the Agent-User Interaction Protocol.** Any AG-UI frontend
(CopilotKit, community UIs) becomes a plurnk client — zero daemon changes.

## Run

```sh
npm i -g @plurnk/plurnk-agui   # or npx
plurnk-agui                     # fronts ws://127.0.0.1:3044, listens on :3080
```

Config is `.env` over the shipped `.env.example` (every knob documented there).

## The surface

- `POST /` — the AG-UI run endpoint. Body: `RunAgentInput` (`threadId`, `messages`).
  Response: `text/event-stream` of AG-UI events until `RUN_FINISHED`/`RUN_ERROR`.
- `POST /resolve` — answers a stop-the-world proposal: `{threadId, logEntryId, decision, body?}`.
  File-edit approvals, MCP auths, and `SEND[300]` operator questions all arrive as
  `CUSTOM plurnk.proposal` events; an accept `body` is the question's answer.
- An AG-UI `threadId` **is** a plurnk session — extended context persists across runs.

## The projection

Turns are `STEP_*`; the model's PLAN is `THINKING_TEXT_MESSAGE_*`; SEND bodies are
`TEXT_MESSAGE_*`; every other op row is a `TOOL_CALL_*` triple with its rx as
`TOOL_CALL_RESULT`; budget truth rides `STATE_DELTA` (`contextSize` = the daemon's effective
prompt budget — numbers pass through verbatim, never recomputed). Plurnk-specific richness
(fold state, ambient rows, proposals, telemetry) rides namespaced `CUSTOM plurnk.*` events —
generic frontends skip them, plurnk-aware frontends render them richly. The full contract:
`SPEC.md` (every `{§}` anchor cited by a test).

## Dependencies

Zero at runtime. The AG-UI event shapes are hand-defined plain JSON: `@ag-ui/core` is 0.0.x
and carries Zod, so the types live here until the official SDK stabilizes — adopting it later
is a types-only swap. MIT, vendor-agnostic, same as the rest of the plurnk family.
