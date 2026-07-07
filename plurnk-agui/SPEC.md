# @plurnk/plurnk-agui — the projection contract

The bridge is **a client of the plurnk daemon and a server of AG-UI**: it consumes the same
JSON-RPC-over-WebSocket wire every plurnk client speaks, and emits the Agent-User Interaction
Protocol's SSE event stream. Zero daemon changes; the daemon's numbers and semantics pass
through, never recomputed. Every `{§}` anchor below is cited by a `[§]` test.

## Architecture

- **The bridge is an ordinary daemon client** {§agui-daemon-client} — it connects to
  `PLURNK_AGUI_DAEMON_URL`, calls the public methods (`session.create`/`session.attach`,
  `loop.run`, `loop.resolve`), and subscribes to the public notifications (`log/entry`,
  `loop/proposal`, `loop/terminated`). It holds no state the daemon doesn't: a bridge restart
  loses nothing (threads reattach by session name).
- **An AG-UI thread IS a plurnk session** {§agui-thread-is-session} — `threadId` maps to the
  session `<PLURNK_AGUI_SESSION_PREFIX>-<threadId>`, created on the thread's first run with
  `settings.questions` per `PLURNK_AGUI_QUESTIONS`, reattached on every run after. Plurnk's
  extended context persists across AG-UI runs because the session does.
- **Zero runtime dependencies** {§agui-zero-dep} — the AG-UI event shapes are hand-defined
  plain JSON (`src/types.ts`); the SSE encoding is `data: <json>\n\n`. The protocol is young;
  a zero-dep daughter beats tracking SDK churn, and adopting the official SDK later is a
  types-only swap.

## The projection {§agui-projection}

One daemon notification in, zero-or-more AG-UI events out (`Translator`, pure):

| plurnk wire | AG-UI events |
|---|---|
| `loop.run` accepted | `RUN_STARTED` |
| `log/entry` turn boundary | `STEP_FINISHED` + `STEP_STARTED` (`turn-<id>`) |
| `log/entry` op=PLAN (model) | `THINKING_TEXT_MESSAGE_START/CONTENT/END` |
| `log/entry` op=SEND (model) | `TEXT_MESSAGE_START/CONTENT/END` + `CUSTOM plurnk.send` (signal/status) |
| `log/entry` other op (model) | `TOOL_CALL_START/ARGS/END` (+ `TOOL_CALL_RESULT` when rx exists) |
| `log/entry` op=model (mirror) | nothing — forensic, not speech |
| `log/entry` origin≠model | `CUSTOM plurnk.ambient` (foists, deltas, narrations) |
| `loop/proposal` | `CUSTOM plurnk.proposal` |
| `loop/terminated` | `STATE_DELTA` (budget) + `RUN_FINISHED` (200) or `RUN_ERROR` (else) |

- **An op row IS a tool call** — its `coordinate` is the `toolCallId`, its tx the args (one
  delta: a dispatched plurnk op is atomic), its rx the result. The log-shaped richness the
  core vocabulary can't hold (fold state, tags, tokens) stays on the row inside
  `plurnk.ambient`/`TOOL_CALL_RESULT` payloads.
- **The custom namespace** {§agui-custom-namespace} — everything plurnk-specific rides
  `CUSTOM` events named `plurnk.*` (`plurnk.send`, `plurnk.ambient`, `plurnk.proposal`,
  `plurnk.telemetry`). Generic frontends skip unknown customs; plurnk-aware frontends render
  them richly. Nothing plurnk-specific ever masquerades as a core event.
- **Numbers pass through verbatim** {§agui-numbers-passthrough} — the budget `STATE_DELTA`
  carries the daemon's own usage figures (`contextTokens`, `contextSize` = the effective
  prompt budget, service#345). The bridge never recomputes a number; the daemon's gauge is
  the gauge.

## Stop-the-world {§agui-proposal-resolve}

Every daemon proposal — file edits, MCP auths, `[300]` operator questions (service#346) —
surfaces as `CUSTOM plurnk.proposal` carrying `{logEntryId, op, target, body, attrs, flags}`
(`attrs.question`/`attrs.choices` for questions). The frontend answers via
`POST /resolve {threadId, logEntryId, decision, body?}` — a passthrough to the daemon's
`loop.resolve`, where an accept `body` is the answer. The SSE stream stays open while the
world is stopped; the run resumes on resolution.

## The run endpoint {§agui-run-endpoint}

`POST /` (or `/agui`) with an AG-UI `RunAgentInput` body: the last `user` message becomes the
`loop.run` prompt (`maxTurns`/`flags.yolo` from env); the response is `text/event-stream`,
one `data:` line per event, ending after `RUN_FINISHED`/`RUN_ERROR`. Yolo never auto-answers
a question — that's the daemon's own rule; the bridge inherits it.
