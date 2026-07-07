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

# Worksheet
- [ ] Lockstep test (spec-anchors style, port from plurnk-service).
- [ ] Live round-trip against a real daemon + a real AG-UI frontend (CopilotKit dev harness).
- [ ] AG-UI native interrupt mapping for proposals (today: CUSTOM plurnk.proposal + POST /resolve).
- [ ] Reconnect/backoff on daemon restart (today: fail-hard, the operator restarts the bridge).
- [ ] Owner decision: which agent inherits this repo (client agent is the natural neighbor).
