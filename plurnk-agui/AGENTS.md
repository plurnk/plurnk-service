### Plurnk AG-UI — Project Grounding

The AG-UI bridge daughter: a CLIENT of the plurnk daemon's JSON-RPC wire (the same protocol
every plurnk client speaks — the daemon's contract, never redefined here) and a SERVER of the
Agent-User Interaction Protocol (SSE). The metaproject conventions (`../AGENTS.md`) apply in
full: exact pins, fail-hard, every knob in `.env.example`, node:test, no Zod.

Rules of this repo:
- **The Translator is pure and the projection is total**: one daemon notification in, AG-UI
  events out; anything the core vocabulary can't hold rides `CUSTOM plurnk.*` — never dropped,
  never masquerading as a core event. Numbers pass through verbatim (the daemon's gauge is
  the gauge).
- **The bridge holds no state the daemon doesn't.** threadId → session-name mapping is
  reconstructible (`session.attach` by name); a bridge restart loses nothing.
- **SPEC.md is the contract** — every `{§}` anchor cited by a `[§]` test (service-style
  lockstep, enforced by review until a lockstep test lands: see the worksheet).
- Zero runtime deps is a standing decision, not an accident (§agui-zero-dep) — revisit only
  when @ag-ui/core reaches stability without Zod.

# The Exclusive-Portal Charter (owner, 2026-07-07)

The goal: cli, tui, and nvim all connect THROUGH this bridge — AG-UI as the one client portal,
plurnk-specific fidelity as metadata on the standard channels. The posture: what makes plurnk
special is the ENGINE; the client surface is the standard protocol; minimal first-party
frontends, the community carries the rest. Two planes, ruled:

- **The RUN plane is AG-UI** — runs, messages, tool calls, steps, state, proposals. Fully
  standard; rich fidelity rides `plurnk.row` and the `plurnk.*` customs (§agui-row-channel).
- **The MANAGEMENT plane is one escape hatch** — sessions (projectRoot, constraints, settings),
  entry CRUD (op.edit/op.read for nvim's direct known:// editing), providers/model switching,
  auth flows. AG-UI does not model a workspace; these ride ONE passthrough endpoint
  (`POST /plurnk/rpc`, JSON-RPC over HTTP to the daemon) — boring, thin, documented, and the
  ONLY non-standard client surface. First-run session options may also ride
  `RunAgentInput.forwardedProps.plurnk` (the spec's sanctioned side-channel).

Accepted costs, stated so nobody relitigates them silently: turn-granular streaming (plurnk
turns are ATOMIC by doctrine — no token-level typing UX, this is identity not defect);
AG-UI's youth (churn isolated to Translator/types — one file each); dual surfaces during the
client migration (bridge reaches parity FIRST, then clients move one at a time, then the raw
WS narrows to bridge-only).

# Worksheet — parity gaps toward the exclusive portal, in order
- [ ] MESSAGES_SNAPSHOT on thread attach — replay the session log as AG-UI history so a
      reconnecting/late frontend starts oriented (the TUI-reattach case; the daemon log is the
      source of truth, synthesize from it).
- [ ] `POST /plurnk/rpc` — the management-plane passthrough (with the daemon's auth riding).
- [ ] `forwardedProps.plurnk` → session.create options (projectRoot, settings, constraints)
      on a thread's first run.
- [ ] Concurrent-run policy per thread: second POST while a run is live → loop.inject vs 409
      (today: undefined — decide, document, test).
- [ ] Frontend TOOLS (RunAgentInput.tools) → an ephemeral exec runtime whose calls stop the
      world like proposals — the model gains client-side tools through the standard field.
      (Design with the execs agent; the biggest unlock, the least defined.)
- [ ] Worker-run topology: scope the core projection to the started run; workers surface as
      `plurnk.topology` customs (AG-UI has no multi-agent-tree vocabulary).
- [ ] Auth on the bridge port (the daemon's #116 relay exists; the bridge must not be the
      unauthenticated hole).
- [ ] loop/quiesced + stream/concluded + embed_progress → plurnk.* customs (today unsubscribed).
- [ ] AG-UI native interrupt mapping for proposals (today: CUSTOM plurnk.proposal + POST /resolve).
- [ ] Reconnect/backoff on daemon restart (today: fail-hard, the operator restarts the bridge).
- [ ] Lockstep test (spec-anchors style, port from plurnk-service).
- [ ] Live round-trip with a real AG-UI frontend (CopilotKit dev harness).
- [ ] Owner decision: which agent inherits this repo (client agent is the natural neighbor).
