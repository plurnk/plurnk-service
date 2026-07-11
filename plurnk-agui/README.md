# @plurnk/plurnk-agui

The plurnk daemon's **transport daughter**: owns the client interface, serving
**AG-UI+** — the [Agent-User Interaction Protocol](https://docs.ag-ui.com) plus plurnk
metadata extensions — as the **sole** client interaction surface. Any AG-UI frontend
(CopilotKit, community UIs, the plurnk CLI/TUI/nvim clients) is a plurnk client.
Vendor-agnostic, MIT.

## Topology

An **in-process module** of the daemon, not an external service: the daemon activates it
at boot (`daemon.registerModule(Module.init(opts))`), handing it the curated core seam
(event source, loop-control, op dispatch, journal/metadata reads, proposal HITL,
session lifecycle — plurnk-service#355). The module opens its own HTTP/SSE listener and
owns the transport+security line at that edge: bearer auth, per-session authorization,
input validation. Below the seam: plurnk terms (loop/turn/proposal). Above: AG-UI terms
(run/message/tool-call/state). This module is the translation.

## The interface (AG-UI+)

One endpoint: `POST /` with `RunAgentInput` (`threadId`, `runId`, `messages`,
`forwardedProps`) → `text/event-stream` of AG-UI events.

- **Runs**: turns are `STEP_*`; PLAN is `THINKING_TEXT_MESSAGE_*`; SEND bodies are
  `TEXT_MESSAGE_*`; every other op row is a `TOOL_CALL_*` triple + `TOOL_CALL_RESULT`.
  Numbers pass through verbatim (`contextSize` = the daemon's effective prompt budget).
- **HITL, terminate-resume**: a stopped-world proposal (file edit, exec, MCP auth) emits
  a `request_approval` tool-call — a `SEND[300]` operator question emits
  `request_user_input` — and the run **finishes** while the loop stays paused in-engine.
  The next run's tool-result message (`toolCallId: "prop:<id>"`, content
  `{decision: accept|reject|cancel, body?}`) resolves it; the continued loop streams there.
  Pending proposals re-surface on (re)connect — a days-old question is discoverable.
- **Reads ride STATE**: providers/aliases/budget/session arrive as `STATE_SNAPSHOT` on
  `RUN_STARTED` and `STATE_DELTA` on change — observed, not polled.
- **The session is the WORLD**: `forwardedProps.plurnk.session` selects the workspace by
  name, verbatim (attach-or-create). It is REQUIRED — a run has no existence without a world,
  so its absence is rejected (500), never forged from the `threadId`. Session options ride the workspace's first run:
  `forwardedProps.plurnk` (`projectRoot`, `constraints`, `settings`); per-run knobs
  (`maxTurns`, `flags`, `alias`/`model`) every run.
- **The thread is the CONVERSATION**: a `threadId` binds a run over the selected world —
  today the session's model run (`ensureModelRun`), so extended context persists across runs;
  history replays as `MESSAGES_SNAPSHOT` on reattach. Distinct second conversations over one
  world gate on plurnk-service#366. (Machine model: service SPEC §machine-processes.)
- **Cancel**: dropping the SSE aborts a live loop (hangup is the abort); a
  proposal-terminated run leaves the paused loop for the resume.
- **Tier 2 metadata** (`CUSTOM plurnk.*`: row, stream, telemetry, terminated) carries
  what AG-UI has no term for — fold state, coordinates, tags, token truth. Generic
  frontends skip it; family clients render it richly. The full contract: `SPEC.md`
  (every `{§}` anchor cited by a test).

## Consume

```ts
import { Module } from "@plurnk/plurnk-agui";
daemon.registerModule(Module.init({ host: "127.0.0.1", port: 3044 }));
// The daemon reads PLURNK_HOST/PLURNK_PORT: plurnk has ONE client surface, this listener.
```

## Dependencies

**Zero at runtime — no Zod, no SDK.** The AG-UI event shapes are hand-defined plain TS
(the official `@ag-ui/core` is 0.0.x and would drag Zod in, so it is deliberately NOT a
dependency). If the official SDK ever stabilizes dependency-free, adopting it is a
types-only swap.
