### Plurnk AG-UI — Project Grounding

**Steward: the client agent (@plurnk/plurnk)** — inherited 2026-07-08 from the plurnk-service steward that built the bridge to parity (plurnk-agui#1). The two open worksheet items (Frontend TOOLS, AG-UI interrupt mapping) and the client-migration phase are the incoming owner's to drive.

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
- [x] MESSAGES_SNAPSHOT on thread attach — shipped (§agui-replay): the model run's SENDs via
      session.runs + log.read; pending proposals re-surface via proposal.list. Live-proven
      across a bridge restart.
- [x] `POST /plurnk/rpc` — shipped (§agui-management-plane), gated by §agui-auth.
- [x] `forwardedProps.plurnk` → shipped (§agui-forwarded-props): projectRoot, constraints,
      settings on the thread's first run, composing over the bridge's questions default.
- [x] Concurrent-run policy: ruled mechanism-not-policy — the daemon's own loop.run semantics
      (inject/enqueue) apply; the bridge adds no queueing (SPEC).
- [ ] Frontend TOOLS (RunAgentInput.tools) → an ephemeral exec runtime whose calls stop the
      world like proposals — the model gains client-side tools through the standard field.
      (Design with the execs agent; the biggest unlock, the least defined.)
- [x] Worker-run topology: shipped (§agui-topology-scope) — foreign runs ride
      plurnk.row/ambient; a worker's SEND never masquerades as the assistant.
- [x] Auth on the bridge port: shipped (§agui-auth) — bearer token, empty = local trust.
- [x] loop/quiesced + stream/concluded → plurnk.quiesced/plurnk.stream customs (telemetry already rode plurnk.telemetry).
- [ ] AG-UI native interrupt mapping for proposals (today: CUSTOM plurnk.proposal + POST /resolve).
- [x] Reconnect: RULED fail-hard by design (SPEC) — the bridge is stateless, reattach
      reconstructs threads by name, and a dead daemon should look dead.
- [x] Lockstep test: shipped — three legs (promises cited, citations resolve, comment refs never rot); caught five uncited promises + its own title on first run.
- [x] A zero-dep reference frontend shipped (demo/index.html — fetch + SSE, nothing else): runs, thinking, tools, budget gauge, proposal chooser with free response. CopilotKit round-trip remains a community-side validation.
- [x] Owner decision: RESOLVED 2026-07-08 — the client agent (@plurnk/plurnk) inherits this repo (plurnk-agui#1). It owns the three frontends the bridge becomes the portal for; ownership converges on the agent that migrates them. Transition executed by the outgoing service steward.
