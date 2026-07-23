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
- An inbound task becomes a worker in the REGISTERED LISTENER SESSION (owner ruling 3): a workspace opts in by registering as the a2a listener; no registration = inbound refused. Registration is a workspace-level RPC in the workspace.constrain family (core seam - negotiate, do not improvise).
- Artifacts = the worker's entries/channels, translated outbound by the module.
- The agent card is GENERATED from the live capability surface (registered schemes, available exec census — the same truth the tools sheet reads), never hand-maintained.

## Owner rulings (2026-07-13)
1. Outbound scheme = **`plurnk-schemes-a2a`**, in-bundle (not optional).
2. Inbound = **`plurnk-a2a`** workspace — a transport peer beside plurnk-agui; folding INTO plurnk-agui stays open as an implementing-lane assessment.
3. **Workspace registers as a2a listener; inbound tasks land in that workspace.** No new workspace semantics — a registration, not a redefinition.
4. Gating: **auto server = ungated; non-auto = proposal-gated** via the existing machinery (design below).
5. **Internal contract vocabulary is never bent toward A2A's.** WORK stays plurnk's WORK. Translation lives in the scheme/module only.
6. **Slow.** Checkpoints between phases; paradigm tripwires halt.

## The admission model IS the spec (owner correction, 2026-07-13)
`PLURNK_A2A_ALLOW` is not a phase-4 add-on — it is the FOUNDATION every other phase obeys. "An inbound task arrives" is undefined until "from whom, and may they" is answered, so the trust model is designed FIRST and read-only outbound conforms to it too. Deferring it = an implicit trust-everyone default = the confused pattern. Corrected.

**Two gates, cleanly separated (the clarity that was missing):**
- **ADMISSION — who may land a task here at all.** Governed by `PLURNK_A2A_ALLOW`. FAIL-CLOSED: empty allow = inbound refused entirely (the daemon still SERVES its card — discoverable — but accepts zero tasks). No implicit trust, ever.
- **EFFECT — what an admitted task's ops may do.** Governed by the existing proposal machinery (owner ruling 4): auto workspace = auto-accept posture inherited from the daemon; non-auto = host-effecting ops PROPOSE on the registered workspace's normal pending surface, where the OPERATOR accepts. The remote peer is never an approver of host effects — it sees `working` throughout; effect-gating is internal policy, not peer business. Hold-timeout knob fails an unattended proposal with a policy-shaped message (structure, never menus).

**The four trust layers (inbound):**
1. **Transport auth** — the card's `securitySchemes` declares what credential a peer must present to reach us (bearer / API key / OAuth / mTLS). Operator infra call.
2. **Identity** — JWS-signed card (RFC 7515 / JCS 8785); the verified issuer domain is the peer's provable identity. UNSIGNED CARDS ARE REFUSED (unsigned = the impersonation hole A2A v1.0 closed).
3. **Admission** — `PLURNK_A2A_ALLOW`: which verified identities may land tasks, into which registered workspace, under which effect posture. A decision table (the-knob-is-the-decision-table), reader-declared, operator-editable, one line per trusted peer.
4. **Effect** — per the two-gates split above.

Admission keys on the VERIFIED CARD ISSUER, never network origin (IP/host is spoofable; the JWS signature is not). A workspace registering as an a2a listener (ruling 3) and an allow entry naming that workspace are two halves of one handshake: a workspace opts IN to listening, the allow table says WHICH peers reach it.

**Open forks (owner's call — the substance to sort NOW, before phase 1):**
- **A. Allow entry shape** — bind `(verified-issuer, workspace, effect-posture)` as one triple per peer, or split into separate knobs? (Lean: the triple — "who may do what where" is one decision.)
- **B. Signed-card requirement** — confirm unsigned peers are refused outright. (Lean: yes.)
- **C. Inbound transport auth we advertise** — bearer token (simplest over the tunnel), or mTLS (peer identity at transport, strongest), or both offered? (Owner infra call.)
- **D. Outbound egress** — do we allowlist which peers we will DELEGATE to (task content leaves the box), or is that per-call operator discretion? (Genuine open question — the dangerous direction is usually inbound, but egress is real.)
- **E. Empty-allow behavior** — serve the card but accept nothing (discoverable, closed), vs serve nothing. (Lean: serve card, accept nothing.)

## Paradigm tripwires (named disasters — stop and surface on contact)
- Any pressure to OVERLOAD WORK (e.g. `WORK(a2a://...)`) — deferred deliberately; only dogfooding evidence reopens it, via grandma negotiation.
- Any change to WHAT A SESSION IS or does beyond carrying a registration.
- Any internal rename/reshape to mirror A2A vocabulary.
- Any grammar/protocol schema change — none is planned; the appearance of one means the design drifted.

## Phases (checkpoint = owner discussion before the next begins)
0. **The admission model** (THIS section, foundation): forks A-E ruled; `PLURNK_A2A_ALLOW` shape settled; JWS verification + the fail-closed default specified as the contract every later phase implements. Nothing wire-facing ships before this is nailed.
1. **`plurnk-schemes-a2a`, read-only outbound**: card fetch (with JWS verification from day one) + task status/artifact READs against a reference A2A server. Proves the scheme shape and teach doc; conforms to the phase-0 identity model. *(schemes lane — idle now.)*
2. **Outbound lifecycle**: SEND-create, continue, input-required answering, KILL-cancel, SSE/push wake integration; egress posture per fork D.
3. **`plurnk-a2a` inbound**: module + generated card + workspace-registration seam (with core) + `PLURNK_A2A_ALLOW` admission enforced fail-closed + effect-gating per the two-gates split. Trust is BUILT IN here, not bolted on later.

## Status
Plan prepared; NOTHING filed to lanes yet — awaiting owner blessing of this document, then phase-1 issue to the schemes lane.
