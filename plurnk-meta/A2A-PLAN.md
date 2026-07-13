# A2A adaptation plan (owner-instigated, 2026-07-13)

The fourth standards leg: AG-UI serves frontends, OpenAI-compat speaks to models, MCP consumes tools, **A2A peers with agents**. Pace ruling: **SLOW** — this job carries paradigm risk; every phase ends at a discussion checkpoint, and the tripwires below stop work on contact.

## Verified protocol facts (2026-07-13)
A2A v1.0 stable, Linux Foundation governed. JSON-RPC 2.0 over HTTP(S); SSE streaming; webhook push. Signed Agent Cards at `/.well-known/agent-card.json` (skills, MIME types, transports, security schemes). Task lifecycle: `submitted -> working -> {completed, failed, canceled, rejected}` plus pause states `input-required` / `auth-required`. Primary verb is `message/send` — tasks are created BY sending; there is no separate create.

## The mapping (the deep fit)
A2A tasks are plurnk runs wearing a wire format — the delegation breath (spawn, await, pending-set, artifacts-as-entries) already exists internally. The adaptation is translation at two edges, never internal change.

**Outbound (plurnk delegates), via the `a2a://` scheme:**
- `SEND a2a://<host>` — creates: message/send; server mints the task; scheme mints the entry `a2a://<host>/<taskId>`.
- `SEND` to the entry — continues the task / answers `input-required`.
- `READ a2a://<host>` — the agent card, rendered as an entry (the model reads peer capabilities).
- `READ` the entry — status + artifacts.
- `KILL` the entry — cancel.
- SSE/push feeds the same wake path exec results use. Four ops, contract-native bodies (SendBody / matcher), zero grammar change.

**Inbound (plurnk serves), via the `plurnk-a2a` module:**
- In-process daemon module (transport belongs to modules), serving the A2A JSON-RPC surface + the well-known card.
- An inbound task becomes a run in the REGISTERED LISTENER SESSION (owner ruling 3): a session opts in by registering as the a2a listener; no registration = inbound refused. Registration is a session-level RPC in the session.constrain family (core seam - negotiate, do not improvise).
- Artifacts = the run's entries/channels, translated outbound by the module.
- The agent card is GENERATED from the live capability surface (registered schemes, available exec census — the same truth the tools sheet reads), never hand-maintained.

## Owner rulings (2026-07-13)
1. Outbound scheme = **`plurnk-schemes-a2a`**, in-bundle (not optional).
2. Inbound = **`plurnk-a2a`** workspace — a transport peer beside plurnk-agui; folding INTO plurnk-agui stays open as an implementing-lane assessment.
3. **Session registers as a2a listener; inbound tasks land in that session.** No new session semantics — a registration, not a redefinition.
4. Gating: **yolo server = ungated; non-yolo = proposal-gated** via the existing machinery (design below).
5. **Internal contract vocabulary is never bent toward A2A's.** WORK stays plurnk's WORK. Translation lives in the scheme/module only.
6. **Slow.** Checkpoints between phases; paradigm tripwires halt.

## Gating design (the "but how", proposed 2026-07-13)
Inbound-task runs execute ops normally; host-effecting ops PROPOSE exactly as today; proposals surface on the registered session's normal pending surface, where the OPERATOR (through their usual client) accepts or rejects. The remote peer is never an approver of host effects: it sees `working` throughout — gating is internal policy, not peer business. A hold-timeout knob fails an unattended proposal with a policy-shaped message (structure, never menus). Yolo = the daemon's existing auto-accept posture, inherited; A2A never forks policy. Later phase: per-peer trust via signed cards + `PLURNK_A2A_*` allowlist knobs (reader-declares).

## Paradigm tripwires (named disasters — stop and surface on contact)
- Any pressure to OVERLOAD WORK (e.g. `WORK(a2a://...)`) — deferred deliberately; only dogfooding evidence reopens it, via grandma negotiation.
- Any change to WHAT A SESSION IS or does beyond carrying a registration.
- Any internal rename/reshape to mirror A2A vocabulary.
- Any grammar/protocol schema change — none is planned; the appearance of one means the design drifted.

## Phases (checkpoint = owner discussion before the next begins)
1. **`plurnk-schemes-a2a`, read-only**: card fetch + task status/artifact READs against a reference A2A server. Proves the scheme shape and teach doc. *(schemes lane — idle now, can start on blessing.)*
2. **Outbound lifecycle**: SEND-create, continue, input-required answering, KILL-cancel, SSE/push wake integration.
3. **`plurnk-a2a` inbound**: module + generated card + session-registration seam (with core), proposal-gated per design above.
4. **Trust**: signed-card verification, per-peer allowlist, auth-required flows.

## Status
Plan prepared; NOTHING filed to lanes yet — awaiting owner blessing of this document, then phase-1 issue to the schemes lane.
