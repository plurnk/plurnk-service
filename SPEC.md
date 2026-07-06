# plurnk-service — Specification

Canonical contracts plurnk-service exposes, architecture it implements, promises it makes to the constellation (`plurnk-grammar`, `plurnk-providers`, `plurnk-schemes`, `plurnk-mimetypes`, `plurnk-execs`, the user-facing `plurnk` CLI). `AGENTS.md` covers process; this file covers contract.

The `§` sigil marks one thing: a stable terse tag. A section is a tag (`§discovery`); a promise under it is a child tag (`§discovery-discover`) whose prefix names its section. Headings, prose cross-refs, and promise anchors all use this one namespace — no digits, so renumbering is a non-event. Promise anchors `{§<tag>}` mark individual assertions; tests cite them in their names (`test("[§<tag>] …", …)`). `test/intg/spec-anchors.test.ts` fails on orphan citations and reports gaps. Anchors are drift-grounding, not a forcing function.

---

## §glossary Glossary

Canonical meanings. When a doc, comment, test name, or commit message uses one of these words, it means exactly what's written here. Drift is a bug.

### §lifecycle-terms Lifecycle terms

| Term | Meaning |
|---|---|
| **agent** | The plurnk runtime. Acts in-session as the reserved `plurnk` run (§actor-boundary self-hosting), never a privileged singleton owning its own entries (entry scope is `session` / `run`, §machine-processes). |
| **session** | Durable user-named workspace. Persists across runs and process restarts. Identity: `sessions.id` + unique `sessions.name`. |
| **run** | A stretch of work within a session. Multiple runs per session. May fork from another run via `parent_run_id`. Owns the log entries. |
| **loop** | One model-driven or client-driven iteration within a run. Status ∈ {100 pending · 102 running · 200 done · 202 parked (resumable, §send) · 413 budget-overflow · 429 turn-ceiling · 499 cancelled · 500 failed · 504 wall-clock timeout (§operator-config-loop-timeout) · 508 runaway}. Many loops per run. The model runs inside a loop; each client RPC has its own loop. |
| **turn** | One round-trip with the LLM (or one client RPC dispatch). One assembled prompt sent, one parsed response handled. Many turns per loop. Identity: `(loop_id, sequence)`. |
| **op** | One DSL operation the model emits. Parsed into a `PlurnkStatement`. Examples: `EDIT`, `READ`, `SEND`, `FIND`, `COPY`, `MOVE`, `OPEN`, `FOLD`, `EXEC`. One turn produces zero or more ops. |
| **statement** | Synonym for parsed op. The AST shape `PlurnkStatement` from `@plurnk/plurnk-grammar`. |
| **action** | One executed op. Action and op are the same thing in different states (op = parsed; action = executed). The execution produces a log_entries row at `log:///<L>/<T>/<S>/<op>`. (The log also holds an *actionless* `op='error'` row — a model emission that failed to parse, §telemetry — so a failure is curatable like any row.) |
| **dispatch** | The engine routing a statement to its scheme's op handler. |

### §storage-terms Storage terms

| Term | Meaning |
|---|---|
| **entry** | The unit of canonical state. Identity: `(scope, scheme, pathname)`. Holds one or more `channels` of content plus `tags` and `attributes`. |
| **channel** | A named content buffer on an entry. Examples: `body`, `stdout`, `stderr`, `headers`, `symbols`. Each channel has `content`, `mimetype`, `tokens`, `state`. |
| **scope** | `"session"` or `"run"`. Determines who reads: session-scope entries are the shared world (every run in the session), run-scope entries are a run's private scratch (§machine-processes). |
| **scheme** | A URI prefix + handler. `known`, `unknown`, `file`, `https`, `exec`. The scheme handler interprets paths under its prefix and implements the op surface. Consumption surface §scheme-surface; author contract: [plurnk-schemes](https://github.com/plurnk/plurnk-schemes). |
| **mimetype** | A channel's content type. Drives the handler that produces the structural projections (`symbols`, `deepJson`, `deepXml`). Consumption surface §mimetype-surface; author contract: [plurnk-mimetypes](https://github.com/plurnk/plurnk-mimetypes). |
| **provider** | An LLM transport. Implements `generate({messages, signal})` against a wire protocol. Consumption surface §provider; author contract: [plurnk-providers](https://github.com/plurnk/plurnk-providers). |

### §state-terms State / status

Independent axes on entries and channels. Confusion across them is a recurring source of bugs.

| Term | Type | Meaning |
|---|---|---|
| **status** | HTTP int | Outcome of an operation. Carried on `log_entries.status_rx`, returned from op handlers. Per the catalogue (§send-dispatch). |
| **channel state** | `static \| active \| closed \| errored` | Streaming lifecycle of a channel's content. Metadata, not gating — engine renders content regardless of state. |
| **entry state** | `proposed \| resolved \| failed \| cancelled` | Proposal lifecycle (`log_entries.state`). `proposed` = pending client accept; `resolved` = accepted, side effect happened; `failed` = rejected (no effect); `cancelled` = the proposal was cancelled (loop abandoning). Distinct from channel state. |
| **outcome** | `string \| null` | Short reason for `failed`/`cancelled` (`"permission:403"`, `"aborted"`, `"not_found"`). Opaque to most callers. |

### §authority-terms Writer / authority

| Term | Meaning |
|---|---|
| **writer** | The identity authoring a write. One of `model \| client \| plurnk \| plugin`. Carried on `ctx.writer` for schemes; engine enforces `manifest.writableBy`. |
| **origin** | Synonym for writer in log_entries (`log_entries.origin`). Historical naming; treat as equivalent. |
| **writable_by** | The set of writers a scheme accepts. Subset of `{model, client, plurnk, plugin}`. Engine rejects writes outside the set with 403; the rejection is logged as the action-entry (§subscriptions action-entry-as-outcome). |

### §engine-rails Engine rails

| Term | Meaning |
|---|---|
| **verdict** | End-of-turn ruling computed directly in `Engine.runLoop` from strike/cycle/sudden-death rail state. Decides whether the loop terminates or another turn fires. No filter chain — rails are inline. |
| **strike** | A turn whose verdict counts toward `MAX_STRIKES`. Fires when `turnErrors > 0` or cycle detection trips. The streak counter resets on clean turn; reaches `MAX_STRIKES` → loop abandons at 500 (failed), or 508 (Loop Detected) when the crossing strike was cycle-driven. |
| **cycle** | A repeated turn fingerprint across consecutive turns. Detected silently; model never sees the trigger. Strike accumulates internally. |
| **sudden death** | The last `MAX_STRIKES` turns of a loop's `MAX_LOOP_TURNS` window emit soft 429 warnings so the model can wrap up cleanly. `soft=true`: no strike, no streak increment. |
| **mode** | `"ask" \| "act"`. Per-loop. Ask = read-only (no side-effecting ops); act = full surface. |
| **flag** | Per-loop boolean shaping the active toolset: `yolo` (auto-accept proposals), `noWeb`, `noInteraction`, `noProposals`. |
| **proposal** | A deferred side-effecting action awaiting client accept/reject (full lifecycle §proposal). State machine: `proposed → resolved` (accept), `→ failed` (reject), or `→ cancelled` (cancel). `yolo` short-circuits to immediate. |
| **resolution** | Client's accept / reject / cancel of a proposal via the `loop.resolve` RPC (§methods). |

### §packet-terms Packet terms

| Term | Meaning |
|---|---|
| **packet** | The turn's full exchange shape: `{system, user, assistant, assistantRaw}`. Persisted on `turns.packet`. |
| **log** | the `log` section. Chronological list of `log_entries` in scope this turn. |
| **render** | The act of computing the packet from current DB state at turn boundaries. Mimetype handlers fire at render time. |

### §test-taxonomy Test taxonomy

| Tier | Location | LLM | Substrate |
|---|---|---|---|
| **unit** | `src/**/*.test.ts` | No | Isolated logic, mocked boundaries |
| **intg** | `test/intg/` | No (mock provider) | Real file-backed SqlRite (per-test DB under `test/intg/.tmp/`), real engine |
| **live** | `test/live/` | Real | Wire-level assertions |
| **demo** | `test/demo/` | Real | Holistic outcome assertions |

---

## §arch Architecture

The ecosystem and the in-process shape (§ecosystem–§in-process), then the two invariants the rest of the spec rests on: isolation by run (§actor-boundary) and the session/run/fork ownership model (§machine-processes).

### §ecosystem Ecosystem

The plurnk project is a modular monorepo-of-repos in the `@plurnk/*` npm namespace. Each repo has one published package and one agent who owns it; cross-repo coordination happens through issues, not shared code. This service sits in the middle of that ecosystem and is its **runtime substrate** — the daemon other repos plug into.

Dependency direction (from root to leaf):

- **`plurnk-grammar`** — root. Owns the JSON-Schema contracts (Packet, TelemetryEvent, AST shapes), the ANTLR parser that turns model output into `PlurnkStatement[]`, and `PlurnkParseError` with its `toTelemetryEvent()` helper. Nothing in the ecosystem can speak the DSL without it; everything else pins it exactly.
- **Framework siblings** consume grammar and define their own author-facing contracts:
    - `plurnk-providers` — Provider/Alias types, `parseAliasesFromEnv`, `resolveActiveAlias`, `Mock`, `ProviderUsage` (currency-aware, includes `reasoning`). Vendor-specific implementations are children: `plurnk-providers-openai`, `-google`, `-ollama`, `-openrouter`, `-cloudflare`, `-xai`.
    - `plurnk-mimetypes` — handler base classes, discovery, the fitting algorithm, and the match primitives (`queryGlob`/`queryRegex`/`queryJsonpathObject`/`queryXpathString`) the service's matcher dispatches over (§matcher-dispatch). Handler children are per-mimetype: `plurnk-mimetypes-text-{python,typescript,markdown,html,csv,plain}`, `plurnk-mimetypes-application-{json,yaml,toml,pdf}`, …
    - `plurnk-schemes` — scheme-author types (`SchemeManifest`, `WriterTier`, `LoopFlags`), result-shape contracts (`EntryResult` / `ProposalResult` / `PassthroughResult`), slicing primitives, matcher helpers, `schemeError(...)` constructor. Future scheme children: `plurnk-schemes-http`, `plurnk-schemes-git`, …
    - `plurnk-execs` — `BaseExecutor`, `SubprocessExecutor`, runtime resolver, discovery. Children declare runtimes: `plurnk-execs-sh`, future `plurnk-execs-search`, `plurnk-execs-node`, …
- **`plurnk-service`** (this repo) — consumes all of the above. Implements the engine, dispatches ops through scheme handlers, hosts the in-tree set of schemes (`plurnk`, `log`, `exec`, `known`, `unknown`, `skill`, `file`), discovers installed mimetype handlers + provider vendors + executor siblings at boot, hosts the daemon (`src/service.ts` over WebSocket + JSON-RPC), and projects packets to the wire (the packet shape is service-owned since grammar 0.67 deleted `Packet.json`, §packet). Most of the substantive runtime work lives here.
- **`plurnk`** (client) — terminal UI consuming the daemon's RPC surface. Renders `telemetry/event` notifications, subscribes to log/stream/proposal events. No engine logic of its own.

The grammar is the contract. The frameworks consume the contract and add author-facing surfaces. The service consumes the frameworks and runs the engine. The client consumes the service and renders to humans. Each tier is its own published package; each tier's evolution happens in its own repo.

**This service's central role:** sole consumer of every author-facing framework contract (one set of integrations across the ecosystem), sole producer of the engine's runtime behavior (one canonical implementation of dispatch, log, packet wire), and sole orchestrator of cross-scheme operations (COPY/MOVE flow through engine-mediated `readEntry` / `writeEntry` / `deleteEntry`, never scheme-to-scheme). Most cross-repo coordination flows through us — we file the consumer-need issues at upstream repos, adopt their decisions, document the surface in SPEC.

### §in-process In-process architecture

Engine library + admin CLI + daemon. Four plug points:

- **Providers** (§provider) — LLM transports. Engine sends a turn's messages, receives raw content + usage; engine parses the content into `PlurnkStatement[]`.
- **Schemes** (§scheme) — addressable resources. Every op targets a URI; scheme handler interprets paths under its prefix and owns its storage substrate.
- **Mimetypes** (§mimetype) — content interpretation. Render-time handlers consume channel content; framework owns the dispatch.
- **Executors** (§exec / §bundled-set) — EXEC runtime dispatch. Subprocess shells, search backends, future tool runtimes.

The engine dispatches ops, persists state to SQLite, orchestrates cross-scheme COPY/MOVE (§copy/§move), writes the log. Substantive behavior lives in the four plug points.

The grammar (`@plurnk/plurnk-grammar`) owns parser + AST contract. Schemes receive parsed statement fragments via dispatch.

Server posture: this package is the runtime. User-facing CLI lives in `plurnk` and consumes the library API (`src/index.ts` + `PATHS`).

### §actor-boundary The actor boundary: isolation by run, two doors, self-hosting

**Question.** A session holds many runs — model, client, plurnk (§lifecycle-terms, §authority-terms) — over one shared manifest. What keeps one run's activity out of another's conversation; what are the *only* ways a run's work reaches another; and does the engine's own work obey the boundary or get a privileged back channel?

**Decision — isolation by run; the model is not privileged.** A packet renders exactly one run's log — the assembling run's — against the session's shared manifest (§packet). A run cannot see another's log: isolation is *structural*, a consequence of "a run owns its log entries" (§lifecycle-terms) and "one packet, one run," never an `origin` filter at render time. `origin` (§authority-terms) is **attribution** — the delta's provenance (§env-delta) — never read to filter a row. {§actor-boundary-isolation} {§actor-boundary-origin-not-filter}

**Two doors, and only two.** A run's work reaches another run by exactly two channels, and a private log is reachable no other way:
- the **environment door** — a write to a *shared entry* surfaces to every run sharing it as a folded, attributed delta (§env-delta). *State.*
- the **voice door** — an **inject** delivers a turn into a *specific* run's log; `btw` is the user's mid-loop inject. *Message.*

{§actor-boundary-two-doors}

**Wild west — no mutual exclusion.** Runs share the manifest without locks. Coordination is cooperative (tags + the shared workspace convention) and softly fenced (the §membership `read-only` overlay, a session policy, bounds every run's writable surface uniformly — §machine-processes); a conflict *surfaces* as a delta rather than being prevented. Inform, never override. {§actor-boundary-no-mutex}

**Passive wake.** An idle run wakes on exactly two events, both *directed at the run*: a prompt injected into it — the **voice door** (a user/system `loop.inject`, and once `run://` lands a sibling's `SEND(run://<name>)`) — or a **stream-status transition** on a subscription it opened (§channel-state). Everything ambient is a delta — a sibling's edit to a shared entry, an out-of-band disk change — and a delta **never** wakes; it queues and drains at the next turn one of those two events produces (§env-delta). {§actor-boundary-passive-wake}

**Self-hosting — the runtime is an actor, not a back channel.** Runtime-initiated work (fs reconciliation §membership, git auto-add) is an **ephemeral `plurnk` run** firing ordinary ops, seen by other runs through the environment door like any actor's — not a privileged engine pathway. The engine keeps only the irreducible kernel runs stand on (spawn, dispatch, packet assembly, the budget rails §grinder, the fs-watch); everything expressible as ops on session entries is a run doing ops, through the same `op.*` surface (§methods) the service offers clients. Dogfooding is the architecture, not a test mode. {§actor-boundary-self-hosting}

**Migration path.** Largely realized: `Engine.dispatch` is origin-agnostic; client ops run in a per-connection client loop (`_dispatchAsClient`); plurnk EDITs already carry `origin=plurnk`. The keystone is **built** — `dispatchAsPlurnk` spawns the session's reserved `plurnk` run and fires ops through dispatch, mirroring `_dispatchAsClient`; its uses so far (operator docs below; the fs-divergence narration) land in the plurnk run's log. The line that remains is one of *kind*, not a list of pending dispatches: work **expressible as an op** belongs on the keystone; work that is **not** stays kernel. Disk→entry materialization is the latter — *ingestion* is the inverse of an EDIT (which proposes egress to disk, §membership-edit-membership-gate), so it has no actor op and remains fs-watch kernel, paired with the plurnk run's filtered `source=file` narration (§env-delta) so a sibling pulls only true divergences, not every re-sync; the manifest build is likewise the per-turn derivation pump — packet-assembly kernel, not an entry-creating op. The one outstanding *expressible* piece is **git auto-add** — a model-created file surfaced as a plurnk-run op — gated on the §membership repo-overlay still being built.

**The keystone's first use: operator reference docs.** `PLURNK_SERVICE_MD_<ALIAS>=<path>` (§operator-config) materializes `<path>` as a `plurnk:///<ALIAS>.md` entry — a `dispatchAsPlurnk` EDIT in the plurnk run, **not** the model's — and the model's turn-0 foists a READ of it. The model reads the doc inline while the materializing EDIT stays out of its log: idiomatic context injection, an ordinary entry + READ rather than a bespoke packet section. The same `PLURNK_SERVICE_MD_*` convention cascades to clients. {§actor-boundary-doc-injection}

**Catalog preview.** `PLURNK_SERVICE_FILES_ITEMS` foists a turn-0 `FIND(scheme:///**)` per scheme into the run's first turn (the same plurnk-origin foist as the docs), so a run opens with its catalog instead of blank. The model's own surface — `known`/`unknown` (memory), `run` (scratch), `plurnk` (docs) — always foists **full**; the first-`N` cap applies **only to `file`** (the **bare** `FIND(**)` — the project-relative path shape plurnk.md teaches — over the external, arbitrarily-large tracked-file tree), so the model's own memory is never truncated (a partial view of memory reads as withheld). `-1` = everything full; a positive `N` = the file list capped to its first `N` (FIND's `<L>`, clamped so the strict marker never 416s; memory still full); unset / `0` = no preview (the model FINDs on demand). `log://` is absent — present-mode (the `# Log` section), not a catalog scheme. {§actor-boundary-catalog-preview}

### §machine-processes The machine and its processes: session, run, fork

**Question.** §actor-boundary isolates runs and lets the runtime self-host, but it stands on an ownership model it never states: what does a *session* own versus a *run*; what is shared versus private; and what does a fork carry? Unstated, the downstream questions — which run `log.read` reads, what a fork copies, where a per-client window onto the workspace would live — grow subtle, then metastasize. Drawn once, they vanish.

**Decision — the session is the world; a run is a log on it.** A **session** is the world: one shared filesystem — the `session`-scoped entries, surfaced as the per-scheme catalog (`FIND(scheme:///**)`, §packet) — under one membership overlay (§membership). Exactly one filesystem and one overlay per session; neither is per-run. A **run** is a process whose private memory is its **log** (§lifecycle-terms) — its loops, turns, and rows, each row carrying its own content, attribution (`origin`/`source`, §env-delta), and fold-state (`expanded`). A run owns **no membership**; even its visibility is not a possession but a bit on its own rows. It is a *history over the shared world, not a world*.

**One filesystem.** The entries are the session's: `entries.session_id`, never a run. A write by any run is a write to the one filesystem every run reads; there is no per-run entry set. {§machine-processes-one-filesystem}

**One overlay.** Membership — `git ls-files ∪ pick − hide` with `view` read-only (§membership) — is the session's: `session_constraints.session_id`, never a run. It is workspace *curation*, and the workspace *is* the session; two runs are two conversations about one curated workspace and see the same one. Divergent membership is a different session, never a per-run overlay. {§machine-processes-one-overlay}

**A run's memory of the world is its log — no shadow beside it.** A run's view of the shared world is the log and only the log — never a per-run snapshot. *What I am looking at* (OPEN/FOLD) is `log_entries.expanded`, a bit on the run's own rows, toggled by ordinary `log:///` ops — not a second store, and never membership (§open-fold). *What I last saw* needs no shadow either: a run learns its world moved through log entries (§env-delta) — a sibling's write broadcast into its log, an out-of-band disk change detected against the entry's own content and broadcast the same way — never through a per-run snapshot the run cannot see. (Its private **scratch** — run-scope entries, §run-scheme — is the run's own evolving workspace, owned not shadowed: a store it writes and reads deliberately, not a hidden mirror of the shared world. The doctrine is *no shadow of the world*, not *no private state*.) {§machine-processes-run-is-its-log}

**A run's log is private to packets, not to the session.** Isolation (§actor-boundary) governs what an *actor* sees — its own run, never a sibling's. It does not wall off the *wire*: any connection may read any run's log in its session by id — `log.read({ runId })`, ownership-verified, defaulting to the connection's own run. This is how a conversation client reads the **model** run, where the conversation lives: `loop.run` returns its `modelRunId`, and `session.runs` enumerates a session's runs for a connection that did not drive it live. The read is observation, never packet membership — no actor sees it. {§machine-processes-model-run-readable}

**A run carries its actor.** Each run records its `origin` — `model` (the conversation), `client` (a connection's own run), or `plurnk` (the runtime's self-hosting run) — set once at creation and inherited by a fork. `session.runs` returns it, so a conversation client identifies the model run by its actor, not by parsing the name — which is set at instantiation and immutable, never renamed (a run is permanent history, §machine-processes-run-is-its-log). {§machine-processes-run-origin}

**Fork — copy the log, share the world.** A fork is a new run in the *same* session (`runs.parent_run_id`, §lifecycle-terms). It copies the **log** — the rows, their fold-state riding along — so the branch inherits everything the parent observed (§env-delta makes a run's timeline self-contained for exactly this) and diverges freely after. {§machine-processes-fork-copies-the-log} It shares the **world** — the one filesystem, the one overlay — live and uncopied, because the run never owned it. {§machine-processes-fork-shares-the-world}

**A session cannot be forked.** There is nothing to branch — a session *is* the shared ground. `runs` carries `parent_run_id`; `sessions` carries no parent. Parallel histories over one workspace are forks of its runs; a divergent workspace is a new session. {§machine-processes-no-fork-session}

**Rationale.** The model falls out of one correction: *a run is a history over a shared world, not a world.* Entries are the world (session); the log is the history (run); forking a history need not copy the world, and a run accumulates nothing the log does not already hold. The overlay's session home is forced the same way — it is the world's curation, and the world is shared; per-run it fragments the one manifest, forks the membership read-gate (the §membership security line), and duplicates what FOLD already does at the right level. Every "which run / what's copied / where's the per-client window" answers itself once the world/log line is drawn.

**Migration path.** Mostly stating what the schema already carries: `runs.parent_run_id` and the parentless `sessions` exist (§lifecycle-terms); `session_constraints` is session-level (§membership); §env-delta already makes a run's timeline self-contained, so a fork's log copy suffices. Additive: `run.fork` over the wire (the engine fork is built). Two repatriations: §actor-boundary's "read-only overlay scopes a run's writable surface" becomes a *session* policy bounding every run uniformly; and the §env-delta environment door has shed its per-run snapshot — a run's only memory is its log, so drift is pulled from the shared log (other actors' edits since the run's last turn) and the filesystem narrates its own through the `plurnk` run, both already log entries, never a per-run shadow.

### §run-scheme The run:// scheme — control (spawn, irc, fork, terminate, cap, collect) and run-scope scratch

The run:// scheme makes §machine-processes addressable: a `run://` target is a sister run in the session — `run://self` the current run, `run://<name>` a session-scoped sibling (`runs.name`). `self` is the reserved current-run sentinel; empty authority (`run:///`) is invalid (400). Same-session only; a run never addresses another session's runs (§actor-boundary). The path discriminates the two faces: **path-absent is control** on the run-as-actor — the NAME is the authority (`run://<name>`, two slashes, no path) — while **path-present is run-scope storage**: `run://<owner>/<path>` (`run://self/<path>` for self) addresses the owner's private scratch (Scratch + Perspective, below). The control ops are three, fire-and-forget — the child runs independently, lineage in `runs.parent_run_id`:

- **Spawn** — `WORK(run://<name>):task` creates a new worker sister (empty log) and starts it with `task` on its first loop. WORK/FORK are the run-creation verbs (grammar 0.74.55): EDIT is file/entry only, so EDIT on the bare run entity is a **400** steering to WORK/FORK — the entity is not an entry. A name is **frozen per run** but **reclaimable across time** (§machine-processes-run-origin): a name held only by a *terminated* sister is free to reuse — a fresh spawn takes a new row and `run_resolve_by_name` resolves the newest, the corpse keeping its name in permanent history. A name a *live* sister still holds is a conflict — **409 `run '<name>' is already running`**, legible at the spawn gate, never a raw store-level uniqueness error. {§run-scheme-spawn}
- **irc** — `SEND(run://<name>):msg` delivers `msg` to an existing sister, the **voice door** (§actor-boundary-two-doors): an active sister folds it into its next turn, an idle one wakes (§actor-boundary-passive-wake); a name with no run in the session is 404. {§run-scheme-irc}
- **Fork** — `FORK(run://<name>):task` branches the current run into a **named** sister: its log is deep-copied (§machine-processes-fork-copies-the-log), which continues with `task`; the world is shared, never copied (§machine-processes-fork-shares-the-world). A fork ALSO inherits the run-scope **scratch** — its private workspace deep-copied with the owner remapped (source → branch) — so the branch opens with the parent's notes and diverges on its own edits: *fork = everything-in-common-but-name*. WORK and FORK are distinct verbs — WORK spawns a fresh worker, FORK branches the log — and each names the new run explicitly, so the model addresses it (`KILL`/`SEND`/`READ`) by that name. The legacy auto-name `<parent>-fork-<N>` remains only the internal fallback when Fork is invoked without a name. Inherited loops are copied as **terminal history** (a non-terminal status is clamped): a fork's own work is a fresh loop, so an inherited mid-flight loop never makes the branch look forever-live to the §send-premature-terminate gate. {§run-scheme-fork} {§run-scheme-fork-scratch}
- **Delegation inherits authority.** The live loop a spawn, fork, or irc-raised fresh loop starts with carries the **delegating loop's flags** — a YOLO parent delegates YOLO workers. Flags are a property of the delegation, not of the client connection: a child loop that fell back to defaults would propose every side-effecting op into a resolver-less void (nobody attends a headless worker's review queue; each attempt burns the full proposal timeout — the four-sweep fan-out wedge, where three workers stalled 300s-per-EXEC while the parent slept and the harness watched only the parent). An irc that *resumes* a parked loop leaves that loop's own flags untouched — inheritance applies only where a fresh loop is born. {§run-delegation-inherits-flags}
- **A wake re-queue is not a terminal.** A conclusion-wake resumes a parked loop by re-queueing it (202 → 100); when that lands while the loop's OWN live drain is between turns, the drain **re-claims and continues** (atomic 100 → 102; the injected prompt is already the next turn) — it never reports the re-queue outward. Treating 100 as an externally-imposed terminal broadcast a QUEUED loop as `loop/terminated {finalStatus: 100}` while the DB healed to 200 behind it — a client-facing lie the delegation topology hit on ~30% of runs. {§run-lifecycle-wake-requeue-not-terminal}

All three ride one engine seam — the daemon's inject (active→fold, idle→enqueue+drain) — so the handler creates/branches the run and hands off; the daemon owns provider + system prompt. FORK/WORK carry the seed task in the body and are their own ops (grammar 0.74.55), dispatched to run control — never the entry-copy path.

Beyond the three creation ops:

- **Scratch (storage)** — `run://<owner>/<path>` is run-scope entry storage (`scope='run'`, the owner is the run name folded into the path; `run://self` is self). A run EDITs only its own scratch — a cross-run write is **403** ("read a sister's notes, never write them") — but READs and FINDs any sister's by name (cross-run read is open; scratch is perspective-private, not ACL-private). {§run-scheme-scratch}
- **Scratch KILL (delete)** — `KILL(run://<owner>/<path>)` with an entry **path present** deletes that scratch entry (200; 404 if absent), self-only like EDIT (a cross-run delete is **403**) — the model's curation lever over its own workspace, distinct from the path-ABSENT `KILL(run://<name>)` which terminates the run (§run-scheme-terminate). The discriminator is the entry path, never the op. {§run-scheme-scratch-kill}
- **Perspective** — a run's own scratch is catalogued in **its** manifest alone — `Manifest(run) = session-scope ∪ this-run's-run-scope`, foisted as `FIND(run://self/**)` at turn 0 — so a sibling reaches it only by explicit `FIND(run://<name>/**)` and never sees it in its own perspective; isolation is structural (`scope='run'` is excluded from every session query, the owner opted back in only on its own read paths). {§run-scheme-find-perspective}
- **Terminate** — `KILL(run://<name>)` aborts a run by address (self is `run://self`): its active loop closes 499 and its subscriptions tear down; a name with no run is 404. The override to the fire-and-forget default — not a parent-power, whoever holds the address may end it; a run left alone simply ends at its own `SEND[200]`. {§run-scheme-terminate}
- **Cap** — `PLURNK_SERVICE_SESSION_RUNS_MAX_ACTIVE` ceilings the *concurrent* active runs per session (a run with a non-terminal loop); a spawn or fork past it fails hard (508 — no queue, no retry), irc exempt; `-1` disables it. The fork-bomb brake, sized for sessions that live for months. {§run-scheme-cap}
- **Collect** — a run's loop reaching a terminal status surfaces to its sisters as an ambient delta (§env-delta): a `SEND` from `run://<name>` carrying the loop's deliverable — the `SEND[200]` body, or for an abandonment the reason. A **2xx deliverable is born OPEN** (its body materialized into the parent's packet, not hidden behind a fold): a child's success must reach the parent open and awakening, never a bodyless row. An abandonment (non-2xx) surfaces folded. Every death-path is stamped uniformly, so no termination is silent; collection is the shared world moving, never a verb. **Child orientation.** Beyond the conclusion delta, every turn the system packet surfaces the live things THIS run *currently holds* — open streams (`## Plurnk Service Child Streams`) and unconcluded child runs (`## Plurnk Service Child Runs`) — as terse `* <status> <path>` pointers (the same shape as the errors section), just above it. A worker is otherwise marked only at spawn and at conclusion; in between it goes silent, so a model loses track of what it holds and premature-terminates. This is ORIENTING STATE, never advice: the model SEES its live subtree (`* 102 run://worker-x`, `* active sh:///1/2/3`) and reasons for itself — READ/OPEN/KILL via the path — the error stays terse. Empty → omitted, like errors. {§child-orientation} The **pull** side mirrors the push: a path-absent `READ(run://<name>)` collects the same deliverable on demand — the latest loop's terminal message (the result, or the abandonment reason) for a concluded run; a run **still running** has not delivered, so the READ returns **425** steering the model to park (`SEND[102]<-1>`) and await the push. A missing name is 404. So the model never needs to guess a scratch path to "check on" a worker — reading the run itself yields its outcome or a wait. {§run-scheme-collect}

### §run-lifecycle Run lifecycle: the drain, the reap, the passive wake

A run is a **log plus a cancellation scope** — one `AbortController` per run, reused while live and replaced only once aborted, so a cancel ends the run as a unit and a later `loop.run` is never born cancelled. A run's queued loops are advanced by a **drain**: a single per-run worker that claims loops atomically (status 100→102) and runs each under the run's scope. A loop may spawn **streams** (execs) that outlive it; each is a row in the subscription registry (§subscriptions) — the durable record of what the run holds open. Cancellation and conclusion are defined against these structures, never wall-clock timing.

- **One drain advances a run.** At most one drain is registered for a run at any instant: a `loop.run` or wake on a run with a live drain folds in (active→next-turn) or enqueues a loop that drain claims, never a second parallel drain. A drain's start and its empty-queue teardown relinquish run under one per-run lock, so the teardown's re-claim cannot race a concurrent start into a double-drain. {§run-lifecycle-single-drain}
- **A cancel reaps every stream the run holds — by the registry.** `loop.cancel` / `KILL` / shutdown abort the run scope AND iterate the run's open subscriptions, aborting each via its owning scheme; the registry is the source of truth, the in-process abort signal a fast-path optimization. A stream that is running, mid-spawn (its row written before it is killable), or spawned after the cancel is reaped alike. The teardown abort is a BOUNDED reap — the executor sends a polite signal then SIGKILL after a consumer-set grace (`PLURNK_SERVICE_EXEC_KILL_GRACE_MS`), so a signal-ignoring stream can't wedge it; a model `KILL[code]` on a live stream instead delivers exactly that signal once (bare `KILL` → the executor's SIGHUP default, `KILL[9]` → SIGKILL), the model owning any escalation. {§run-lifecycle-total-reap}
- **A stream's kill binds to the scope it captured at spawn.** A stream captures the run's cancellation scope as it registers and wires its kill to it, re-checking `aborted` AFTER wiring — no check-then-listen gap can drop an abort that lands mid-registration. Because the scope is replaced only once aborted, a captured-then-replaced scope is necessarily already aborted, so replacement never strands a live stream. {§run-lifecycle-exec-epoch-bound}
- **A cancelled run is not resurrected by its own torn-down work.** A stream conclusion delivered to a cancelled, idle run starts no fresh drain: an aborted (499) conclusion is skipped, and a straggler that concluded cleanly surfaces its deliverable as an environment delta (§env-delta), never a revived loop. The cancel was deliberate; only an explicit `loop.run` resumes the run. {§run-lifecycle-no-resurrection}
- **A stream conclusion always reaches its run.** When a backgrounded stream concludes, the daemon routes it through the same inject seam as any loop source (§actor-boundary-passive-wake): an active run folds the conclusion into its next turn; a run parked at a **slept loop** (`SEND[102]<T>`/`<-1>`) **awakens that loop in place** — the slept loop *is* the continuation, so there is no fresh loop and no summary-as-prompt fiction. The result is never lost: a parked loop sleeps rather than ending, and the stream's status-transition is the OPEN event (§actor-boundary-passive-wake) that wakes it; on resume it reads the concluded stream's own state, not a synthetic prompt. {§run-lifecycle-wake-liveness}
- **A child run concluding wakes a parent parked on it — the topology join.** `run://` spawn/fork records `parent_run_id` (§lifecycle-terms). When a run's drain exits having **concluded** — no parked `202` loop, no open stream — the daemon resumes its parent **in place** if the parent is parked (`#onDrainExit` → the shared `#wakeParkedRun`, the same 202→100 resume a stream conclusion uses). So a parent that spawns work and parks (`SEND[102]<-1>`) is woken the moment its child finishes; on resume it reads the child's deliverable from the §run-scheme-collect delta in its own log — a control edge, **never an injected prompt**. The wake recurses upward via the parent's own drain-exit. A child still running — or itself parked at 202 — is not *concluded*, so it does not wake the parent (it's still a live thing the subtree holds). This is the structured-concurrency join: streams and child runs are the same kind of "live thing a run holds," driving premature-terminate (§send-premature-terminate), the wake edge, and the collect delta identically. A worker-run conclusion is a **bounded, un-loseable** wake: if the conclusion fires while the parent is mid-turn (before its park commits), `#wakeParkedRun` finds it not-yet-slept and records an **owed wake**, which the drain honors at the parent's park — so a hibernation awaiting worker runs **always returns**, never dead-parks on a conclude-before-park race. (Only a live exec stream, unbounded absent a timeout, may legitimately hold a park open.) {§run-lifecycle-child-wake}
- **A park whose subtree is idle emits `loop/quiesced` — a soft signal, not a terminal.** When a loop parks (`SEND[102]<T>`/`<-1>`, internally `loops.status = 202`) and its subtree is idle (no open stream, no non-terminal child), the daemon broadcasts `loop/quiesced` (§notifications) — the client's honest *"nothing is running under this run right now."* The loop **stays parked and is reawakable**: an arrival (sibling `irc`, operator inject, a later `loop.run`) resumes it — and a bounded park's deadline resumes it regardless. It is **never a terminal code** — in a topology where any sibling can `irc` any run, true finality below the session doesn't exist, so quiescence (not finality) is the honest "done." A subtree with any live thing emits nothing — that thing's conclusion is the wake edge, not a quiesce. {§run-lifecycle-quiesced}
- **A loop is never stranded by a drain's exit.** A drain relinquishes its registry slot only after a lock-held re-claim confirms the queue is empty; a loop enqueued during that teardown is either re-claimed by the exiting drain or claimed by a fresh drain that a later inject starts. The relinquish and the start are serialized, so neither the lost-loop hang nor a transient double-drain can occur. {§run-lifecycle-no-lost-loop}

---

## §provider Provider Contract

Author-facing contract: [plurnk-providers#1](https://github.com/plurnk/plurnk-providers/issues/1). Below: consumption surface + engine→provider guarantees.

### §provider-surface Consumption surface

Three entry points:

- `provider.generate({messages, signal})` — once per turn; returns `{ assistant: { content, reasoning, usage, finishReason, model }, assistantRaw, meta? }`. **Engine parses `assistant.content`** into `PlurnkStatement[]` via `@plurnk/plurnk-grammar`. {§provider-surface-generate}
- `provider.countTokens(text)` — synchronous, called at write-time (§tokenomics) and render-time. Non-negative integer. {§provider-surface-counttokens}
- `provider.costFor(usage)` — once per completed turn; pico-USD. Engine writes to `turns.usage_cost_pico`; triggers cascade to `runs.cost_pico` / `sessions.cost_pico`. {§provider-surface-costfor}

Plus immutable identity: `provider.contextSize` (token total, or `null` → "no budget info"), read by the budget {§provider-surface-identity}; and `provider.model` — the instance identity the deferred model-switch recompute compares (§tokenomics), exposed but not yet consumed here.

**Metadata passthrough (provider → client).** `generate` may return an open `meta: Record<string, unknown>` bag — e.g. a hosted provider's running `balancePico`. The service stores it **unenforced** per turn (`turns.meta`, `json_valid` only — no schema) and forwards the latest turn's blob to the client on the loop usage payload (`loop.run` result / `loop/terminated`, §methods). **The service never reads a field within it.** The canonical-field contract — which fields exist and their shapes — is the *provider framework's* (it normalizes raw vendor data into the agreed set) and the *client's* (it renders that set); a provider and client can ship a feature with **zero service change** as long as the blob flows. Absent → `{}` (the client renders nothing; never fabricated). The mirror direction (client → provider, the self-identified `client` id) rides `generate({client})` (§attribution). {§meta-passthrough}

### §provider-guarantees Engine → provider guarantees

- `messages` is a complete prompt (the section list, pre-assembled into the system + user messages). Provider does not reorder.
- `signal` is wired to the run's AbortController. {§provider-guarantees-signal-wired}
- `generate` is single-call per turn. No parallel calls on the same instance. {§provider-guarantees-single-call}
- `assistantRaw` is opaque to the engine (forensics-only). {§provider-guarantees-assistantraw-opaque}
- `countTokens` is cheap by contract; engine calls frequently.

### §attribution First-party plugin attribution

A plugin declares an opaque attribution tag in its `package.json` so the creators behind it can be credited when the plugin is active:

```
{ "plurnk": { "attribution": "@acme/widgets" } }   // a string, or string[]
```

The engine unions the declared tags of the active plugin families (schemes, execs) onto `generate({ attributions })`, deduped + stable, per turn; an empty set is omitted. The service does not interpret a tag; richer creator identities (`@plurnk/creators/<name>`) ride the same namespace later.

The loop's **current strike streak** rides `generate({ strikes })` the same way — first-party outbound metadata (`Plurnk-Strikes` under the `firstPartyMetadata` gate, providers 0.30, #313): the hosted router's escalation signal (route-after-strike). The shape is a bare number — the streak at generate-time, the same figure the 500-threshold compares; a clean turn zeroes it, every loop starts at 0, and `0` is sent explicitly (clean ≠ unreported). It is NEVER model-facing (§engine-rails: a surfaced count is a metric to game) — headers only, the packet never carries it. {§strikes-first-party-metadata}

**The `@plurnk/` namespace is reserved.** A package may declare an `@plurnk/` tag only if it is itself `@plurnk/`-scoped (npm enforces scope ownership at publish); otherwise it fails hard. {§attribution-plurnk-namespace-reserved}

**The session's `client` id rides the same wire.** A frontend self-identifies (e.g. `plurnk.nvim/1.4.0`) at `session.create({ settings: { client } })`; the engine forwards it per turn on `generate({ client })`, which only the `plurnk` provider emits (as `Plurnk-Client`). Session-stable and self-reported — distinct from attribution's install-grounded tags — and omitted when unset. {§client-telemetry}

Deferred (#249): grounding the attribution value in real per-turn value flow rather than the active-plugin placeholder, token-weighting, and entry-level attribution. Native surfacing of the field in each framework's `discover()` supersedes the service-side manifest read and extends collection to mimetype + provider plugins.

### §provider-instantiation Provider instantiation

Model alias parsing (`parseAliasesFromEnv` / `resolveActiveAlias`) lives in [`@plurnk/plurnk-providers`](https://github.com/plurnk/plurnk-providers). {§provider-instantiation-alias-resolution} Dynamic provider instantiation (`instantiateProvider` / `loadActiveProvider`) lives in `src/core/ProviderInstantiate.ts` here — `import()` resolves package specifiers relative to the calling module, so the dynamic-import path stays in the consumer where the `@plurnk/plurnk-providers-<vendor>` packages are installed.

**Grammar enforcement is verified at boot.** When the operator sets `PLURNK_PROVIDERS_GBNF`, `loadActiveProvider` forces a trivial grammar (`root ::= "PLURNK-RAILS-LIVE"`) and confirms the backend returned exactly that — a live end-to-end proof the rails engaged. Anything else **fails hard at boot**: the openai provider only transports the grammar when its probe detects llama-server (grammarStyle `llamacpp`), and any probe hiccup silently falls back to `none` — unconstrained generation with no signal, the whole grammar contract dark, model rambles that read as reasoning failure. The Provider interface exposes no capability to introspect this, so the contract is *verified* rather than trusted; a legible boot refusal beats silent garbage. No-op when GBNF is unset/`0` (unconstrained is then a deliberate mode). {§grammar-enforcement-verified-at-boot}

```
PLURNK_MODEL_gemma=openai/macher.gguf
PLURNK_MODEL_opus=openrouter/anthropic/claude-opus-latest
PLURNK_MODEL=gemma
```

First path segment = provider plugin; rest = provider's own model id.

### §mock-provider Mock provider (sibling fixture)

`Mock` (exported from `@plurnk/plurnk-providers`) — intg fixture + reference implementation. `{ contextSize, responses }` constructor; `generate` shifts from the queue. `MockResponse.assistant.ops?: PlurnkStatement[]` is a pre-parsed escape hatch the engine consumes directly when present; production providers don't expose this — and being a daughter export, this contract has no service-side `§`-ref. {§mock-provider-mock-fixture}

---

## §scheme Scheme Contract

Author-facing contract: [plurnk-schemes#1](https://github.com/plurnk/plurnk-schemes/issues/1). Below: what plurnk-service exposes to schemes and orchestrates over them.

### §scheme-address Address resolution (RFC 3986)

Every op targets a URI; the entry key is `(scope, scheme, pathname)`. The URI parses per RFC 3986 (`scheme://[authority]/path`) and maps to that key by one rule — no per-scheme carve-out:

- A **registered** scheme is a plurnk namespace: its authority is a leading path segment, folded into the pathname (`Dispatcher.#extractTarget` → `foldAuthorityIntoPath`). So `known://x`, `known:///x`, and pathname `/x` are the same entry — the authority is never a host, and the two-slash and three-slash forms are not distinct resources. {§scheme-address-namespace-fold}
- A **foreign** scheme (unregistered — `http`/`https`) is a real web host: its authority stays in `hostname`, never folded.
- `file` persists `scheme = NULL`; a relative path resolves against the workspace root to the namespace-absolute `/rel` key (RFC 3986 §5 reference resolution), and a path escaping the root is 403 (§membership).

Storage keys on the resolved `(scheme, pathname)` **verbatim** — the leading slash is the namespace origin, not a filesystem absolute, and is never re-normalized at the storage boundary.

### §scheme-manifest Manifest

Per author contract. Each scheme declares a `static manifest: SchemeManifest` with `name`, `channels`, `defaultChannel`, `category`, `scope`, `writableBy`, `volatile`, `modelVisible`, optional `flags`. {§scheme-manifest-manifest} Identity match enforced at plugin load: `manifest.name` must equal `package.json#plurnk.name`.

### §crud CRUD primitives

Per author contract (`readEntry` / `writeEntry` / `deleteEntry`). Engine drives cross-scheme COPY/MOVE/SEND[410] through these — the orchestration and its 404/409/415 semantics are anchored under §copy/§move. Each method is one SQL transaction; engine owns the outer transaction for orchestrations.

### §op-methods Op methods

Per author contract (`edit`/`read`/`open`/`fold`/`find`/`send`/`exec?`). Engine dispatches by `PlurnkStatement.op`. {§op-methods-op-dispatch} COPY and MOVE are NOT scheme methods — engine orchestrates over CRUD primitives (§copy/§move).

### §orchestration Cross-scheme orchestration

```
copy(source_path, dest_path, signal_tags, ctx):
    src_scheme = scheme_for(source_path)
    dst_scheme = scheme_for(dest_path)
    entry = src_scheme.readEntry(source_pathname, ctx)
    if entry == null: return 404
    if dst_scheme.readEntry(dest_pathname, ctx) succeeds: return 409
    if not mimetype_compatible(entry, dst_scheme): return 415
    tags = signal_tags ?? entry.tags
    dst_scheme.writeEntry(dest_pathname, { channels: entry.channels, tags }, ctx)

move(source_path, dest_path, signal_tags, ctx):
    copy(source_path, dest_path, signal_tags, ctx)
    src_scheme.deleteEntry(source_pathname, ctx)
```

Same- and cross-scheme operations share the orchestrator. Same-scheme COPY is not a special case. Orchestration behavior — 404/409/415, `move` = `copy` + `deleteEntry` — is anchored under §copy/§move.

### §send-dispatch SEND dispatch (status-code-as-verb)

Directed SEND (non-null path) routes to scheme's `send`. Status = intent:

- `SEND[200](path)` — write body into resource (WS message, exec stdin).
- `SEND[499](path)` — cancel active subscription (§stream).

`SEND[410](path[#fragment])` also deletes the target entry/channel — an implemented side-effect, NOT taught to the model and with no live/demo surface. The model-facing delete idiom is KILL (§move).

Other status codes return 501 from entry-bearing schemes by default. {§send-dispatch-entry-schemes-501-on-non-410}

Null-path SEND is broadcast (§send), engine-handled.

### §scheme-surface Consumption surface

Per-call context (`src/core/scheme-types.ts`):

```ts
interface PlurnkSchemeContext {
    readonly db: Db;
    readonly sessionId: number;
    readonly runId: number;
    readonly loopId: number;
    readonly turnId: number;
    readonly writer: "model" | "client" | "plurnk" | "plugin"; // WriterTier
    readonly signal: AbortSignal | undefined;
    readonly streamEventNotify?: StreamEventNotify;
    readonly wakeRunNotify?: WakeRunNotify;
    readonly injectRun?: InjectRunNotify;            // run:// spawn/fork/irc loop-start (§run-scheme)
    readonly mimetypes?: Mimetypes;
    readonly executors?: ExecutorRegistry;           // boot-discovered EXEC runtimes (§exec)
    readonly tokenize?: (text: string) => number;    // write-time tokenizer (§tokenomics)
    readonly defaultChannelFor?: (scheme: string | null) => string;
    readonly pushTelemetry?: (event: TelemetryEvent) => void; // → next packet errors[] + telemetry/event (§telemetry)
}
```

The optional engine-/daemon-populated capabilities (the notifiers, `injectRun`, `executors`, `tokenize`, `defaultChannelFor`, `pushTelemetry`) are absent in bare test fixtures; a handler that needs one **fail-hards** rather than silently degrading (no default runtime, no silent zero-token write).

Engine → scheme guarantees:

- `ctx` is fresh per call. No mutation across calls.
- `ctx.writer` reflects the actual writer at this dispatch.
- `manifest.writableBy` checked BEFORE invocation; engine returns 403 directly on exclusion. {§scheme-surface-writableby-403}
- `ctx.signal` is wired to the run's AbortController (§provider-guarantees-signal-wired).
- Scheme exceptions become the action-entry's outcome (status 500); summary surfaces in next turn's `errors` section (§telemetry). {§scheme-surface-exception-500}

**Tokenization participation.** Schemes route writes through the shared `_entry-crud.ts` write helper (in plurnk-service today; migrates to plurnk-schemes). Helper populates `entry_channels.tokens` at write time via `ctx.tokenize` (§tokenomics-tokens-stored-at-write). Raw DB writes bypass tokenization — out of API scope.

---

## §mimetype Mimetype Contract

Author-facing contract: [plurnk-mimetypes](https://github.com/plurnk/plurnk-mimetypes). Below: firing semantics + consumption surface.

**Firing semantics.** Render-time consumers. Engine invokes during packet assembly; handlers read current channel content (possibly mid-stream), produce structural view, result lands in the manifest catalog. Schemes do NOT call mimetype handlers at write time. {§mimetype-schemes-do-not-invoke-handlers}

### §mimetype-manifest Manifest

Per author contract. Manifest declares `kind: "mimetype"`; handler class declares `mimetype` (matches manifest name) and `glyph` (single emoji). Collisions fail-hard at boot per §plugin-discovery.

### §mimetype-methods Methods

Author contract owned by plurnk-mimetypes. plurnk-service consumes ONE entry point:

- `Mimetypes.process(input)` — the projection entry point; returns the structural projections (`deepJson` / `deepXml` / `symbols` / `references`) + extent (`totalLines`). {§mimetype-methods-process-entry-point}

**The daughter projects; the service queries.** `Mimetypes.query()` exists in the author contract, but plurnk-service does NOT consume it. The service owns **all** dialect matching — glob, regex, jsonpath, xpath, `@graph`, `~semantic` — resolved in-tree over those projections plus its own indexes (`symbol_defs`/`symbol_refs`, FTS5, vectors). mimetypes is mimetype-*literate* (content→structure); the service is dialect-*literate* (structure→matches). The pattern-matching DSL is plurnk's defining surface — the service's authority, never a daughter's.

Cross-cutting promises service relies on:

- Render-time only. Schemes do not invoke.
- Deterministic for a given (content, mimetype) tuple.
- Validation errors propagate (fail-hard).
- Degraded projection (a `grammarMissing` marker) rather than throw when a grammar is absent.

### §handler-bounds What handlers do NOT do

- **Tokenization** — provider-bound (§provider).
- **Storage** — pure functions over content strings.
- **Streaming** — handlers see whatever content is current; subscription registry lives between schemes and §stream.

### §handler-bundling Bundled vs sibling handlers

No mimetype handlers ship in-tree. Framework + every handler are siblings.

### §mimetype-surface Consumption surface

plurnk-service is mimetype-illiterate. Engine hands channel content + mimetype label to `Mimetypes.process({content, hint})`; the manifest build uses `result.totalLines` for each channel's `lines`. Content reaches the model on READ, not as a rendered preview.

**Required handlers** (boot-critical, provided via the framework):

| Package | Mimetype | Why required |
|---|---|---|
| `@plurnk/plurnk-mimetypes-text-markdown` | `text/markdown` | LLM emission default; configured as `defaultMimetype` on the `Mimetypes` orchestrator. |
| `@plurnk/plurnk-mimetypes-text-plain` | `text/plain` | Canonical EXEC stdout/stderr channel mimetype. |
| `@plurnk/plurnk-mimetypes-application-json` | `application/json`, `application/jsonc` | Service emits json for `log_entries` rx/tx, telemetry, packet serialization. |

These ride in via the framework — `@plurnk/plurnk-mimetypes` pins the core set (markdown / plain / json / xml / csv / html) as its own dependencies, so the service's exact-pin on the framework pins them transitively rather than redeclaring each. Boot relies on them (markdown is the `defaultMimetype`); their loss would be a framework-contract break. Everything else is opt-in; framework's `discover()` picks up installed packages automatically.

**Tokenize injection.** Daemon constructs `Mimetypes` with a `tokenize` lambda capturing the active provider's `countTokens`:

```ts
new Mimetypes({
    tokenize: async (text) => this.#provider?.countTokens(text) ?? Math.ceil(text.length / 4),
    defaultMimetype: "text/markdown",
});
```

Fallback heuristic is a boot-before-provider-resolved tripwire.

**Derivation pump.** `EntryManifest.maintainDerivations` is the per-turn engine-side pass (the §mimetype firing point) that walks **every** entry. It calls `process({ content, hint })` per channel for the catalog's `lines` (`totalLines`) and, for the body channel, pulls `symbols`+`references` from the *same* call to (re)build the `@graph` symbol index (`symbol_defs`/`symbol_refs`) via `EntryGraph.populateFrom` — one parse, two projections:

```ts
const result = await mimetypes.process({ content: r.content, hint: r.mimetype }, { channels: ["symbols", "references"] });
entry.channels[r.channel] = { mimetype: r.mimetype, tokens: tokenize(r.content), lines: result.totalLines };
if (isBody) await EntryGraph.populateFrom(db, sessionId, r.entry_id, result.symbols ?? [], result.references ?? []);
```

`hint` short-circuits detection. The service consumes `totalLines` (extent), `symbols`/`references` (the `@graph` index), and `deepJson`/`deepXml` (matcher dispatch); never a rendered preview — content reaches the model on READ. Because this pass runs every assembly over every entry, any content change — by any writer — is reflected in the next packet's index. The `@graph` index is NOT engine *ranking* (the anti-pattern): it's a complete, unranked index the model queries via `FIND @<sym`, the manifest paradigm applied to structure, uniform across schemes (`file:///` is the primary case).

The body channel's embedding vectors derive in the same pass (`EntrySemantic.deriveEmbeddings`): content is tiled into token-budgeted chunks, then embedded in **one data-parallel batch** (`mimetypes.embedBatch`) rather than a per-chunk loop — bit-identical vectors (no re-embed), ~6× on a multi-core box. The pump computes the changed-entry worklist up front so the corpus total is known; a multi-entry pass (the initial ingest, which otherwise looks frozen) emits a throttled `embed_progress` NOTICE (below), and a 0-1 entry steady-state turn stays silent.

**Conformance.** Mimetype-specific behavioral tests live in each handler's own surface. plurnk-service intg covers integration: the engine routes through `Mimetypes.process` with the right hint and the catalog reflects `totalLines`; tests use auto-discovery (production handler set); a custom-handler test injects a stub `BaseHandler` via `loader + discovery`.

---

## §channels Channel Topology

Every entry has named channels. **Channels are append-only content stores** keyed by `(entry_id, name)`. Schemes write content; the engine reads at turn boundaries; mimetype handlers interpret. {§channels-channels-append-only}

### §per-entry-channels Per-entry channels

EDIT writes one channel per call — the channel resolved from the path's fragment (or the scheme's `defaultChannel` when no fragment). {§per-entry-channels-edit-writes-only-body}

No stored `preview` channel — channel content is pulled on READ, never previewed.

Schemes MAY declare multiple channels (`exec`: stdout/stderr/stdin; `http`: body/header; SSE: per-event-type). Each goes in `manifest.channels` with mimetype pinned; rendered independently.

### §no-visibility Entries carry no visibility

Every entry is uniformly listed in the catalog (`FIND(scheme:///**)`, §packet) and READable — entries have no per-run open/folded state. Context curation is the model's, on the **log** (via OPEN/FOLD, §open-fold), never on entries.

### §channel-mimetype Mimetype is a (scheme, channel) property — never a default

Mimetype is declared by scheme manifest (§scheme-manifest) or supplied per-call for dynamic schemes. Writing a channel without a declared mimetype throws. No default mimetype anywhere.

- Cross-mimetype COPY/MOVE → 415, never coerces (§copy). {§channel-mimetype-cross-mimetype-415}

### §channel-selection Channel selection in the DSL

DSL targets a specific channel via the URL fragment (`#name`).

Rules:

1. Fragment-less paths target the scheme's `defaultChannel`. {§channel-selection-fragmentless-targets-default-channel}
2. Paths with a fragment target the named channel. {§channel-selection-fragment-selects-named-channel}
3. Unknown channel name → 400. {§channel-selection-unknown-channel-400}
4. Schemes without `defaultChannel` reject fragment-less EDIT/READ.
5. Non-default channel EDIT requires entry to exist (404 if absent); default-channel EDIT creates. {§channel-selection-fragment-on-nonexistent-404}
| URI | Channel |
|---|---|
| `known:///france/capital` | body (default) |
| `known:///france/capital#symbols` | symbols |
| `sh:///1/1/2#stdout` | stdout |
| `sh:///1/1/2#stderr` | stderr |
| `sse://feed/y#data` | data |
| `log:///N/T/A` | (no channel concept; atomic log row) |

Op implications:

- EDIT to undeclared channel → 400; read-only channel → 405.
- COPY/MOVE with fragment is per-channel; design deferred until needed.

RPC params carry fragments inline via the `target` string (`{ target: "known:///x#stderr" }`).

**Wire rendering: default channel is path-only.** Heredoc fence omits `#channel` when channel matches `defaultChannel`. Single-channel entries render path-only; multi-channel entries render the default path-only and only non-default carries `#name`.

```
<<notes.md:...:notes.md             — file scheme (bare)
<<sh:///1/1/2:...:sh:///1/1/2         — exec output default (stdout)
<<sh:///1/1/2#stderr:...:sh:///1/1/2#stderr — non-default
<<log:///1/1/0:...:log:///1/1/0       — atomic log row
```

### §channel-state Channel state — metadata, not gating

Each channel has `state ∈ {static, active, closed, errored}`. Metadata only, not an engine gate. {§channel-state-state-is-metadata}

- `static` — content final, not being written. Entry schemes after EDIT.
- `active` — scheme is writing (chunks arriving). Streaming schemes during accumulation.
- `closed` — stream ended cleanly. Content final.
- `errored` — stream ended in error. Content may be partial; reads return what accumulated.

Schemes own transitions; UPDATE `entry_channels.state` as connection lifecycle progresses. {§channel-state-schemes-own-state-transitions} State does not gate reads — schemes return accumulated `content` regardless (§channel-state-state-is-metadata).

Model uses state to anticipate growth between turns. Clients use state for UI (spinner / red border / etc.).

---

## §op Op Surface

Per-op semantics. AST shapes from `@plurnk/plurnk-grammar`'s `PlurnkStatement`. Engine dispatches by `op`; scheme implements per author contract (§scheme).

### §edit EDIT

AST: `{ op: "EDIT", target, body: string | null, signal: tags | null, lineMarker? }`.

- Resolves target channel from fragment (§channel-selection); unknown channel → 400; undeclared in manifest → engine crash (§channel-mimetype).
- Writes body; `body: null` clears. {§edit-null-clears}- Returns `{ status: 201, entryId }` for new entries; `{ status: 200, entryId }` for content updates. {§edit-status-201-200}
- A write that changes nothing — identical content and no new tag — returns `{ status: 304, entryId }`, mirroring OPEN/FOLD's no-op (§open-fold). {§edit-noop-304}
- Tags from `signal[]` apply additively via `entry_tags` (scheme may vary). {§edit-tags-additive}

A `file:///` member EDIT diverges from this immediate-write contract: it diffs against the entry snapshot (the body channel, never a fresh disk read) and **proposes** (202) a disk write that lands via a compare-and-swap on accept. See §membership-edit-write-cas and the proposal lifecycle §proposal.

### §read READ

AST: `{ op: "READ", target, body: MatcherBody | null, signal: tags | null, lineMarker? }`.

- Returns channel content + mimetype {§read-read-content}, or 404 {§read-read-404}.
- `lineMarker` slices per §slice-semantics.
- `body` matcher dispatches through the in-tree `Matcher` per §matcher-dispatch (all four content dialects wired).

### §open-fold OPEN / FOLD

AST: `{ op: "OPEN"|"FOLD", target, body: MatcherBody | null, signal: tags | null, lineMarker? }`.

OPEN/FOLD operate on the **log** (`log:///`) — the model's context-curation surface (§packet). FOLD collapses a log row to its path; OPEN restores its body. Non-destructive: rows and bodies persist, re-OPENable. Entries carry no visibility (§no-visibility), so OPEN/FOLD against an entry scheme returns 501.

### §model-entry The model's own emission, mirrored back

A `model` log row is the model's **verbatim prior emission**, mirrored back so it can finally SEE its own behavior — and reason through its own syntax errors (the parser reports by line; the row renders line-numbered like all content). Actionless, like an `op='error'` row (§telemetry): no target, no op executed; `tx` is empty and the emission lives in `rx.content`, typed `text/vnd.plurnk`. **Always born FOLDED** (budget-neutral) — the retired born-OPEN-on-error auto-trigger was conditional helpfulness that bred its own hazards (a giant erred emission mirrored open re-injects itself into the next packet: cost, contamination, pressure feedback). An error's reported `line:col` resolves the way everything else does: the model that cares `READ`s the folded row at the lines it wants — and can introspect ANY prior emission of its own the same way. OPEN/FOLD/KILL-able like any log row — the model curates its own history, and log-KILL clears the `writableBy` gate for the model (the DB-storage curation lever plurnk.md teaches; Log's handler surface — kill only — keeps every other mutating op at 501). {§model-entry-log-curation} The engine writes one at the end of each turn that produced output; a struck/empty turn mirrors nothing.

The run's **first** model row is exceptional: a born-OPEN turn-0 **exemplar** — a minimal worked example (`PLAN` → environment `FIND`s → `SEND[102]`) the model always opens on, so the grammar can stay thin (the example teaches the syntax, not a heavy grammar). {§model-entry}

**OPEN and FOLD are meta-operations — render directives, not actions.** They change how the world *displays*, never what it *is* (scrolling, not editing) — so a **successful** OPEN/FOLD leaves **no log row**: the next packet's render IS the receipt (the target shows collapsed/expanded), and the emission itself survives verbatim in the `model` mirror for introspection. A curation receipt that itself rented log space made curation self-defeating in the small — fold a 200-token row, gain a coordinate line, *pay a permanent FOLD row* — and the grinder's mechanical folds were already rowless: one rule now covers both curators, and FOLD is genuinely free. A **failed** OPEN/FOLD (bad target, bad range) keeps its ordinary op row with its status — errors are signals. The idle-turn gate reads the *emitted statements*, so a pure-curation turn is work, never idleness. {§fold-open-meta-operations}

### §copy COPY (engine-orchestrated)

AST: `{ op: "COPY", target (source), body (destination), signal: tags | null, lineMarker? }`.

Engine orchestrates over CRUD primitives (§crud, §orchestration):

1. `src_scheme.readEntry` → 404 if missing. {§copy-missing-source-404}
2. `dst_scheme.readEntry` → conflict verdict, deferred until the written content is known (step 5): exists with identical content + tags → 304 (no-op, mirrors EDIT §edit) {§copy-noop-304}; exists with different content → 409 (no overwrite) {§copy-conflict-409}; absent → proceed.
3. Mimetype compat — channels' mimetypes must be accepted by `dst_scheme.manifest.channels`. Mismatch → 415.
4. Tags: `signal` non-null replaces source tags {§copy-signal-replaces-source-tags}; null/empty carries source tags {§copy-no-signal-carries-source-tags}.
5. `dst_scheme.writeEntry({channels, tags})`.

Returns 201 on success. Same- and cross-scheme COPY share the orchestrator. {§copy-cross-scheme-copy}

### §move MOVE (engine-orchestrated)

AST: `{ op: "MOVE", target (source), body: dest | null, signal: tags | null, lineMarker? }`.

- **Relocation** (`body` non-null, resolvable dest): COPY (§copy) + `src_scheme.deleteEntry` in one transaction. 201 on success. {§move-relocation-deletes-source} Cross-scheme same as same-scheme. {§move-cross-scheme-move} Missing source → 404. {§move-missing-source-404}
- **MOVE never deletes.** A null body → 400 (a destination is required). {§move-null-body-400} `/dev/null` carries no special meaning; KILL is the canonical delete. {§move-dev-null-not-special}

Log history preserved — `log_entries` stores path tuple as text, not FK to `entries.id`.

### §find FIND

AST: `{ op: "FIND", target (scope), body: MatcherBody | null (predicate), signal: tags | null, lineMarker? }`.

- Filters entries within scope. The target's GLOB-ness sets it: a **bare** path is the exact entry, a **trailing-slash folder** (incl. the scheme root `/`) or an explicit **glob** expands to a scope (the `*` is folderhood, not a blanket prefix), `#regex#` filters by pathname. Same target contract as READ — bare = the entry, folder/glob = a scope to fan out (#286). {§find-scope-prefix-filter}
- `body` matcher operates on entry content (glob/regex/jsonpath/xpath), per grammar plurnk.md §"Body matcher dispatch"; the path-glob lives in the (target), not the body. {§find-glob-filter-on-content}
- `signal` is a tag filter; entries match if they have ALL listed tags. {§find-tag-filter-and-semantics}
- Session + scheme scoped — no cross-session/cross-scheme leakage. {§find-scoped-isolation}
- Returns `FindResult { status, content, mimetype, results: MatchItem[], matches, pathnames }`. The matcher sets the unit (#286). A **body-less** FIND is the **catalog**: one item per *entry* — `{ path, seconds?, tags?, channels: { <uri>: { mimetype, tokens, lines } } }` (the addressable path, per-channel `{mimetype, tokens, lines}` keyed by URI — default channel → the bare path, non-default → `path#channel` — plus `tags` and a live `seconds` stream age), the manifest's per-scheme slice. A **matcher** FIND resolves to one item per *match*: the entry's catalog row plus the `matchSpan` `{lineStart, lineEnd}` it hit. **A file with N matches yields N items** — the same row repeated, one span each; there is no `matchLines` array. The unit is uniform across every dialect — glob/regex/jsonpath/xpath select line spans, `~`semantic the ranked chunk's span, `@`graph the matched symbol's span — all `(file, span)`, all real content lines (the old "the extent of ~semantic/@graph is not a content line" carve-out was false: a chunk span and a symbol span are line ranges). Order is match order (rank for `~`semantic, source order otherwise); a miss contributes nothing; identical spans dedup. `content` is the items as a JSON array (`application/json`). {§find-result-catalog-rows}

### §send SEND

AST: `{ op: "SEND", target: ParsedPath | null, body: SendBody | null, signal: number | null }`.

- **Broadcast** (path null): the loop's disposition verb. `signal` is the model's *claim* about the run's state — see the terminal contract.
- **Directed** (path non-null): routes to `scheme.send` per §send-dispatch — stream control / cross-run irc, never a loop terminal.

**Terminal contract — the model's surface.** A broadcast SEND's status is a claim the engine **verifies against the run's actual state**, never a verdict it trusts. The model is trusted with exactly four codes:

| signal | claim | effect |
|---|---|---|
| **102** | continue | turn closes, another turn fires. Not terminal. |
| **200** | done | terminal — *only* when the run holds no live stream/spawn; otherwise the Premature-Terminate state below fires. Updates `loop.status`, ends the loop. |
| **202** | hibernate | terminal-but-resumable: the loop **sleeps** awaiting a wake edge — a stream-status transition or a directed prompt (§actor-boundary-passive-wake, §run-lifecycle-wake-liveness). A park that would orphan a same-turn READ with no wake edge is refused (the Groundless-Hibernate state below); an idle park surfaces as `loop/quiesced` (§run-lifecycle-quiesced). NOT advertised to the model: it lives in `run.md` and reaches the model only via the engine's steering, never the hot-path packet. Distinct from the dispatch-internal proposal-202 (§proposal), which the model never emits. |
| **499** | give up | terminal — the model's **one** self-decided failure (a self-cancel; 499 = cancelled, §state-terms). The only failure it is trusted to declare for itself. |

The engine's failure terminals — **500** (strike threshold) and **508** (cycle), §engine-rails — are never the model's to pick; they are the engine ruling the loop failed. The surface is small on purpose: the model says done, waiting, or giving up, and is never asked to hold a correct opinion about *how* it failed or *whether* it can be woken — the engine decides those from state.

**Three engine error states verify the claim.** None is a status code the model learns; all are engine machinery (§engine-rails), pushed to the model as a steering hint on the next packet and **never** as the strike itself (the model sees errors that happened, never the engine's accounting — the gamification policy, §engine-rails). Each strikes (`turnErrors`) and lets the loop continue so the model can correct; a model that ignores the hint and keeps offending spins out to the engine's 500, seeing only the repeated hint, never the count. (All live at `Engine.runLoop`'s turn close.)

- **Idle turn** {§send-idle-turn} — a continuing turn (102) whose ops are only PLAN/SEND — no work op. The model continued with nothing to do. The steer, verbatim: *"If the turn's work is complete, terminate with 200. If awaiting a stream or run trigger, terminate with 202 to hibernate."*
- **Premature terminate — the pending set** {§send-premature-terminate} — `SEND[200]` terminates, gated by ONE rule: *nothing pending may be silently discarded*. pending = open streams/spawns (§subscriptions) ∪ **live child runs** (a child is live by its **latest loop** — the same definition §child-orientation renders, so the gate and the section the model reads never disagree) ∪ **this turn's retrievals** (READ/FIND/OPEN rows, whose results fold back next packet — a [200] over them discards answers the model asked for). The set is judged **at the terminal's own dispatch, post-batch**: the emission's earlier ops have executed, so a same-turn `KILL + [200]` repairs in ONE turn, and a same-turn `WORK + [200]` is caught (the spawn is live by the time the SEND lands). A refusal is **409** with one steer naming the pending kinds — *"KILL what you no longer need; SEND[102] (or [102]<seconds>) to receive the rest; then conclude"* — the row records the attempt faithfully (never rewritten, never erased), the loop stays a continue, and it **strikes** (§grinder-strike-coupling). `SEND[499]` abandons regardless — discard by stated intent, the one legitimate discard. There is no groundless-hibernate gate and no [202] terminal: **waiting is a mode of continuing** (grammar 0.75.0) — `SEND[102]<T>` parks up to T seconds, woken early by any arrival (stream/child conclusion, sibling irc, operator inject) and woken at T regardless, so **a park always has a next turn and nothing can be orphaned**; `[102]<-1>` parks indefinitely (the butler/worker pattern — owner-ruled ungated, rendered legibly in instrumentation). Internally the parked state remains `loops.status = 202` (the model-facing signal retired; the engine's park state did not), and the park deadline is engine-memory consumed by the daemon's drain park-exit (a daemon restart drops pending deadlines; arrivals still wake).
- **Multiple choices** {§send-300-choices} — `SEND[300]:question;choice;choice;…` asks the **operator** a multiple-choice question and parks the loop awaiting the answer. The park is the ordinary resumable 202 state (identical wake edges); the parsed `{question, choices}` ride the log row's `attrs`, so the client's live `log/entry` stream carries everything a chooser UI needs; the answer returns through the existing `loop.inject` → passive-wake path — the operator is the waker by design, so no groundless refusal applies (the question's recipient just received it). A [300] can **never be malformed**: without choices it is simply an open question to respond to — choices are optional chooser sugar (`attrs` carries `{question}` alone for the bare form). The capability is **gated off by default** (the cascade: `PLURNK_SERVICE_ASK=0` shipped; a session's `settings.ask` REPLACES the env default — the interactive client with a human enables its sessions, headless/bench stays ask-less; disabled, an emitted [300] is refused with a self-decide steer, never a park into the void). The 300 **teaching is injectable, never core packet material** (owner ruling, same rationale): a choice prompt isn't always appropriate to advertise — an operator who wants the capability injects its doc (`PLURNK_SERVICE_MD_*` or client docs).

### §exec EXEC

AST: `{ op: "EXEC", target (cwd), body: string | null (command), signal: string | null (runtime tag), lineMarker (timeout/poll) }`.

Engine routes unconditionally to `exec` scheme (path slot is `cwd`, not a URI). The runtime slot (`signal`) selects an executor, resolved against the boot-time `ExecutorRegistry` — siblings discovered and probed at startup, availability cached, default `sh`. Unknown or unavailable runtime → 501 carrying the probe `detail`. {§exec-registry-resolves}

**Timeout and poll — `<T,P>` on the `<L>` slot (grammar 0.74.20).** EXEC repurposes the line-marker slot as `<timeout, poll>` in **seconds** (consistent with the `seconds=` stream-age render). `T` (mark[0]) caps the spawn's lifetime: at `T>0` the service aborts it (a bounded reap — polite signal then SIGKILL after `PLURNK_SERVICE_EXEC_KILL_GRACE_MS`) and stamps the stream **504**, distinct from a deliberate kill (499) or a clean exit (200). `-1` / absent → unbounded (loop-life bounded), the background-stream behavior. **`0` → turn-scoped**: the stream is reaped at the run's *next pre-turn* (via the registry abort, before the turn's own spawns), so it never survives into the subsequent turn; its terminal output surfaces born-OPEN like any close (§exec-stream). {§exec-timeout} `P` (mark[1]) is the hibernation **poll cadence**, stored on the subscription: while the loop is *parked* (`SEND[102]<T,P-style>` — the poll rides the subscription), the daemon arms a per-run timer for the tightest open poll cadence and resumes the slept loop every P seconds (floored by `PLURNK_SERVICE_EXEC_WAIT_MS` so it can't tick faster than a turn settles) to inspect progress (the same 202→100 resume a stream conclusion uses, §run-lifecycle). It does **nothing while the loop is active** — an active loop already gets the ambient folded stream deltas (§exec-stream), so the poll-wake matters only across hibernation. A park with no polled stream gets no timer (it sleeps until a conclusion or its own deadline wakes it). {§exec-poll}

**Effect-gating.** Each executor declares an `effect` (`pure` | `read` | `host`); the service maps it to policy (`EffectPolicy`). A `host` runtime (subprocess; file-backed sqlite) mutates the host → **propose** (lifecycle §proposal): the run waits for a human gate, then spawns and writes stdout/stderr to channels of a `<runtime>:///<loop>/<turn>/<seq>` entry (the runtime tag is the URI scheme, §exec/#240; the coordinate matches the op's log-row coordinate, e.g. `sh:///1/1/2`), returning `102 Processing` immediately. Channel state transitions (`active` → `closed`/`errored`) drive what the model sees at subsequent turn boundaries (§channel-state). {§exec-host-proposes}

A `read` runtime (observes external state, e.g. search) or `pure` runtime (no observable effect, e.g. `:memory:` sqlite) is side-effect-free → **auto-run**: no proposal, no human gate, no notification. It skips the gate a host command faces, but it does NOT resolve in-band — like every exec it backgrounds and streams, its output reaching the model through the environment-observation injector (a foisted READ of the stream's new bytes each turn, §exec-stream), never a same-turn receipt. {§exec-readpure-ungated}

**Stream surfacing.** An exec's output is *observed, not fetched*. Each turn the environment-observation injector — the same machine §env-delta rides — reads each of the run's open channels from a per-channel byte cursor and foists the new bytes as an `origin=plurnk` READ at `<runtime>:///<coord>#<channel>`, then advances the cursor — each delta carries the `startLine` that cursor implies, so a stream spanning turns numbers into one continuous sequence (lines 1–k, then k+1–m), not a fresh `1:` each turn. The delta is **folded** while the channel streams and auto-**opened** on the terminal one (the channel closed): a model ignores a chatty background run but always SEES a finished one. It never types these READs — it consumes them. The EXEC row itself renders the *command* it ran, `:::`-fenced and line-numbered per §render-rule so the model can line-reference its own code — the input, distinct from the stream above (the output). This is exec as an instance of one ambient machine, env-delta as another (sibling edits, timestamp cursor, always folded). {§exec-stream}

`SEND[499](exec:///<loop>/<turn>/<seq>)` cancels the in-flight subprocess via the subscription registry's stored `AbortController` — the coordinate addresses the spawn (`exec://` is the process-control face); the `<runtime>://` output entry delegates the same KILL to the one `Exec` handler that owns the abort state (§stream-control).

**Scoped environment.** An EXEC subprocess inherits the *project's* environment — its `.env`, the standard shell vars — so the model's commands run as the project expects; but never plurnk's own secrets: the provider API keys and `PLURNK_*` config are stripped before the spawn, so a model-run command can't `printenv` the engine's keys. The service owns the scoping policy (the denylist); the executor spawns with the env it is handed. {§exec-env-scoped}
- **The turn-hold exception** {§exec-hold-until-concluded} — for runtimes in `PLURNK_SERVICE_EXEC_HOLD` (a decision-table env, shipped listing the search family), an in-flight stream **pauses the cycle**: the next packet does not assemble until the stream concludes, so the model never burns a turn asking "are we there yet" about a result the engine controls end-to-end (one final JSON digest, seconds-bounded — the owner's ruling: this is the one special case where the stream is known well enough not to fall back on the standard cycle). Bounded by `PLURNK_SERVICE_EXEC_HOLD_MS` and **fail-open**: at the cap the standard cycle resumes untouched (parks, wakes, polls). Zero grammar or teaching surface — the model emits `EXEC + SEND[102]` as ever; the wake-shaped world simply arrives one packet sooner. Lives at the post-EXEC breath seam in `runLoop`, upstream of `PLURNK_SERVICE_EXEC_WAIT_MS`.
- **The entry() sink** {§exec-entry-sink} — an executor may *request* entry materialization (execs SPEC §2.6: every sink is a consumer-implemented callback; the executor owns zero substrate). The service implements it in exec dispatch: `entry(path, content, {tags, mimetype})` upserts the entry (writeEntry; tags **UNIONED** across writes — a re-seen URL keeps its history of query slugs), then narrates ONE `EDIT` row in the reserved `plurnk` run's log — the fs-fiction pattern, `source` = the calling run, `tokens` = the content's count, `attrs` carrying the tags — which the env-delta ambience (§env-delta) folds into every run's next packet as a one-liner. **No page body ever rides a packet**; the announcement is the folded meta line (path + tokens + tags), and the model READs/~queries what it chooses. Parallel `entry()` calls serialize on a per-spawn chain; a rejected call prunes that item executor-side (zero-dead-rows covers storage failure) without breaking the chain. The narration context (one plurnk-run turn) is lazy per spawn, not per entry. Born of the Web Search Epic's one-load flow (#340): search fetches once, materializes survivors tagged with the query slug, and writes the digest of survivors only.

### §proposal The proposal lifecycle

A side-effecting op does not execute on dispatch — it **proposes**. The scheme returns **202** (an EXEC `host` runtime §exec, an EDIT to a member file §membership); the engine writes the log row `state='proposed'`, registers a waiter keyed by `logEntryId`, and **pauses `dispatch`** awaiting a resolution. The pause is internal to dispatch — the turn has already closed, so §grinder strike accounting sees the *resolved* status, never the 202. On accept the status becomes 200 and the scheme's effect runs. {§proposal-202-pauses}

**Resolution arrives four ways, one surface to the model:**
- **`loop.resolve`** (§methods) — a client's accept / reject / cancel.
- **Server-YOLO** (§dual-yolo) — an in-tree listener resolves `accept` in-process, same tick, no wire roundtrip.
- **noProposals** — an in-tree listener resolves `reject` (outcome `no_review_channel`).
- **Timeout** — `PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS` (§operator-config) elapses with no resolution → the engine synthesizes `cancel` (outcome `timeout`), server-side, needing no client. {§proposal-timeout-cancels}

**The decision drives a one-way state transition** on `log_entries.state` (resolution is idempotent — `WHERE state='proposed'`, so a second resolution 404s):

| decision | state | `status_rx` | default outcome | effect |
|---|---|---|---|---|
| accept | `resolved` | 200 | — | runs the scheme's **`applyResolution`** — the real side effect (disk write, exec spawn). {§proposal-accept-applies} A failing apply (≥400) downgrades to reject, carrying the apply's own outcome — e.g. a member EDIT's `write_conflict` from its write-back compare-and-swap (§membership-edit-write-cas) — or `apply_failed` when it names none. |
| reject | `failed` | 400 | `rejected` | none — the action did not occur. {§proposal-reject-fails} |
| cancel | `cancelled` | 499 | `loop_aborted` | none — the loop is abandoning. {§proposal-cancel-aborts} |

A caller-supplied `outcome` overrides the default. On an **accept** it stays forensics-only; a **non-accept** carries it as the `rx`'s terse `error` token (`write_failed` / `rejected` / `timeout` — one word, never prose), because "the action didn't occur" without the mechanical why leaves the model acting on a phantom success (the fan-out dead-park: an ENOENT apply rendered as a mute 400). {§proposal-outcome-terse-error}

**A proposed row is invisible until it resolves.** A `state='proposed'` / 202 row is withheld from the `log` section; it surfaces only after resolution, carrying its terminal status — the model sees outcomes, never pending proposals. {§proposal-proposed-hidden}

---

## §stream Stream Model

Streams are static content from the engine's perspective — content arrives over time, channels grow, mimetype handlers render whatever's there at turn boundaries. No engine-level transaction abstraction; schemes own connection lifecycle. {§stream-no-engine-transaction-abstraction}

### §subscriptions Subscriptions

READ on a streaming scheme is a subscription, not a one-shot. Scheme opens the connection (SSE/WS/subprocess), returns `102 Processing` immediately, stays alive. Engine records `(sessionId, entryId) → schemeName + handle` in a subscription registry so `SEND[499]` cancellation routes to the owning scheme. {§subscriptions-subscription-registry-routes-cancellation}

Subscription registry is plurnk-service runtime state (its own SQLite table). Exists ONLY for cancellation routing. Channel state (§channel-state) + log entries (§no-chunk-rows) carry lifecycle.

FOLD/OPEN toggles `log_entries.expanded` (§open-fold) — a per-run render bit, never the subscription registry. FOLDing a streaming entry's log row collapses its body out of the packet but leaves the live stream running: curation is render-only, never cancellation. {§subscriptions-fold-keeps-subscription}

### §chunk-accumulation Chunk accumulation

SSE event types, WS message types, exec stdout/stderr each map to a named channel. Channel record (`ChannelContent`): `content`, `mimetype`, `tokens`. Active-connection state lives in the subscription registry, not on the channel. Chunks accumulate into the channel as they arrive — not buffered until close. {§chunk-accumulation-chunks-accumulate}

### §no-chunk-rows No per-chunk log rows

Channels are the source of truth for chunk content. Log captures lifecycle events only: open (102), graceful close (200), cancel (499), errors (5xx), scheme-significant transitions. {§no-chunk-rows-log-captures-lifecycle-only}

Model sees lifecycle events in the `log` section per turn.

### §deep-slices Deep slices on demand

`<<READ(sse://feed/x#data)<N-M>:…:READ` pulls a slice into a log row when the model wants a specific line-range of the stream.

### §stream-control SEND for stream control

- **Cancel:** `<<SEND[499](sse://feed/x)::SEND` — scheme tears down via AbortController.
- **Write:** `<<SEND[200](wss://feed/x):body:SEND` — pipes body into active connection (WS, exec stdin, etc.).

### §stream-constraints Engine constraints

ONE engine-level constraint: **100 MiB char-length cap per channel body**. `CHECK (length(content) <= 104857600)` on `entry_channels.content` (the genesis schema migration, `migrations/0000-00-00.01_schema.sql`). Violations → SQLITE_CONSTRAINT; action-entry captures rejection at status 500.

All other limits are extrinsic — providers (request size, model context, fetch timeouts), schemes (per-call validation), mimetypes (render budgets). Engine does not throttle, batch, rate-limit, or cap anything else. {§stream-constraints-engine-one-cap}

### §live-updates Live updates for clients (between turns)

Daemon emits `stream/event` notifications (§notifications) when channel content changes; clients use them for live waterfalls without polling. {§live-updates-stream-event-fires-on-chunk}

The model is NOT a stream/event consumer — turn-based only; sees whatever's in the channel at the next turn boundary.

---

## §storage Storage Model

SQLite (`node:sqlite`) with WAL mode and STRICT tables. Hand-written DDL; CI-aligned against grammar schemas.

### §ddl DDL strategy

No generator. SQLite-optimal: STRICT (3.37+), `INTEGER PRIMARY KEY` aliasing, explicit `NOT NULL`, indexed query paths, deliberate FK `ON DELETE`/`ON UPDATE`, `WITHOUT ROWID` where access pattern warrants, generated columns, FTS5.

- One `.sql` file per cohesive concern under `migrations/`, **date-prefixed and basename-sorted** for deterministic apply order (`0000-00-00.01_schema.sql` is the genesis).
- DDL lives in `-- INIT: <name>` blocks (`CREATE TABLE IF NOT EXISTS`) that `@possumtech/sqlrite` runs idempotently at DB open — re-running is a no-op by construction, so today there is no separate `migrate` CLI or applied-marker table. A fresh DB is the recovery story while the project is greenfield-solo.
- **Forward — apply-once evolution.** The idempotent-`INIT` model creates a fresh schema but does not *evolve* a populated one. When persisted state outlives a "just nuke it" reset, the date-prefixed ordering is the foundation a real migration policy layers onto: ordered `ALTER` files applied once and recorded in a marker table, not recreated idempotently. The current scheme is chosen so that transition is **additive** — a marker table plus apply-once dispatch — never a restructuring of how DDL is authored or ordered.
- **Schema-alignment test**: loads `@plurnk/plurnk-grammar/schema/*.json`, parses DDL via `node:sqlite` introspection, asserts every required schema field has a corresponding `NOT NULL` column. Grammar drift fails CI.
- DDL = storage truth; JSON Schemas = wire truth. Tested-aligned, allowed to differ where ergonomics demand.

### §sql-ts-boundary SQL/TS responsibility boundary

**Lives in SQL:**
- Render queries — log assembly + the manifest catalog.
- Cross-scope path collision (CHECK/trigger → 409).
- Cost rollups (denormalized pico-units; atomic on turn close).
- Sequence number issuance (1-based per grammar).
- Entry-vs-log integrity.

**Lives in TS:**
- Status-bubble rules (`turn.status` → `loop.status` → `run.status` → `session.status`). Engine UPDATEs explicitly; CHECK constraints enforce; triggers fight branching state machines.
- Tokenization (provider-bound; hot-swap re-tokenizes per §tokenomics).
- Provider dispatch + response normalization.
- Scheme-handler invocation (connections, subprocesses, fetch).
- Plugin loading (§plugin-discovery).
- Stream AbortController lifecycle.
- CLI + daemon.

When SQL becomes onerous for a specific case, retreat for that case and document why.

---

## §plugin-discovery Plugin Discovery

Scoped-package scan with manifest field:

1. Each package declares its kind:
   ```json
   { "name": "@plurnk/plurnk-providers-openrouter",
     "plurnk": { "kind": "provider", "name": "openrouter" } }
   ```
2. Boot scans `node_modules/@plurnk/*/package.json`, filters by `plurnk` field, dynamic-imports matches.
3. Load order: deterministic alphabetical.
4. Collision on `(kind, name)` is fail-hard.
5. Operator flow: `npm i @plurnk/plurnk-<kind>-<name> && plurnk start`. Zero config.

Env vars configure installed plugins; never declare existence. Filesystem is the source of truth.

`plurnkContractVersion` on each manifest declares SPEC target version; engine refuses incompatible plugins. (Wired post-v1.0.)

---

## §bundled-set Bundled Set

Plugin discovery (§plugin-discovery) registers whatever's in `node_modules/@plurnk/*`.

**Providers in-tree:** none. `Mock` (the intg-only test fixture + worked example) is a sibling, `@plurnk/plurnk-providers` (§mock-provider); `ProviderInstantiate.ts` dynamically imports the selected provider package.

**Mimetypes in-tree:** none. Framework + handlers are all siblings.

**Schemes in-tree (`src/schemes/`)** — transitional; each extracts to a sibling under [plurnk-schemes](https://github.com/plurnk/plurnk-schemes) as the framework matures:

| In-tree | Future sibling | Notes |
|---|---|---|
| `Known.ts` | `@plurnk/plurnk-schemes-known` | Primary narrative entries; session-scoped. |
| `Unknown.ts` | `@plurnk/plurnk-schemes-unknown` | Open questions / decomposition. |
| `Skill.ts` | `@plurnk/plurnk-schemes-skill` | Skill docs; same shape as known. |
| `Plurnk.ts` | may stay in-tree | `plurnk:///prompt/<loop_id>` carries each loop's prompt. Model-origin writes to `plurnk:///prompt/*` rejected in-handler. |
| `Log.ts` | may stay in-tree | Read-only coordinate-addressed (`log:///<L>/<T>/<S>`). Renders as a JSON meta line in the `log` section; status ≥ 400 mirrors to the `errors` section (§telemetry). |
| `File.ts` | `@plurnk/plurnk-schemes-file` | Filesystem-backed. **Model is never trained on `file:///` and never sees it.** Bare paths are model-facing; `file:///` accepted as input, renders bare. |
| `Exec.ts` | stays in-tree | Dispatches EXEC op to runtime executors registered via [plurnk-execs](https://github.com/plurnk/plurnk-execs). |

**Executors in-tree:** none. Framework + every runtime are siblings. `Exec.ts` dispatches by the EXEC op's `runtime` slot (`sh` default, `node`, `python`) to the matching sibling. Today's registry is hardcoded; plugin discovery migration tracked in [plurnk-execs#1](https://github.com/plurnk/plurnk-execs/issues/1).

---

## §grammar Grammar Dependency

`@plurnk/plurnk-grammar` is the contract. Authoritative; surface gaps via issue, adopt what lands. Don't redesign from this side.

### §grammar-provides What grammar provides

- Parser (`PlurnkParser`, ANTLR4) — DSL text → `PlurnkStatement[]`.
- AST types — exported TypeScript interfaces.
- JSON schemas (`schema/*.json`, draft 2020-12) for every wire shape.
- `plurnk.md` — canonical model-facing DSL description.

### §service-tracks What plurnk-service tracks (NOT in grammar)

- Channel state (`active`/`closed`/`errored`) — subscription registry, not on `ChannelContent`.
- Backpressure caps — none (§stream-constraints).
- Stream cancel — `SEND[499]` (§stream-control).
- Delete — `KILL` (entry-KILL, the canonical delete, §move); `SEND[410]` also deletes as a side-effect (§send-dispatch).
- Per-loop flags — `loops.flags` JSON column; `yolo` end-to-end today, others scheduled.
- Default-channel wire rendering — §channel-selection.

---

## §operator-config Operator Configuration

Env-var cascade: `.env.example` < `.env` < `.env.<config>` (via `--config=`) < shell < CLI flags. `src/service.ts` auto-loads `.env.example`; zero-setup boot.

Model selection: separate alias cascade in `ProviderRegistry` (§provider-instantiation). `PLURNK_MODEL_<alias>=<provider>/<model-id>` declares; `PLURNK_MODEL=<alias>` selects. Aliases live in `.env`, not `.env.example` (operator-specific).

| Var                                  | Default            | Status     | Purpose                                                       |
|--------------------------------------|--------------------|------------|---------------------------------------------------------------|
| `PLURNK_SERVICE_DB_PATH`                     | `./plurnk.db`      | enforced   | SQLite file path.                                             |
| `PLURNK_HOST`                        | `127.0.0.1`        | enforced   | Bind address for the daemon WebSocket. Local-only by default. |
| `PLURNK_PORT`                        | `3044`             | enforced   | TCP port for the daemon WebSocket.                            |
| `PLURNK_SERVICE_MAX_TURNS`                   | `-1`               | enforced   | Operator turn **ceiling** — `-1` = no cap; a positive value caps a per-call `loop.run({maxTurns})`. |
| `PLURNK_SERVICE_MAX_COMMANDS`                | `99`               | enforced   | Per-emission op cap. Overflow ops drop silently; one `max_commands_exceeded` telemetry entry surfaces on the next packet. |
| `PLURNK_SERVICE_RPC_TIMEOUT`                 | `30000`            | enforced   | ms deadline for non-`longRunning` RPC handlers; expiry answers `-32007 Timeout` (§errors) and the abandoned handler's late outcome is logged, never re-answered. `longRunning` registrations (proposal-pausing ops, external installs) are exempt. {§operator-config-rpc-timeout} |
| `PLURNK_SERVICE_LOOP_TIMEOUT`                | `86400000`         | enforced   | ms wall-clock budget for a single `loop.run`: expiry aborts the loop signal mid-flight (a stuck `generate` included) and the loop terminates `504 loop_timeout` — a legible engine terminal, kin to the exec `<T>` reap's 504 (§exec-timeout). {§operator-config-loop-timeout} |
| `PLURNK_SERVICE_MAX_STRIKES`                 | `3`                | enforced   | Strike threshold + sudden-death lead time (§engine-rails).             |
| `PLURNK_SERVICE_MIN_CYCLES`                  | `3`                | enforced   | Min repetitions before cycle detection fires (§engine-rails).          |
| `PLURNK_SERVICE_MAX_CYCLE_PERIOD`            | `4`                | enforced   | Max period length cycle detection examines (§engine-rails).            |
| `PLURNK_SERVICE_MD_<ALIAS>`                  | (unset)            | enforced   | Operator reference doc: materializes `<path>` as `plurnk:///<ALIAS>.md`, auto-READ into every model run's turn 0 (§actor-boundary). `~` expands to home. |
| `PLURNK_SERVICE_FILES_ITEMS`                 | `-1`               | enforced   | Turn-0 catalog preview, one `FIND(scheme:///**)` per scheme. Memory/scratch/docs always full; the first-`N` cap applies **only** to the `file` list. `-1` = all full; positive `N` = file list first-N (memory still full); `0` / unset = off (§actor-boundary-catalog-preview). |
| `PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS`         | `300000`           | enforced   | ms wait for a proposed entry (status=202) to be resolved before timing out.  |
| `PLURNK_PROVIDERS_THINKING` + `_CAPACITY` | `on` / `4096`      | enforced   | The activation/capacity split (providers 0.31; a numeric budget silently flipping template flags was secret flag-setting). `off | adaptive | on`; capacity (tokens) REQUIRED when on, shipped equal to the partition's REASONING reserve (template-pinned). A think-trained model MUST think — off reroutes its thought into the grammar's legal free zone as prose. One setting is right everywhere: providers clamp thinking to none on in-band (response_format) grammar calls themselves, so the channel-topology parallax needs no per-backend override. F7 coupling: llama-server honors only the box's `--reasoning-budget` launch flag (must equal capacity; boot-warned). |
| `PLURNK_PROVIDERS_FETCH_TIMEOUT`     | `600000`           | enforced   | Service-wide ms ceiling on any outbound request (providers, future http schemes). Module-specific overrides are allowed below the ceiling. |
| `PLURNK_SERVICE_DEBUG`                       | `0`                | reserved   | Schema-validation toggle. Not yet enforced.                   |
| `PLURNK_SERVICE_LOG_LEVEL`                   | `info`             | reserved   | Stdout banner verbosity. Not yet enforced.                    |

**enforced** = engine reads and acts on the value. **reserved** = shipped in `.env.example` (forward-spec) but no-op until wired.

**Two override semantics — ceiling vs default.** Which kind a var is determines what "override" means across the cascade:
- **Ceiling** (most-restrictive-wins) — an operator-set hard bound nothing downstream may exceed: not a lower-precedence file, not a per-session constraint, not a per-call RPC arg. `PLURNK_SERVICE_GIT_ALLOWED` (`=0` flatly denies git service-wide, §membership), `PLURNK_SERVICE_MAX_COMMANDS`, `PLURNK_SERVICE_MAX_STRIKES`, `PLURNK_PROVIDERS_FETCH_TIMEOUT` (module overrides allowed only *below* it), and `PLURNK_SERVICE_MAX_TURNS` (`-1` ships it off; a positive value caps the per-call request). The sandbox/cost guarantee: the operator caps it; no client widens it.
- **Default** (explicit-wins) — a fallback the most-specific setter replaces freely: `PLURNK_MODEL` (a `loop.run({alias})` overrides it), `PLURNK_SERVICE_REQUIREMENTS` (the per-call requirements default), and the config-time vars (`HOST` / `PORT` / `DB_PATH`).

**The shipped `.env.example` is itself under test** (no active `PLURNK_SERVICE_MD_*` doc alias — the policy is a SECTION, a doc default double-injects it; no active `PLURNK_MODEL`; an actively-resolving `PLURNK_PROVIDERS_GBNF`; the policy renders in exactly one packet section): every other tier runs the test cascade, so shipped-default regressions are invisible to it by construction. {§operator-config-shipped-defaults} Its companion **flag-parity** check binds code and template both ways: every `PLURNK_SERVICE_*` the service reads has a `.env.example` line (a floor, a `--flag`, a legend entry) and every declared `PLURNK_SERVICE_*` is read — so a half-landed rename (a missed file, a script-glob gap) fails a test instead of a user's boot, and a dead knob can't ship. {§operator-config-flag-parity}

Enforcement is per-use-site — no central most-restrictive pass; each ceiling is checked where it bites. `PLURNK_SERVICE_MAX_TURNS` ships **off** (`-1` = no cap; the loop ends via SEND, budget, strikes, or cycle detection) and, when an operator sets a positive value, the per-call request is `min()`-capped against it. {§operator-config-max-turns-ceiling}

**Client open-context (per session).** `session.create({settings})` carries per-session overrides, persisted on `sessions.settings` and composed against env at each knob's read-site. Two families, kept distinct so neither semantic leaks into the other; operator-arcane knobs stay env-only — this is the narrow client surface.

*Defaults — explicit-wins (the client replaces/merges freely):*
- `settings.filesItems` (number) **replaces** `PLURNK_SERVICE_FILES_ITEMS` for the session: a one-shot opens clean (`0`, no preview), a workspace full (`-1`), or with the file list capped (`N`, memory still full). A single scalar — the client value wins outright. {§operator-config-session-files-items}
- `settings.mdDocs` (`[{alias, content}]`) **unions** with the server's `PLURNK_SERVICE_MD_*` docs, keyed by alias — a client adds its own repo docs atop the operator's systemwide policy doc. On alias collision the client wins (a deliberate shadow), but by default the policy doc rides into every session. The client sends content (it owns the file), not a path. {§operator-config-session-md-docs}

*Ceilings — most-restrictive-wins (the client may only narrow, never widen):*
- `settings.maxCommands` (number) **min()s** the `PLURNK_SERVICE_MAX_COMMANDS` per-emission cap for the session — a client tightens the runaway-op guard, never raises it past the operator's. {§operator-config-session-max-commands} The cap bounds *actions* only: PLAN (reasoning) and a terminal `SEND` (signal ≥ 200, the conclusion) are never counted and always dispatch — so `0` is a valid floor (the tightest), admitting a plan and a conclusion with zero actions. {§operator-config-session-max-commands-floor}
- `settings.git` (`false`) **denies** git for the session (`PLURNK_SERVICE_GIT_ALLOWED` AND session) — the client opts its session out of git membership + telemetry; it can never re-enable git past the operator's service-wide lockout. {§operator-config-session-git}

Feature-flag bools use `process.env.X === "1"` exactly — never `=== "true"`.

External plugins declare their own env vars in their own `.env.example`; service merges at boot via the cascade.

**Admin CLI flag derivation.** `src/service.ts` auto-derives flags from `.env.example`: every `PLURNK_*` becomes `--<kebab-cased-name>` (prefix stripped, lowercased, underscores → dashes). Comment immediately above (no blank line) becomes `-h` description. Non-`PLURNK_*` vars in `.env.example` are bugs — vendor config belongs in the vendor's package namespace.

---

## §rpc RPC Surface

plurnk-service runs as a daemon. Clients (TUI/CLI/neovim/web/Telegram/etc.) drive it via self-describing RPC. This section is the wire — implementing a new client should require reading only §rpc.

### §transport Transport

WebSocket (`ws` npm). One message per `ws.send`. UTF-8 JSON. One full-duplex connection per client. Bind: `PLURNK_HOST:PLURNK_PORT` (default `127.0.0.1:3044`).

Out of scope for v0: auth, TLS, multiplexing. Local-loopback + filesystem permissions are the access control.

### §protocol Protocol

JSON-RPC 2.0. Two message kinds:

- **Request:** `{ "jsonrpc": "2.0", "id": …, "method": …, "params": … }`. Server replies with matching `id`.
- **Notification:** `{ "jsonrpc": "2.0", "method": …, "params": … }`. No `id`; server-initiated; no reply.

Success response: `{ "jsonrpc": "2.0", "id": …, "result": … }`. Failure: `{ "jsonrpc": "2.0", "id": …, "error": { "code": …, "message": …, "data": … } }`.

### §method-registration Method registration

```ts
registry.registerMethod("loop.run", {
    handler: async (params, ctx) => { /* ... */ },
    description: "Run a model-driven loop with a prompt.",
    params: {
        prompt: "string — the user prompt for the loop",
        maxTurns: "number? — defaults to PLURNK_SERVICE_MAX_TURNS",
        alias: "string? — overrides the boot-time PLURNK_MODEL",
    },
    requiresInit: true,
    longRunning: false, // returns immediately (finalStatus:100); the loop runs async, §methods
});
```

- `description`: one-liner surfaced by `discover`.
- `params`: `"type — meaning"` per param; `?` suffix = optional. Self-documenting, not enforced.
- `requiresInit`: rejects until a session is attached.
- `longRunning`: exempt from `PLURNK_SERVICE_RPC_TIMEOUT`. {§method-registration-register}

### §discovery Discovery

`discover` returns the catalog:

```json
{
    "methods": {
        "ping": { "description": "Liveness check.", "params": {} },
        "loop.run": { "description": "Run a model-driven loop.", "params": {...} },
        "...": "..."
    },
    "notifications": {
        "log/entry": { "description": "A new log_entries row was written.", "params": {...} },
        "loop/terminated": { "description": "A loop reached a terminal status.", "params": {...} },
        "...": "..."
    },
    "capabilities": {
        "providers": [...],
        "schemes": [...],
        "mimetypes": [...]
    },
    "versions": {
        "service": { "installed": "0.34.0", "latest": "0.35.0" },
        "client": { "latest": "0.15.0" }
    }
}
```

`capabilities` lists registered plug-ins by `(kind, name)`. Cold clients call `discover` first. No hardcoded method names or capability lists in any client. {§discovery-discover}

`versions` rides the same round-trip so a client shows update status without per-invocation registry IO: `{ service: { installed, latest? }, client: { latest? } }`. `service.installed` is the daemon's own `package.json` version (honest self-report); `latest` is a **cached, best-effort** npm-registry poll (TTL `PLURNK_SERVICE_VERSION_POLL_TTL`) for the service (`@plurnk/plurnk-service`) and client (`@plurnk/plurnk`) packages — offline or registry-down omits `latest`, and the poll never blocks or fails `discover`. The client owns reading its own installed version and the semver compare. {§discovery-versions}

### §methods Core method set

**Liveness + introspection**

| Method     | Params | Result | Notes |
|------------|--------|--------|-------|
| `ping`     | none   | `{}`   | No init required. |
| `discover` | none   | catalog (§discovery) | No init required. |

**Sessions**

| Method                 | Params              | Result            | Notes |
|------------------------|---------------------|-------------------|-------|
| `session.create`       | `name?: string`, `projectRoot?: string`, `settings?: object` | `{ id, name, runId, runName, projectRoot }` | Creates new session + its first run; auto-name if unprovided. Returns the auto-created run's identity so clients skip the pending-dance ({§methods-session-create}). Optional `projectRoot` pins the workspace (null/omitted = headless); optional `settings` carries per-session open-context overrides (§operator-config). |
| `session.list`         | none                | `{ sessions: Session[] }` | Lists all sessions. |
| `session.attach`       | `id: number`, `runId?: number`, `runName?: string` | `{ id, name, runId, runName }` | Binds this connection to an existing session. Optional `runId` resumes that specific run (must belong to the session). Optional `runName` reuses-or-creates by name within the session. Both omitted → new auto-named run. {§methods-session-attach} |
| `session.runs`         | `id?: number`       | `{ runs: Run[] }` | Lists runs in a session (defaults to attached session); most-recent first. |
| `session.prompts`      | `id?: number`, `limit?: number` | `{ prompts: string[] }` | A session's prior user prompts (the conversation run's loop seeds), newest-first, capped by `limit` (default 100); defaults to attached session. Lets a client seed up/down recall without log archaeology. |
| `session.set_root`     | `projectRoot: string \| null` | `{ projectRoot }` | Update the workspace pointer on the attached session. Null reverts to headless. |
| `session.rename`       | `name: string` | `{ id, name }` | Rename the attached session — its name is a **mutable handle** on the world (unlike a run, whose name is frozen at instantiation, §machine-processes). Mutates `sessions.name` only; runs, log, and membership untouched. A name another session holds is rejected (`sessions.name` is unique). {§methods-session-rename} |
| `session.constrain`    | `effect: "pick" \| "hide" \| "view" \| "repo"`, `glob: string` | `{ effect, glob }` | Add a workspace membership constraint (§membership overlay): `pick` admits a file git misses (the sole source when git is absent), `hide` drops a tracked match, `view` admits a member read-only (refused at the edit gate), `repo` declares a git repo folder anywhere so its members join the manifest. Immediate. |
| `session.unconstrain`  | `effect: "pick" \| "hide" \| "view" \| "repo"`, `glob: string` | `{ effect, glob }` | Remove a membership constraint (the `drop` verb) — the inverse of `session.constrain`. Immediate. |
| `session.constraints`  | none                | `{ constraints }` | List the attached session's membership constraints. |
| `session.members`      | none                | `{ members: [{ path, effect }], hidden }` | Resolve each project file's membership effect — `members` tagged `member`/`view` plus the `hide`-excluded `hidden` — so a client signs file visibility (member / read-only / ignored) without reimplementing the overlay glob-matching (§membership-resolved-effects). |

**Re-binding.** `session.create` and `session.attach` may be called on a connection that already has a session attached — the connection switches in place, releasing the prior client loop (closed at 200). No reconnect needed to change session or run. {§methods-rebind}

**Auto-envelope.** Clients calling a `requiresInit: true` method without first attaching get auto-created session → run → client loop. Records persist normally; auto-created ≠ auto-deleted. Cleanup is a future `session.delete` / `session.archive` endpoint. {§methods-auto-envelope}

**Reserved run names.** `plurnk` is reserved for the runtime actor (§authority-terms). `session.attach` rejects it — case-insensitively, *before* the lookup-or-create — so a client can neither forge a `plurnk` run nor resume the runtime's, closing impersonation of `origin=plurnk`. The auto-namer never emits a reserved name. {§methods-run-name-reserved}

**Loops (model-driven)**

| Method            | Params                              | Result                 | Notes |
|-------------------|-------------------------------------|------------------------|-------|
| `loop.run`        | `prompt: string`, `maxTurns?: number`, `alias?: string`, `flags?: LoopFlags` | `{ loopId, action, finalStatus: 100 }` | Model-driven loop. **Accepts and returns immediately** (`finalStatus: 100`; `action` = `enqueued_new_loop` \| `injected_next_turn`) — it never blocks on the loop, which can park indefinitely (`SEND[102]<-1>`, §run-lifecycle-wake-liveness). The loop's outcome — `finalStatus`, `turnIds`, `hitMaxTurns`, `usage` — arrives on the **`loop/terminated`** event. Optional `alias` overrides the boot-time `PLURNK_MODEL`. Optional `flags` carries per-loop flags (`{yolo?: boolean}`; more as wired — see §engine-rails). Streams `log/entry` and `loop/proposal` during. `longRunning: false`. {§methods-loop-run} |
| `loop.resolve`    | `logEntryId: number`, `decision: "accept" \| "reject" \| "cancel"`, `body?: string`, `outcome?: string` | `{ status, logEntryId }` | Resolve a pending proposal (status=202 log entry). Engine.dispatch unpauses on resolution. |
| `loop.cancel`     | `reason?: string`                   | `{ cancelled, runId, reason }` | Abort the attached run's active drain. `{cancelled: true}` if a drain was running, `{false}` if idle. Cancelled loops close at 499; queued-but-unclaimed loops stay enqueued. Default reason `user_cancelled`. {§methods-loop-cancel} |
| `providers.list`  | none                                | `{ aliases: ProviderAlias[] }` | Lists configured `PLURNK_MODEL_<alias>` entries with `{alias, provider, model, active}`. Clients use to populate model-selection UI. |

**Reads**

| Method        | Params                              | Result                 | Notes |
|---------------|-------------------------------------|------------------------|-------|
| `entry.read`  | `target: string`                    | `{ status, entry }`    | Read the full entry shape (channels + tags + metadata) at the given URI. {§methods-entry-read} |
| `log.read`    | `loopId?`, `turnId?`, `loopSeq?`, `turnSeq?`, `sequence?`, `sinceId?`, `limit?` | `{ entries: LogEntry[] }` | Read recent log entries from the attached session. A full display coordinate (`loopSeq`+`turnSeq`+`sequence`) resolves the single entry behind an `L/T/S` waterfall line — full shape (tx + rx), server-side, no client fetch-all+match (#271). {§methods-log-read} |

**Log coordinate.** Every `LogEntry` — from `log.read` and the `log/entry` notification alike — carries `loop_seq`/`turn_seq`, the loop+turn ordinals, beside the `loop_id`/`turn_id` DB keys, so a client renders the logical coordinate (e.g. `01/02/03`) without resolving ids. {§methods-log-coordinate}

**DSL operations (client-driven, mirror grammar)**

Per the **Speak in DSL, not plumbing** rule (AGENTS.md): `op.*` methods construct DSL statements internally and dispatch through `Engine.dispatch`. {§methods-op-mirror} Param shapes are ergonomic (semantic names, not HEREDOC slots); semantics are the DSL's.

Each `op.*` call creates a turn in the connection's client loop (§connection-lifecycle), dispatches, fires `log/entry`, returns the dispatch result.

Naming: `target` = URI the op acts on; `scope` for FIND; `source`/`destination` for COPY/MOVE; `recipient` for SEND (or null = broadcast); `cwd` for EXEC. `path` is reserved for *identity* — never an RPC operand.

| Method        | Params                                                  | Notes |
|---------------|---------------------------------------------------------|-------|
| `op.find`     | `scope: string`, `matcher?: string`, `tags?: string[]`, `lineRange?: LineMarker` | Mirrors `<<FIND>>`. |
| `op.read`     | `target: string`, `matcher?: string`, `lineRange?: LineMarker`, `tags?: string[]` | Mirrors `<<READ>>`. |
| `op.edit`     | `target: string`, `content?: string`, `tags?: string[]`, `lineRange?: LineMarker` | Mirrors `<<EDIT>>`. |
| `op.copy`     | `source: string`, `destination: string`, `tags?: string[]`, `lineRange?: LineMarker` | Mirrors `<<COPY>>`. |
| `op.move`     | `source: string`, `destination?: string`, `tags?: string[]`, `lineRange?: LineMarker` | Mirrors `<<MOVE>>`. Missing `destination` = delete (null-body MOVE). |
| `op.open`     | `target: string`, `matcher?: string`, `tags?: string[]`, `lineRange?: LineMarker` | Mirrors `<<OPEN>>`. |
| `op.fold`     | `target: string`, `matcher?: string`, `tags?: string[]`, `lineRange?: LineMarker` | Mirrors `<<FOLD>>`. |
| `op.send`     | `status: number`, `recipient?: string`, `body?: string` | Mirrors `<<SEND>>`. |
| `op.exec`     | `cwd?: string`, `runtime?: string`, `command?: string`  | Mirrors `<<EXEC>>`. |
| `op.dispatch` | `statement: PlurnkStatement`                            | Low-level path for clients that have a parsed AST already (e.g. the TUI when the user types raw HEREDOC at the prompt). |
| `op.parse`    | `text: string`                                          | Convenience: daemon parses raw DSL text via the grammar, dispatches each statement as actions of one turn, returns `{ results: DispatchResult[] }`. |
| `op.look`     | `text: string`                                          | Non-logging READ: resolves the target via READ's full scheme resolver and returns its content, writing **no** log entry. The client's off-run inspection primitive — forward `<<LOOK>>` with the op token rewritten `LOOK`→`READ`. READ-only. {§op-look} |

All `op.*` return `{ status, ...op-specific }`. All `requiresInit: true`. None `longRunning`.

**`op.look` is the exception** to the "creates a turn, fires `log/entry`" rule above (§methods-op-mirror): it runs READ's full resolver (every scheme, full grammar — the client stays grammar-blind, forwarding its `<<LOOK>>` text with the op token swapped to `READ`) but mints **no turn and writes no `log_entries` row** — the read leaves no trace the model can see, the human-side counterpart to membership-gated model reads (§operator-config, "the boundary is the client's"). It resolves against the connection's client loop so run-relative coordinates (`log:///<L>/<T>/<S>`) resolve correctly. Where `entry.read`/`log.read` leave no row but are scheme-limited, and `op.read` resolves everything but logs, `op.look` resolves everything **and** doesn't log. A non-READ statement is rejected. {§op-look}

Future: `subscription.list`, `subscription.cancel` (the latter is `op.send({status: 499, recipient})` today).

### §notifications Notifications

Server-initiated events on the same WebSocket.

| Notification       | Params                              | When fired |
|--------------------|-------------------------------------|------------|
| `log/entry`        | `{ entry: LogEntry }`               | Every `log_entries` write. {§notifications-log-entry-notify} |
| `loop/terminated`  | `{ loopId, finalStatus, hitMaxTurns }` | Loop reaches terminal status. |
| `loop/quiesced`    | `{ loopId, runId, status: 202 }` | A parked loop (`[102]<T>`/`<-1>`) reached subtree-quiescence (no open stream, no non-terminal child) — idle/complete-for-now but **reawakable**, distinct from `loop/terminated` (§run-lifecycle-quiesced). |
| `loop/proposal`    | `{ logEntryId, sessionId, runId, loopId, turnId, op, target, body, attrs, flags }` | Dispatch pauses on status=202. Carries `flags` so server-YOLO clients can suppress review UI. Client responds with `loop.resolve` (or `PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS` fires). |
| `session/created`  | `{ id, name, projectRoot }` | Any client creates a session. |
| `stream/event`     | `{ entryId, channel, state, contentLength }` | Channel content grows or state transitions. {§notifications-stream-event-on-channel-change} |
| `stream/concluded` | `{ entryId, target, subscriptionId, scheme, closeStatus, summary, wakeAction, wakeLoopId? }` | A streaming subscription closed (subprocess finished / errored / cancelled). `wakeAction` says how the conclusion reached the run: `resumed-loop` (a slept `202` loop resumed in place, §run-lifecycle-wake-liveness), `no-op-active-loop` (folded into a live loop's next turn), `skipped-aborted`/`skipped-cancelled`/`skipped-no-provider`, or `no-loop` (nothing to resume). `summary` rides the notification for client display; it is no longer fed to the model as a prompt. {§notifications-stream-concluded} |
| `telemetry/event`  | `{ loopId, event: TelemetryEvent }` | A TelemetryEvent (parse error, engine-rail strike/cycle/sudden-death, scheme/provider failure) was buffered — the same envelope the model sees on the next packet, delivered live for client surfacing. {§notifications-telemetry-event} |

`stream/event` carries metadata only, never content. Clients fetch via `entry.read({target})`. **Every notification envelope carries its `sessionId`** (and `runId` where the emitter has it) so a multi-session client — one connection, many sessions — can route it ({§notifications-envelope-carries-sessionid}); the broadcast stays session-scoped too.

### §connection-lifecycle Connection lifecycle

```
[client]                                          [daemon]
   |                                                 |
   |-- ws.connect ----------------------------------->|
   |<------- on('open') --------------------------- |
   |                                                 |
   |-- discover() ---------------------------------->|
   |<------- { methods, notifications, capabilities }|
   |                                                 |
   |-- session.attach(id=42) ------------------------>|
   |<------- { id: 42, name: "demo-session" }       |
   |   (daemon opens a client loop in session 42)    |
   |                                                 |
   |-- loop.run(prompt="...") ----------------------->|
   |<-- notification: log/entry { ... }              |
   |<-- notification: log/entry { ... }              |
   |<-- notification: loop/terminated { ... }        |
   |<------- { loopId, turnIds, finalStatus: 200 }   |
   |                                                 |
   |-- op.dispatch(op=...) -------------------------->|
   |<-- notification: log/entry { ... }              |
   |<------- { status: 201 }                         |
   |                                                 |
   |-- ws.close ------------------------------------->|
   |   (daemon closes the client loop; session keeps)|
```

**The client's run.** A client connection is an actor (§machine-processes); its `op.*` write to its **own run** — `origin = "client"`, one loop per connection — and `log.read` reads that run. Disconnect closes the loop's status; rows persist. Multiple connections each get their own client run.

`loop.run` and `inject` target the **model's run** — a separate run holding the conversation, `origin = "model"`. Both runs share the session's one filesystem (§machine-processes); the packet renders only the model's run, so the client's ops are structurally absent from it — no origin filter (§actor-boundary-isolation). The model run (`Envelope.ensureModelRun`) and the connection's client run are distinct, each lazily allocated on first use — the §machine-processes conflation is corrected.

### §errors Errors

Standard JSON-RPC codes:

| Code   | Meaning                       |
|--------|-------------------------------|
| -32700 | Parse error (malformed JSON)  |
| -32600 | Invalid request               |
| -32601 | Method not found              |
| -32602 | Invalid params                |
| -32603 | Internal error                |

Plurnk-specific (`-32000` to `-32099`):

| Code   | Meaning                                            |
|--------|----------------------------------------------------|
| -32000 | Not initialized (requires session attach)          |
| -32001 | Session not found                                  |
| -32002 | Loop not found                                     |
| -32003 | Entry not found (engine 404)                       |
| -32004 | Provider unavailable                               |
| -32005 | Scheme unavailable                                 |
| -32006 | Mimetype unavailable                               |
| -32007 | Timeout                                            |

Error responses MAY include `data: {…}` with structured context (404'd path, timed-out method, etc.). {§errors-error-codes}

### §versioning Versioning

Pre-stabilization. Clients track HEAD. No semver until the interface is worth committing to.

---

## §decisions Architectural decisions

Each entry: question, answer, rationale, migration path.

### §packet-assembly Packet assembly: engine builds the default list, plugins transform it

**Question.** Rummy uses priority-ordered filter chains for packet assembly. Plurnk builds a default ordered section list directly in `PacketBuilder.buildRequestPacket`, then lets trusted plugins rewrite it.

**Decision.** Two stages. (1) The engine builds the default section list. `slot` is a **trust boundary**: the system slot carries only framework-authored, non-injectable sections — `definition`, `tools`, `schemes`, the policy sections `system-policy`/`project-policy`, then the framework-status tail `errors` (uri+status pointers; the error item+body live in the log) and `git` (counts), with `budget` last (budget is law — a hard ceiling, the final word before the model acts). The user slot carries injectable content — `prompt` and `log` (READ results, exec output, the model's own mirror: data at the action point, never a privileged rule) — plus the `requirements` footer. Nothing that can carry attacker-reachable text rides the system slot. (2) `SchemeRegistry.transformSections` pipes that list through every registered scheme that implements `transformSections(sections) → sections`, in registration order, before the engine measures. A plugin returns whatever list it wants — add, remove, reorder. {§packet-plugin-transform}

**Why a whole-list transform, not a per-section hook.** It is the legible, fork-avoiding seam: a plugin that can reshape the packet to its needs never has a reason to fork the engine (§ecosystem). And it is **strictly in-process and trusted** (behind `PLURNK_PLUGINS_TRUSTED_ONLY`) — the client/RPC wire never reaches the packet, because handing an untrusted connection the model's entire context is exactly the actor-boundary violation the engine exists to prevent. Pure list-in/list-out; no context is handed to plugins.

**Rationale.** The section list is first-class data (not two hardcoded render functions), so the transform is a few lines over the existing registry-pull pattern (the engine already pulls the scheme catalogue and the tools sheet from the registries). The grinder/fold (§grinder) stays engine-owned — a closed build-time concern, never a plugin seam.

### §tokenomics Tokenomics: real provider tokens, render-weight budget, turn and entry weights

**Question.** How does plurnk track token costs accurately enough to ground the model's OPEN/FOLD/compose decisions? Accuracy is the whole game — a budget that smells wrong is one the model stops trusting and curating against.

**Two measures, never conflated:**

- **render-weight** — the tokens the model actually processes this turn (the assembled packet — manifest, log, system sections — plus meta + fences). The budget is about this.
- **content-depth** — an entry's full content size (`entry_channels.tokens`). The manifest's `tokens` is this.

**Built.**

- **Provider tokens, stored at write.** `provider.countTokens` is the source of truth; `entry_channels.tokens` (via `_entry-crud`) and `log_entries.tokens` (via `Dispatcher.#writeLog`) are populated at write as a write-time snapshot. A `ceil(len/DIVISOR)` fallback (the divisor tripwire) applies only when no provider tokenizer is wired. {§tokenomics-tokens-stored-at-write}
- **Render-weight budget.** The budget headline — `ceiling`, `tokenUsage`, `tokensFree` — is measured from the *assembled packet* (placeholders substituted after measuring), so it reflects what the model actually receives. A `SUM` of stored content-depth would mis-price the rendered packet; render-weight is the accurate measure. {§tokenomics-render-weight-budget}
- **Per-turn weight.** A markdown table groups render-weight by turn — the `loop/turn` coordinate prefix — listed chronologically (oldest first). The turn is the grinder's fold unit, and the rail folds only the **newest** (§grinder); the model sees which turns are fat and can FOLD ahead of the rail. {§tokenomics-turn-totals}
- **Heaviest entries.** A second table lists the five heaviest log entries by render-weight, each by its `log:///<coord>/<op>` handle — the FOLD targets behind the turn weight. The handle carries the turn, so the two tables interlock. {§tokenomics-largest-entries}
- **Context-window percent.** The headline carries usage as a percent of the ceiling — `usage Y (P%)` — a fullness gauge beside the absolutes. Reads the ceiling already in hand; no extra provider call. {§tokenomics-context-percent}
- **The window is a partition, never a fraction.** `effectiveWindow = min(PLURNK_SERVICE_CTX, provider.contextSize)` (CTX alone when the provider reports no window — the operator's policy stands in for unknown physics) splits **without remainder**: `promptBudget = effectiveWindow − REASONING − ASSISTANT − SAFETY` is what the service may send, `max_tokens = REASONING + ASSISTANT` is the generation envelope passed on **every** `generate({maxTokens})` — no decode is unbounded — and `SAFETY` covers chat-template overhead no content counter sees. The prompt ceiling is **derived, never set**: a settable ceiling lets policy contradict physics, and a fractional one budgets the prompt against the window while *forgetting the response lives there too* (at 0.9 × 49152, any emission past ~4.9k overflowed gemma with a perfectly honest ruler). Reserves exceeding the window (`promptBudget ≤ 0`) are a configuration contradiction and fail hard. When native thinking is on, llama-server ignores per-request numeric budgets — the serving box's `--reasoning-budget` launch flag must equal `PLURNK_SERVICE_REASONING`, and the service warns at boot when it cannot verify that coupling. **Shipped-defaults invariant: any ≥77Ki window partitions to exactly 65536 prompt tokens** (78848 − 4096 − 8192 − 1024). {§tokenomics-window-partition}
- **Derivation is off the hot path; search is never degraded by it.** The per-turn derivation pump and the session warm run on a background chain (serialized, drained at daemon stop, failures logged) — **a turn never waits on an embedding** (a 2-CPU container CPU-embedding a 335-entry ingest starved every loop ~28min). Full fidelity survives the move on both fusion halves: the **keyword half indexes at the write** (plain string→FTS, no handler invoked — a cold session's first query narrows over everything ever written) {§semantic-fts-at-write}, and a `~` query **derives its own FTS-narrowed candidate slice inline** at dispatch (bounded, cap-telemetered) — ranking only ever scores the narrowed set, so warming exactly that slice is bit-identical to a fully-warm corpus, from turn 1, on any hardware {§semantic-cold-query-full-fidelity}. {§derivation-off-hot-path}
- **Binary truth beats the label; no entry dominates the corpus.** A tracked member whose HEAD bytes contain NUL is materialized as a binary marker (empty body, `application/octet-stream`, READ-415) **regardless of what extension-based detection claims** — the markdown default for unmapped extensions once shipped a 3.3MB `.wasm` blob into the semantic corpus as prose, three copies, ~10M tokens (#320) {§membership-binary-sniff}. And the per-entry chunk cap is a **latency stage, never a coverage bound**: the inline (dispatch-time) slice embeds head-first up to its budget so a cold `~` answers in bounded seconds — and a capped pass does NOT stamp the deep hash, so the background pump completes the entry to full depth (a 300-page book is entirely searchable at steady state; rank cannot be dominated regardless — `semantic_rank` takes one best chunk per entry). A flat cap would silently foreclose legitimate large texts: head-only vectors under a whole-file keyword narrow return head-biased spans, permanently. {§semantic-entry-chunk-cap}
- **A turn is never blank; the provider never adjudicates.** A completed exchange ALWAYS returns from the provider — the model's bytes flow in `assistant` no matter what, with any grammar-conformance verdict riding `response.telemetry` as an **observation** (providers 0.32; the provider transports and observes — the engine's own parse is the judge). Every emission takes the one pipeline: complete statements dispatch, malformed text mints position-carrying parse-error rows the model reads next turn, nothing-parsed is the ordinary no-ops 422, and the record keeps the emission verbatim with its real usage billed. A `ProviderError` reaching the engine means NO completed exchange exists (auth, network beyond retries, rate limit) — an infrastructure failure, and the loop dies 500 carrying the cause, first occurrence: tolerating an infrastructure violation is how a bug accretes concentric layers of policy instead of a fix (the retired empty-turn fallback laundered provider adjudications into model-behavior 422s, and forensics chased the wrong suspect for days). {§turn-never-blank}
- **The ceiling calibrates to usage.** `countTokens` may be a heuristic ruler (the openai family defaults to chars/4; escaped-JSON log rows run ~2.7 real chars/token — honest arithmetic on that ruler shipped a 65k-real packet into a 49k window, #311). Every response carries ground truth: `usage.prompt` counts the whole wire request. The engine keeps each loop's observed real/measured ratio (monotone max — the worst-observed packing wins) and the effective ceiling is `ceiling / ratio`, so past a loop's first response a real context overflow is unreachable; turn 1 rides the floor-sized packet's natural headroom. The floor is **exact-only**: an exact ruler never expands past 1 (calibration only tightens), while a certified upper-bound ruler (no exact tokenizer — `gauge.exact === false`) calibrates to observed truth in BOTH directions — it overmeasures by construction, so expansion toward `usage.prompt` ground truth cannot overshoot the window, and refusing it silently halves the model's room (run24: a 256k grok strangled at ~35k real, six grinder fires, struck out without ever editing a file). A provider failure that still escapes lands as a loop-terminal **500 carrying the cause** on both the row and the `loop/terminated` broadcast — never a contentless 500 over a still-102 row. {§tokenomics-ceiling-calibrates-to-usage}
- **Curation pressure gates on occupancy.** The budget section's Turns/Heaviest tables — a standing FOLD-target list — render only at **50%+ occupancy** (assembled total / ceiling); below that the headline's numbers stand alone. A high-headroom model reads the tables as a todo and burns turns on token hygiene at 3–25% occupancy (#308, the bench grok run); a null ceiling can't calibrate, so the full readout stays. The requirements footer carries only the overflow-RECOVERY must, never ambient optimize-your-context pressure. {§tokenomics-pressure-gates-on-occupancy}
- **Depth re-counted at render.** The manifest re-tokenizes each entry's `tokens` through the live provider at build — never the write-time snapshot — so a model change between loops can't stale the catalog. Every token figure in the packet is render-fresh, manifest and budget alike; nothing trusts a cross-loop cached total.
- **Derived token counts are keyed on (content_hash, tokenizer_id)** {§tokenomics-derived-token-counts} — the deep_hash discipline applied to the gauge (#312): one content blob, N tokenizer-identity-specific counts, computed once each by the mimetypes Tokenizers seam (the identity is the tokenizer.json sha — NEVER the model id, so vocab-sharing models swap with zero recounts while a real tokenizer change recounts all, lazily via the pump's warm pass on the shared embeddings progress channel). Static channel writes stamp `content_hash`; catalog reads COALESCE the keyed count over the write-time stamp for the ACTIVE turn's gauge (threaded per turn, never engine state — concurrent loops on different providers each read their own honest numbers). When the seam resolves nothing exact, the provider's chars/2 upper bound is used and SURFACED (`tokenizer_unavailable`, once per model) — an error-class signal, never a silent number. The assembled-packet ruler remains the provider count corrected by the per-loop usage calibration (§tokenomics-ceiling-calibrates-to-usage) — ground truth anchors the ceiling regardless of ruler.
- **The delivered packet is never over budget.** The readout shows the state of the packet the model actually has, and the grinder (§grinder) folds any over-ceiling packet back under *before* it is sent — so a delivered budget headline is always usage ≤ ceiling, percent ≤ 100, free ≥ 0. The percent is of the **post-fold** packet; the pre-fold overshoot is engine trivia the model never sees. A packet that can't be folded under even after the grinder folds the newest turn boundary (§grinder-layer1-rollback) is the corner case: the loop **hard-413s** rather than deliver an over-budget packet — the engine NEVER reaches back to fold older turns to save a loop (that would make the engine the janitor of the model's memory and collapse the entire narrative); a model that won't self-curate strikes out instead. Its STORED failure record renders the overshoot honestly — `free` floors at 0 (never negative), the percent passes 100 — never clamped to hide the degenerate state, but never the model's reasoning surface either. {§tokenomics-over-budget-floor}

**Rejected / obviated.**

- **Hot model-switch recompute** — *obviated* by render-fresh depth (above). There's no cross-loop cache to recompute: the manifest re-tokenizes at build, the budget always did. A model change between loops can't stale a number nothing caches.
- **Reasoning-token surfacing** — *rejected* for the model-facing budget: reasoning is *output*, not window-context, and the model can't FOLD it. The thinking-vs-output distinction is cost-forensics (the usage breakdown is stored on every packet), not a curation signal.

**Rationale.** Rummy used chars/DIVISOR + compute-at-SELECT only because its sync-only SQL couldn't call a tokenizer. plurnk has real `countTokens`: store content tokens once at write (the depth), measure the small rendered output for the budget (the weight). Approximation can't ground curation — the model only curates against numbers it trusts.

**Migration path.** None on cost — SQLite, JS, and a local tokenizer are negligible against the model's token budget, the only thing worth economizing. The fallback divisor is a correctness tripwire (no provider tokenizer wired), not a performance retreat. Schema unchanged.

### §membership Workspace identity, membership, disk co-location

**Question.** How does plurnk represent the project a session works on? Where does file membership come from? Does writing an entry imply writing to disk?

**The boundary is the client's.** The client owns the model's filesystem access in both directions: reads are membership-gated (a file is invisible to the model unless it is a member), and writes are proposals the client accepts or rejects (`yolo` auto-accepts). Writing an entry never implies writing to disk — entries are canonical in the store; disk only moves when the client accepts a side-effecting proposal, and only where `project_root` is set (null = headless, client owns materialization).

**Tier — session is the world; permissions are the session's.** Membership, the overlay, and the git flags are **session-tier** (`session_constraints.session_id`, service/session config) — never per-run. Every run in a session shares one world (§machine-processes: one filesystem, one overlay); a run is a *log* — a perspective over that world — owning no membership of its own. A declaration reshapes the one world for every run, never per-connection. `runs.origin` is attribution (whose perspective), not a permission.

**Workspace identity.** No `projects` table; `sessions.project_root TEXT` (nullable = headless) anchors the workspace. `entries.scope ∈ {'session','run'}` (agent-scope retired). Workspace = session; no users/auth/multi-tenant.

**git is the substrate.** {§membership-git-membership} git-tracked files (`git ls-files`) are members with no explicit overlay — channel-less markers, disk is truth. git absent → no fs-walk (non-git/headless get no substrate membership); `pick` is then the sole source.

**Membership is a declared forest of repos.** {§membership-forest} A workspace is not one git repo but a **forest**: membership is the union, over a session-declared set of repos, of each repo's `ls-files` (gitlinks/mode-160000 filtered), each path-prefixed by the repo's path relative to `project_root`. The root need not itself be a repo — a non-git parent of ninety repos resolves to all ninety. A worktree, a submodule, a buried repo are not special cases: each is just another declared repo, resolved `rev-parse --show-toplevel` → `ls-files` in the tree it points at.
- **Membership-gated edits.** {§membership-edit-membership-gate} EDIT is bounded by membership exactly as READ is. An existing **member**'s baseline is its entry snapshot — the body channel the model READ, not a fresh disk read — so the diff is naive against the view the model saw, never empty (the write-side CAS, §membership-edit-write-cas, prevents the silent overwrite of out-of-band drift). An existing **non-member** is refused (403) *before* any read or write: the model never reads a file it can't see (no leak into the proposal) and never overwrites one (no wiping a gitignored `.env` it never added). A **new path** stays open — proposal→accept adds it to the manifest. Reaching past membership is `EXEC[sh]`'s job, not the file scheme's.

**The overlay — `pick | view | hide | repo`, removed by `drop`.** A `session_constraints` table (effect ∈ {pick, view, hide, repo}, target) is the client's supersede over git; `drop` removes any declaration. Resolved membership is `(⋃ repo ls-files ∪ pick) − hide`, with `view` enforced at the edit gate.
- **`repo`** {§membership-overlay-repo} — declare a git repo (a folder) ANYWHERE — under the project root or outside it. Its `ls-files` (+ untracked-non-ignored, §membership-auto-add) join membership, addressed **relative to the project root** always — a clean path when the repo is under it, a `..`-prefixed one when it's outside (the universal `join(root, pathname)` disk-resolver collapses it back to disk; an absolute key would nest under root and never materialize). `project_root` carries no boundary, it is only the relative-address base. Submodules/nested repos are separate `repo` declarations — no recursion; the client owns the scan and the trust call.
- **Auto-add** {§membership-auto-add} — a declared repo's membership is its tracked `ls-files` PLUS its untracked-but-not-ignored files (`git ls-files --others --exclude-standard`), 'git' origin. A model-created file is a member the moment it exists — no `git add` — while `.gitignore` still filters it, and deleting it un-registers it like any git member. The model's new files surface in the catalog and the EMI without a distinct "add" op.
- **`pick`** {§membership-overlay-pick} — admit an untracked file git misses: a targeted client-dictated `node:fs` glob scan over untracked matches (files only), 'constraint' origin, reconciled like git members. Enumerated, so the manifest stays exhaustive. git-absent, `pick` is the *sole* membership source.
- **`hide`** {§membership-overlay-hide} — exclude a tracked file: resolution drops matches (`node:path.matchesGlob`) and reconciles so the entry set *equals* the member set. The lever to exclude a committed-but-sensitive tracked file; `entries.membership_origin` keeps reconciliation off model-created members.
- **`view`** {§membership-overlay-view} — keep a member readable but refuse `File.edit`, 403'd at the membership check before any diff. (Admitting an untracked file as `view` rides on `pick`'s scan.)
- **Resolved effect is a read, not a re-derivation.** {§membership-resolved-effects} `session.members` surfaces each candidate's resolved effect — `(ls-files ∪ pick) − hide` tagged `member` / `view`, plus the `hide`-excluded `hidden` set — so a client signs file visibility (member / read-only / ignored) without reimplementing the overlay glob-matching. The daemon owns git + the globs; the per-file effect is its to resolve, the client's to render.

**File ops act on the entry, not the disk; the two reconcile only at gates.** A `file:///` member is a row whose body channel holds the *materialized snapshot* of its disk content. READ returns that channel; EDIT diffs against it — neither reaches the filesystem directly. Entry and disk reconcile at exactly two gates: the **pre-turn materialize** (disk → entry, below) and the **accept-time write-back** (entry → disk, §proposal). Between the gates the entry is the truth the model curates against, and `synced_sig` — the member's last-synced disk stat (`mtime:size`) — is the version token both gates compare on.

**Sync is idempotent and change-gated.** {§membership-change-gated-sync} Per turn, membership materializes every member's disk content into its entry — but the *work* is gated on a cheap per-member change-detect: a member unchanged on disk since its last sync is not re-read, re-tokenized, or rewritten. **Coverage is exhaustive — every member is detected every turn — but work is proportional to change**, so a ninety-repo forest costs detection, not a full re-read. Invariant: after a pass every member's entry equals its disk content; a no-change pass is a no-op.

**EMI divergence signal.** {§membership-emi-divergence-signal} The detector that gates the work *is* the one that fires this — one mechanism, not a second full read. When the change-detect finds a member moved out-of-band, the delta detector (§env-delta) surfaces it as a system `EDIT` log row naming the file, `source="file"` — the model sees what changed without diffing the manifest against memory. The model's own edits are write-through (the entry equals disk after a File write), so the scan never mis-attributes them as external divergence.

**The write-back is a compare-and-swap — never a clobber, never a clever merge.** {§membership-edit-write-cas} EDIT is *naive against the snapshot*: it diffs the model's change onto the entry's body channel — the exact bytes the model READ — and the proposal carries the `synced_sig` that snapshot was taken at. At accept, `applyResolution` re-stats disk and lands the proposed content only if that signature still matches. If disk moved out-of-band in the propose→accept window — a sibling run, the user's editor, a build step — the write is **refused** with a `write_conflict` and **nothing is written**. The engine neither blind-writes over the ambient change (a *clobber*) nor silently re-diffs the model's edit against a state it never saw (getting *clever*) — both would bury a stale-view contract violation under a fallback. The conflict surfaces instead: a ≥400 apply downgrades to a reject (§proposal), so the model sees the EDIT **did not occur** (400; the `write_conflict` outcome is forensics-only), the next reconcile narrates the real disk content as a `source=file` divergence (§membership-emi-divergence-signal), and the model re-reads and re-proposes against the fresh snapshot.

The version travels *with the proposal*, never re-read from the entry at accept: a sibling run in the same session may reconcile while this proposal sits paused, advancing the entry's `synced_sig` to the drifted disk — comparing against the *current* entry sig would wave that clobber through, so the comparison is always against the sig the proposal was computed at. A proposal that assumed an **absent** path (a create) conflicts only if a file has since appeared; a member with **no recorded snapshot** (an un-materialized entry, null `synced_sig`) has no baseline to guard and writes through — the two are told apart by the proposal's `existed` flag, not by a null sig alone. On a clean landing the entry refreshes to the written content and `synced_sig` is **restamped** to it, so the next reconcile recognizes the model's own write (not an external divergence) and a second same-turn edit bases on the landed bytes, not a stale sig. This is the write-side twin of the read-side change-gate (§membership-change-gated-sync): one `synced_sig`, gating both the re-read and the write.

The CAS is the **hard backstop**, at the moment of writing, on every accept path. It composes with — and is distinct from — the YOLO-only `staleClobberRisk` guard (§dual-yolo-stale-clobber-reject): that guard refuses to *auto-accept* an edit whose target already diverged earlier this turn (the read→propose window, server-YOLO path only); the CAS refuses to *write* against a snapshot disk has left (the propose→write window, every path). Together they bracket the full read→write span.

**Permission flags.** {§membership-git-flags} `PLURNK_SERVICE_GIT_ALLOWED` is the hard ceiling: `=0` denies all git membership service-wide, un-re-enableable — the sandbox/benchmark lockout. `PLURNK_SERVICE_GIT_AUTO` is the default declaration: `=1` (default) declares an implicit `repo` at `project_root` (no-op if it isn't a git tree); `=0` declares nothing — service/clients `repo`-declare explicitly. `ALLOWED` gates `AUTO`.

**Rationale.** Session is the right scope unit; membership *is* the curation, outsourced and tiered: git bounds it by tracking, the client supersedes by overlay, the model curates its own render by READ/FOLD — the engine curates nothing. The forest falls out of "session = world": one workspace can be many repos, so membership is their union, declared not guessed (the scan and its security are the client's). Exhaustiveness is a property of *coverage*, not *work*: every member is checked every turn so no drift hides, but unchanged members cost only a detect — the full-repo cost is git's to bound (what it tracks) and the client's to bound (`hide`), never the engine's to pay re-reading what hasn't moved.

**Migration path.** `session_constraints.effect` gains `repo`; the three renames (`add`→`pick`, `ignore`→`hide`, `read-only`→`view`) are wire-surface changes on `session.constrain`. Forest resolution iterates declared repos (was one `ls-files` at root). The change-detect adds a per-member stored signal — mtime+size or content hash, and *that choice is the EMI reliability bound* — gating the existing materialize. `PLURNK_SERVICE_GIT_ALLOWED` (the hard ceiling) and `PLURNK_SERVICE_GIT_AUTO` (the default declaration) are the git flags (§membership-git-flags). Tenancy / cross-session shared workspaces still require a `workspaces` table lifting constraints off `session_constraints`.

### §grinder Budget enforcement: the grinder

**Question.** §tokenomics surfaces the budget honestly and the model curates against `tokensFree` — almost always enough. Two states defeat self-regulation, neither the model's doing: a jumbo prompt (the turn-0 environment), and an unexpectedly large read. (A jumbo repo is no longer its own case — with no index nothing auto-renders the repo; it surfaces only as a large catalog `FIND`, which the model pages like any big result.) What enforces the ceiling when the signal isn't enough?

**Decision — a pre-LLM grinder, fired only on actual overflow.** In `Engine.runTurn`, after the packet is assembled (`PacketBuilder.buildRequestPacket`) and before `provider.generate`, the assembled render-weight (§tokenomics) is measured against the ceiling. At or under → the packet ships untouched; the grinder never trims speculatively or "helpfully." {§grinder-overflow-only} On overflow it folds the newest turn boundary's rows (errors exempt), then hard-stops if that isn't enough:

- **One rule, every turn: fold the NEWEST memories — never history.** THE DOCTRINE, the project's animating narrative: the log is the model's memory and the model ALONE curates it (FOLD/KILL). The grinder never reaches back into history — it only blocks NEW memories from landing when there is no room, forcing the model to do its own housekeeping. On overflow it folds, in one set-op, the still-open rows of the **newest turn boundary**: the immediately-prior turn's emissions and the current turn's pre-model rows (foists, wake surfaces — every current-turn row at grind time is engine-written). Turn 1 is the **same rule**, not a case: no prior turn exists, so its own foists are the newest material. Folded, not deleted: rows and bodies persist and are re-OPENable, so log *history* is preserved while the render collapses to coordinates. {§grinder-layer1-rollback}
- **Errors are exempt.** The grinder never folds an `op='error'` row — the budget-overflow it just minted, a parse failure, an action failure. Errors are the model's durable, curatable record of what went wrong; folding them away the moment they matter would blind the model to a recurring failure. They stay OPEN until the model itself FOLDs or KILLs them. {§grinder-errors-exempt}
- **Hard stop.** If the packet still overflows with every foldable row folded, the loop abandons at **413 Content Too Large** (`engine_loop_set_status`) — the content genuinely won't fit, and the anchor's name is finally its status. Its sibling engine-imposed terminals are HTTP-precise too: `maxTurns` → 429, a strike-out → 500 (508 when cycle-driven) — no longer the old catch-all 499. No further passes. {§grinder-hard-413-abort}

- **Fetch-fits-free — the pressure law** {§tokenomics-fetch-fits-free} — under budget pressure, a retrieval larger than the headline's Tokens Free arrives ALREADY FOLDED: the result lands in the next build, the build overflows, and the grinder's one rule folds the newest boundary — which is exactly that result. The model never sees an oversized fetch open, however many times it re-fetches (the read→grind→re-read spiral: run24 on grok, the jumbo fixture on gemma — five turns of narrowing asks, three grind-strikes, 500). The engine's numbers are honest and the grinder is doctrine-correct; the model's ONLY working lever is ordering: FOLD history first (the Heaviest-items table is the target list), then fetch within the room made. The 413 error row states this law verbatim — the signal fires exactly when the lesson applies. Corollary: each turn accrues ~a couple hundred tokens of unavoidable meta (the mirror row, PLAN, budget growth), so a Tokens Free below that accretion is a dead state the NEXT build inherits — conclude or fold before it reaches zero, not at zero.

- **Engine-imposed terminals are HTTP-precise** {§loop-terminals} — the loop-status vocabulary, one meaning each: `200` concluded (the model's SEND[200]) · `499` model-abandoned (SEND[499], or a cancel) · `429` maxTurns exhausted · `413` budget hard-stop · `500` strike threshold (`508` when the crossing strike was a detected cycle) · `504` loop timeout / exec-timeout restamp · `202` the resumable park (internal state; the model-facing signal is `[102]<T>`/`<-1>`) · `100`/`102` queued/running. Never a catch-all, never a new value without an owner schema ruling.

**Strike coupling.** A grinder fire bumps the engine's `turnErrors` — the same internal counter cycle detection feeds — so an overflow counts toward the strike streak that ends a runaway loop at 500 (or 508 if the crossing strike was a detected cycle). This is the pressure that keeps self-curation the path of least resistance. {§grinder-strike-coupling} **Every compaction strikes — including turn 0/1.** There is no soft exemption: a fold is a fold; the model gets three tries (`maxStrikes`), and three compactions running strike it out. The compacted packet is necessarily slightly heavier than nothing (folded rows still cost their coordinate line), so overflow is never "impossible" — a model that refuses to distill/fold/kill can genuinely strike out. {§grinder-compaction-strikes}

**What the model sees.** The overflow is a terse `op='error'` log row — a status code and the canonical term, `413 Budget Overflow`, no mechanism vocabulary ("layer," "grinder," "reclaim") and no advice (the packet teaches recovery, not the row). It is minted *before* the rebuild, so its derived `log:///<coord>` pointer surfaces in the `errors` section (§telemetry) THIS turn — at strike 1, not a turn late. The budget readout (§tokenomics) — turn and entry weights — is the diagnostic surface; the model diagnoses the cause the engine can't attribute. Because error rows are grinder-exempt (below), successive overflows stack into a visible recurrence trail the model reads to break a spiral. Per the gamification policy (§telemetry), the *strike* the overflow triggers stays engine-internal; the model sees the error rows, never the accounting. {§grinder-overflow-error-row}

**Rationale.** This is the load-bearing center of plurnk, not a tuning choice: the model controls its memory, and the engine's ONLY lever is to refuse room for new memories — never to clean house on the model's behalf. Fold-the-history variants are forbidden outright: an engine that janitors makes curation unnecessary, and the whole pedagogy (FOLD/KILL as the model's discipline, the strike as the escalation, 413 as the consequence of refusing to curate) collapses. The story is one sentence: *overflow → fold the newest turn boundary → strike → still over → 413.* Same rule turn 1 as turn 101 (turn 1 simply has no prior turn). It only *folds* — reversibly — nothing is deleted. (Rummy's spec described clearing log *bodies*; its code folded instead — body-clearing is destructive. The code was the lesson.)

**Migration path.** None on mechanism. Speculative or non-overflow trimming is a different feature, deliberately excluded — the grinder fires only in response to actual overflow.

### §env-delta The environment delta: what changed since the model last looked

**Question.** The manifest (§packet) is a live directory of what *exists*, re-derived each turn — but it carries *state*, not *events*. When a shared entry changes between a run's turns — a sibling run edits it, a tracked file diverges on disk (§membership) — the model's prior READ is now stale, and the manifest's new line count is a fact it would have to *diff against its own memory* to notice. The manifest also cannot say *who* changed it; with more than one actor in a session, provenance is load-bearing. What surfaces change — losslessly, attributably, without curating, and **without a per-run shadow of the world** (§machine-processes forbids one)?

**Decision — pull from the shared log; no snapshot.** Every edit is *already* a span-carrying `log_entries` row (§edit-result-render), so a run needs no stored state of its own: at pre-turn it surfaces *other actors'* EDITs on shared entries **since its own last turn** (`log_entries.at` past the run's most recent prior `turns.timestamp` — both already in the log) and materializes each as a **folded** `EDIT` in its log, reusing the originating row's span and cause. "Since I last looked" is a fact about the run's own turns, never a snapshot it cannot see (§machine-processes). The set is **exhaustive and unranked** — every change, no relevance order — but **not content-free**: the edited region of a change that *happened* is a faithful record, not the index regrowing. Volume is FOLD's to manage (deltas land folded) and the grinder's under budget — never the engine's to manage by gutting the payload.

**Form — a folded log entry, `origin=plurnk`, carrying `source`.** A delta is a `log_entries` row: an **`EDIT`** ("an EDIT happened to X"), `origin=plurnk`, **`expanded=0`** (folded — listed, collapsed to its coordinate until the model OPENs it), carrying the **`source`** column (the cause). A log entry, not a transient frame section, because a run's timeline must be **self-contained** — a forked run carries everything it observed (§machine-processes). `source` renders as `run="<id>"` / `run="file"` in the meta line, **omitted when the cause is the owning run itself** — a third attribution axis, distinct from `run_id` (whose log owns the row) and `origin` (the actor *type*).

**The filesystem is an actor — the `plurnk` run.** A real cross-run edit is a *faithful record*: the sibling issued the op, `source=<run id>`. An out-of-band disk change is a *fiction*: no op happened, but `EDIT` is the only grammar the model has for "your world changed," so the engine narrates the drift as a `source=file` EDIT to keep the model's perspective aligned with what its own tooling would show. It has no real author, so the reserved **`plurnk` run** (§actor-boundary) narrates it — at pre-turn it compares each member file to its entry (the §membership EMI re-read) and logs a `source=file` alignment EDIT for any divergence. Every run pulls that through the one delta path, exactly like a sibling's edit; the fs needs no special case.

**No coalescing.** The fs nets *inherently* — one fiction per file is `editedSpan(entry-as-of-last-align, disk-now)`, the net of any number of disk changes, captured by the single pre-turn pass. Sibling edits do **not** net: they are real, discrete events already in the log, replayed faithfully (folded). A "net span" across unrelated edits would destroy the record and conflate the fs state-diff with the sibling event-replay — the asymmetry is correct.

**Passive — computed at build, never forces a turn.** A delta materializes only while a packet assembles, so a change has nowhere to land until something else has already started a turn — it cannot wake an idle model. "Inform, never override." Urgency that genuinely needs the model routes through the *voice* door (an inject), never the environment door promoting itself to a turn.

**Rationale.** "The model knows its world moved" becomes a property of *reading the shared log at build* — 100% coverage by construction, with zero run-private state beside the log. The engine records each change faithfully (the EDIT it was, showing its result) and hands the model the wheel; it never ranks, selects, or folds on its behalf.

**Migration path.** Built. The per-run world-snapshot the architecture forbade (§machine-processes) is **deleted**; its `[§machine-processes-run-is-its-log]` conformance test is now green. The pull + the `plurnk`-run fs narration replace it.

### §edit-result-render EDIT log rows render their result, not their input

**Question.** An EDIT's log row exists so the model has a record of what it did. Re-emitting the model's *input* statement (the tx heredoc) records the *intent* but not the *outcome* — the model still has to READ the entry back to confirm "did it land, what does it look like now." And a system delta-EDIT (§env-delta) has no input statement at all. What should an EDIT row's body be?

**Decision — the edited area as it looks now.** An EDIT row renders the **resulting span**: the edited region of the entry *after* the write, line-numbered, with a couple of lines of context above and below. The model sees post-edit state inline — no confirming READ — and the same rendering serves the model's own EDITs and the system delta-EDITs (§env-delta) identically. The meta line still carries op + target, so "I EDITed X" stays legible; the body says "and here's X now."

**Scope.** The span is computed at edit time — the write range and the result are both known then — and stored on the EDIT's `rx`; the render reads it. A large span is bounded like any rendered slice, and FOLD collapses it to the coordinate when the model doesn't need it.

**Migration path.** Changes what EDIT rows *show* (input → output); the op surface and EDIT's behaviour are unchanged. Tests asserting the input-heredoc render move to the resulting-span render.

### §dual-yolo Dual-YOLO: server- and client-side auto-accept

**Question.** A side-effecting op proposes (§exec) — dispatch pauses at 202 awaiting a client accept/reject (§engine-rails, §methods). But two unrelated needs want to skip the human gate: a service running *headless* (a benchmark, a CI job, a fixture — there may be no client at all), and a *human* who wants "stop asking me" ergonomics in an interactive session. One flag, or two mechanisms?

**Decision — two distinct, complementary mechanisms.** Auto-accept lives at two layers that never substitute for each other:

- **Server-side YOLO** — a per-loop flag, `loops.flags.yolo=true`, set via `loop.run({flags:{yolo:true}})`. The engine auto-resolves the proposal **in-process** — the in-tree `yolo` listener reads the pending proposal and accepts it without any `loop.resolve` ever crossing the wire. No client need be connected. {§dual-yolo-server-yolo-auto-accept} Its uses are non-interactive: benchmarks, CI runs, internal automation, test fixtures. Client apps deliberately do **not** expose it — it is not end-user ergonomics.
- **Client-side YOLO** — the *client's* own setting (`--yolo` / `PLURNK_YOLO`). The daemon emits the `loop/proposal` notification exactly as always; the client immediately answers `loop.resolve({decision:"accept"})`. The wire roundtrip still happens and the daemon stays **unaware** the acceptance was automatic — indistinguishable from a fast human. Its use is the interactive "stop bothering me" session.

**The notification carries the flag.** `loop/proposal` carries `flags` (§notifications), `yolo` among them, so a client attached to a *server*-YOLO loop can suppress its review UI — those proposals resolve in-process before any human could react, and rendering a doomed review prompt is noise. {§dual-yolo-proposal-carries-flags}

**Server-YOLO is not blind — it refuses a stale clobber.** Auto-accept is not accept-everything: when an EDIT's target diverged on disk *this turn* — a `source=file` env-delta landed in the run's log since the model's prior turn — the model's EDIT is based on a stale read, and accepting it would silently overwrite the ambient change. The engine flags such a proposal `staleClobberRisk`, and the server-YOLO listener **rejects** it (the reject's outcome is forensics-only, never in the model's rx) rather than accepting; the model sees an ordinary reject and can re-READ the current content and retry. The guard is the engine's, on the auto-accept path it owns — it brackets the read→propose window (server-YOLO only), while the write-back compare-and-swap (§membership-edit-write-cas) brackets the propose→write window on every accept path. {§dual-yolo-stale-clobber-reject}

**Why two.** They answer different questions. Server-side asks *"is a human in the loop at all?"* — and when the answer is no, dispatch must not block on a `loop.resolve` that will never come. Client-side asks *"does this human want to review each one?"* — a presentation choice that leaves the protocol untouched. Collapsing them would either force a client onto every headless run or leak an interactive preference into the engine's dispatch path. They are orthogonal by construction: the engine gate and the human gate, each bypassable on its own terms.

**Migration path.** Built. `loops.flags.yolo` persists and the `yolo` listener (`src/server/yolo.ts`) auto-resolves; `loop/proposal` already carries `flags`. Client-side YOLO is wholly the client's (`@plurnk/plurnk`) concern — the service offers nothing to build for it beyond the `loop.resolve` RPC it already has.

---

## §packet Packet shape

**Service-owned.** grammar 0.67 deleted `Packet.json` — the protocol scoped itself to the grammar, so the packet shape is now entirely plurnk-service's. The engine assembles it in `PacketBuilder.buildRequestPacket` as an **ordered list of sections** that trusted plugins may rewrite (§packet-assembly).

```ts
type PacketSection = {
    name: string;                       // stable id: definition, tools, schemes, system-policy, project-policy, budget, prompt, errors, log, git, requirements — or a plugin's own
    slot: "system" | "user";            // the prompt-cache boundary; system-slot sections build the cache-stable system message
    header: string | null;              // "## Plurnk Service X", or null (definition renders verbatim)
    content: string;                    // rendered markdown — what the model saw
    tokens: number;                     // measured render-weight
};
type Packet = {
    tokens: number;
    sections: PacketSection[];           // the ordered, plugin-overridable list; the wire renders it by slot
    telemetryErrors: object[];           // structured telemetry events — the `errors` section's source; ephemeral (the packet is their only home, §telemetry)
    assistant: { tokens: number; content: string; ops: PlurnkStatement[]; reasoning: string | null };
    assistantRaw: unknown;
};
```

The wire projection (`PacketWire.renderSlot`) groups sections by slot into the system + user ChatMessages; the digest re-renders the same stored sections byte-for-byte.

**Prompt as a first-class entry.** Each loop's prompt is written on loop start as a plurnk-origin `EDIT` against `plurnk:///prompt/<loop_id>/<N>` (indexable, body channel, text/markdown). At render time the **Active User Prompts** section materializes **every** prompt the current loop holds, oldest first — typically one, but an active loop admits injected prompts, all shown in order. The section is the OPPOSITE of the errors section: bare HEREDOC bodies, no meta/link line — the heredoc fence (each prompt's own `plurnk://prompt/<loop>/<N>` address) IS the link. A prompt over `PLURNK_SERVICE_PROMPT_PREVIEW_CHARS` renders a `[ Prompt exceeds preview limit. Full content: <addr> ]` pointer instead of its body (the model OPENs/READs the entry to see it whole — never lost). The entry itself stays READ/FOLD-able like any other. The foisted `EDIT`'s **log row is folded by default** (`expanded=0`): the prompt body already lives in the Active User Prompts section, so the log keeps the action for forensics while collapsing the duplicate body, re-OPENable like any fold (§open-fold). {§prompt-fold}

**The entry catalog.** The catalog is the **complete, unranked directory** of what a session holds, served by `FIND(scheme:///**)` — one per-scheme array, queried on demand, not a single materialized entry (there is no `plurnk:///manifest.json`; the per-scheme arrays replaced it). Built in the schemes layer (`_entry-manifest.catalogRowsFor`); a per-turn derivation pump (`maintainDerivations`) refreshes the deep channels the rows report. A scheme's array is **every entry it holds, in no relevance order**, each `{ path, seconds?, tags?, channels: { <uri>: { mimetype, tokens, lines } } }` — every channel keyed by the URI the model READs (the default channel by the bare path, a non-default by `path#channel`), so it reaches a channel without guessing. `tags` is present only when the entry carries `entry_tags` — its own categorization, surfaced so the model can `FIND` by tag. The model ranks and filters the catalog itself by querying it (task-aware); the catalog never ranks for it — the instant it did, it would be an index again. `tokens` is the provider's live count recounted at render, `lines` the content extent from `Mimetypes.process().totalLines`. The catalog never lists itself. {§packet-catalog}

### §telemetry user.telemetry — model-facing runtime telemetry

The model's runtime alert surface, with two sources by lifetime:

- **Errors are LOG ITEMS.** A model FAILURE — a parse failure (an actionless `op='error'` row) or an action that returned `status_rx ≥ 400` — is a durable `log_entries` row. It folds, kills, and budgets like any log entry (§open-fold), so the model recalls or curates its own mistakes and the grinder's prior-turn rollback can reclaim them — ONE budget surface, the log. The `errors` section is a derived POINTER INDEX over the recent `status_rx ≥ 400` rows (status + `log:///<coord>`), aiming the model at them; it holds no bodies and no fold/budget state of its own. Durable: an error persists until the model folds or kills it, not "cleared once seen."
- **Engine NOTICES are telemetry.** Ephemeral events the engine emits while steering or narrating — a provider's `grammar_unenforced`, a `max_commands_exceeded` truncation, a `budget_overflow` fold, the premature-terminate/idle steers. Transient: they appear on the turn AFTER the event and drain once seen (`packet.telemetryErrors` is their only home). They are NOT the model's failures.

The `log` section is the durable audit; the `errors` section surfaces both — the error pointers (durable, in the log) and the notices (ephemeral).

**Grammar contract:**

- `budget: string` — text/markdown. Empty when nothing to surface.
- `errors: object[]` — shape open at v0.

**Plurnk-service rendering:**

- `budget` per §tokenomics: turn-weight and heaviest-entries tables with `tokenCeiling`/`tokenUsage`/`tokensFree`.
- **One uniform error channel.** EVERY failure — a failed action, an actionless parse failure, and every engine-rail failure (budget overflow, max-commands, the idle/premature steers) — is an `op='error'` `log_entries` row with `status_rx ≥ 400`. No per-category handling, no bespoke ephemeral relationship. The `errors` section is a derived index over those rows (the current turn and the immediately-prior one): one terse `<status> log:///<coord>` link per row, nothing else. The term and full detail live on the foldable row, READ via the link. {§telemetry-uniform-error-channel}
- **Terse rows.** An error row's body is a status code and the canonical term — `Budget Overflow`, `Max Commands Exceeded`, `Idle Turn`, `Premature Termination` — never prose, hints, or advice. The packet (requirements, grammar) teaches recovery; the row names the fault. Letting the model infer what to do from the fact (and the log) beats handing it instructions it will second-guess.
- **Notices** — the few events that are NOT log rows (a provider's `grammar_unenforced`, which points at the model's own emission via a content-offset) render one terse line under `## Plurnk Service Errors` by their typed `position`, never a JSON dump. The notice buffer drains on read — each appears on exactly one packet. {§telemetry-drain-on-read}
- **Gamification policy (rummy precedent, plugins/error/error.js).** The model sees errors that **happened** — its actions failed, its emission didn't parse, its ops were truncated, it overflowed the window. The model does NOT see the engine's accounting *about* errors: strike streaks, cycle detection, sudden-death thresholds, no-ops bookkeeping. Surfacing internal state creates a gamification surface where the model optimizes for engine metrics (manufacturing a clean turn to reset the strike counter, e.g.) instead of the task. Engine bookkeeping drives abandonment silently; the model just sees its actual failures.

**The error rows (one channel) + the only non-log notices:**

| failure | row | status |
|---|---|---|
| parse failure | `op='error'`, origin `model`, source `grammar`; body = parser message + content-offset `line:col` | 400 |
| action failure | the failed op's own row (the scheme set `status_rx ≥ 400`); body = the scheme's error | 4xx/5xx |
| budget overflow | `op='error'`, origin `plurnk`, source `rail`; body = `Budget Overflow: newest log items automatically FOLDed` | 413 |
| max commands exceeded | `op='error'`, origin `plurnk`, source `rail`; body = `Max Commands Exceeded` | 429 |
| idle turn / premature termination | `op='error'`, origin `plurnk`, source `rail`; body = `Idle Turn` / `Premature Termination` | 409 |

| notice `kind` | Source | Position |
|---|---|---|
| `grammar_unenforced` | (provider, forwarded) GBNF-filter divergence — the model's bytes diverged from the transported grammar | content-offset into the model's emission |
| `embed_progress` | derivation-pump milestone (§mimetype-surface); `level: info`, never in the errors section | none |

**Severity on the wire (`level`, required — grammar 0.74.29+).** Every `TelemetryEvent` carries `level: "error" | "warn" | "info"`, set by the **producer** at the emit site — severity is meaning the producer owns, not something the client re-derives by pattern-matching the open `kind` vocabulary. Service mappings: every error log row is `error` (an error is an error); a forwarded `grammar_unenforced` carries the producer's own level (defaulted to `warn` only when the producer predates the field); `embed_progress` is `info`, a progress note that never reaches the errors section. Clients color straight off `level`. {§telemetry-event-level}

Strike accounting, cycle detection, sudden-death thresholds, and no-ops bookkeeping stay engine-internal — they drive abandonment silently per the gamification policy. EVERY error — a failed action, an actionless parse failure, and every engine-rail failure (budget overflow, max-commands, the idle/premature steers) — is a LOG ITEM (`log:///<coord>`, `op='error'`, `status_rx ≥ 400`), foldable and re-OPENable, with its terse term on the row. The `errors` section surfaces a derived pointer to each. There is **no bespoke `error://` scheme** and no ephemeral per-category error buffer: errors live in the log, addressable + curatable like any row — not a separate namespace, not a drain-on-read side channel. {§telemetry-no-error-scheme}

**Client surface.** Engine NOTICES broadcast live via the `telemetry/event` WS notification — same envelope as the model's drained copy (`{ source, kind, level, message?, position?, …kind-specific }` per the grammar's `TelemetryEvent` schema), the moment they land, scoped to the loop's session (a `grammar_unenforced` snippet in a debug panel, a session timeline). ERRORS do not broadcast on this surface: they are log rows, and the client reads them the same way the model curates them — `log.read` / the `log/entry` notification, the durable log. {§telemetry-telemetry-event-notify}

**Turn-lifecycle liveness.** The provider `generate()` call is the one long, opaque window in a turn — submit → first committed op is provider latency plus a full first-turn generation (tens of seconds on a local model); a static client screen there is indistinguishable from a hang. The engine brackets `generate()` with two `telemetry/event` NOTICES (`source: "engine:turn"`, `level: "info"`): `turn_awaiting_model` the instant it calls the provider, `turn_generated` when the call resolves and op-parsing begins — a legible "thinking… → working…" heartbeat, NOT model token-content (that stays out of the Log, a paradigm break). Both are suppressed on an aborted loop and broadcast to the session like any notice (§telemetry-telemetry-event-notify). Optional intra-generation ticks (a moving counter during the long wait) are a later provider-contract enhancement (an `onProgress` on `generate()`, the `embedBatch` shape); the two-beat bracket needs no provider change. {§turn-lifecycle}

**Content-offset position.** An emission-level error carries a `position: { type: "content-offset", line, column }` into the model's own emission — a parse-error LOG ROW (op='error', §model-entry) and a content-offset NOTICE (e.g. a provider's `grammar_unenforced`) both report the line, not the bytes. The model resolves it against its own emission: the `model` mirror row (§model-entry, always folded) holds the line-numbered emission, and the model `READ`s the folded row at the cited lines — surgical, budget-bounded, no auto-opening. No snippet is embedded — that would duplicate an emission the model can already introspect. {§telemetry-content-offset-pointer}

### §tools user.tools — the capability sheet

The tools capability lines render **titleless**, directly under the `definition` (plurnk.md) section — the examples flow on from plurnk.md with no separate header — and **above** `## Plurnk Service Requirements`, so the model sees what it can *do* before the rules it must follow. Each enabled capability contributes one line via `PacketBuilder.#collectTools`; the section is omitted when nothing is enabled. {§tools-capability-sheet}

**Contributors: the wired executor tags.** Each available executor tag *with an example* contributes ONE line — its canonical usage — via the shared `teachingLine` (identical shape to the scheme directory, §schemes); its doc is materialized at `plurnk://docs/<tag>.md` and discovered via the turn-1 `FIND(plurnk://docs/**)` foist, not linked inline (#270). A tag with no example contributes nothing; `PLURNK_SERVICE_DOCS_EXCLUDE` drops a named tag's line + doc. The boot `ExecutorRegistry` probes availability per tag, retiring the model's blind `<<EXEC[sh]…`.

### §schemes user.schemes — the scheme directory

A `## Plurnk Service Schemes` section renders in the system slot **after the definition (plurnk.md — grammar + imperatives) and the tools sheet** — a terse directory of the scheme families available this session, so the model knows what URI schemes exist before it acts. Each scheme that ships a `manifest.example` contributes ONE line — its canonical usage (no scheme prefix; the example self-documents). The doc is NOT linked inline (#270) — it is materialized at `plurnk://docs/<scheme>.md` and discovered via the turn-1 `FIND(plurnk://docs/**)` foist, keeping the raw packet free of doc links. The in-tree core schemes author their depth in `docs/<name>.md` (loaded at boot, shipped with the package); daughter schemes ship `manifest.documentation`. The verbose semantics live in that pull doc (materialized like any entry, READ on demand), not the hot path — terse pushes, depth pulls, via the same `teachingLine` as the tools sheet (§tools). A scheme with no example (provisional) is omitted; `PLURNK_SERVICE_DOCS_EXCLUDE` drops a named scheme's line + doc. {§schemes-directory}

### §inject system.inject — the operator injection

When `PLURNK_SERVICE_PACKET_INJECT` names a readable markdown file, its content renders as a `## Plurnk Operator Notes` section in the system slot **right after the teaching** (definition → tools → schemes → inject), ahead of the policy sections and budget — part of the cached prefix. Read per-turn so the operator's edits take effect live; a set-but-unreadable path fails the turn hard (a deliberate setting with a broken path is a misconfig, surfaced not hidden). `~/` expands to home. It's the operator-side complement to the plugin section hook — a pressure valve so reshaping the packet edits operator content, never the core. Unset → no section. {§packet-inject}

### §policy system.policy — the client's policy injection

Two sections ride the system slot **below the operator notes, above budget**: `## Plurnk Service Policy` from `PLURNK_SERVICE_POLICY` (default `~/.plurnk/AGENTS.md`) and `## Project Policy` from `PLURNK_SERVICE_PROJECT` (default `<projectRoot>/AGENTS.md`, resolved relative to the session root). AGENTS.md is **policy** — the client's authoritative rules promoted into the privileged zone — NOT a curatable, foldable, READ-able entry; the model cannot FOLD it away. A default-absent path is silent (the section is omitted); an explicit override (env set) that fails to read fails the turn hard — a deliberate setting with a broken path is a misconfig, surfaced not hidden. Read per-turn so edits take effect live. Reference/scratch docs are NOT policy — they ride `PLURNK_SERVICE_MD_*` (materialized as READ-able entries, §operator-config), which is where the dev-notes AGENTS.md used to hold belong. {§policy-sections}

**The scheme self-doc contract.** `example` is the hot-path one-liner; `documentation` is the deep doc — the exact shape execs already use (`example` + `documentation`). `SchemeRegistry.teach()` renders the directory; `docEntries()` materializes the docs (per loop.run, alongside the operator docs). `documentation` rides a service-side `SchemeManifest` extension until plurnk-schemes#25 lands it in the contract.

### §requirements The requirements section — static per-turn rules

Rendered at the END of the user packet under `## Plurnk Service Requirements` {§requirements-requirements-render-last} — closest to the assistant turn so the contract the model has to honor is the most recent text it sees. The header is omitted entirely when the requirements string is empty. {§requirements-requirements-omitted-when-empty} Contains rules the grammar block doesn't cover (canonical example: "Conclude the loop with `<<SEND[200]:answer:SEND`"). The op syntax leads the section. PLAN is mandated unconditionally by plurnk.md §Imperatives (grammar 0.70 requires every turn to lead with `<<PLAN`), so the service injects no separate plan directive here.

**Sourcing:** caller supplies the string via `runLoop({ requirements })` / `runTurn({ requirements })`. Plurnk-service exposes `PATHS.defaultRequirements` (resolves `PLURNK_SERVICE_REQUIREMENTS` env → in-package `requirements.md`). No DB cascade — same string every turn.

**Rationale:** the user's prompt is natural language ("Reply with just the number") and routinely conflicts with the grammar's operational contract. Without an explicit requirement block, the model obeys the prompt literally and never reaches for SEND. Requirements are the contract that wins those conflicts.

---

## §matcher Matcher and `<L>` slicing

Body matchers and `<L>` both dispatch on entry mimetype. Body matcher: leading-char classification (`//` xpath, `/` regex, `$` jsonpath, otherwise glob). `<L>`: line-navigable → by line, structured → by item.

### §matcher-dispatch Matcher dispatch (service-owned, over daughter primitives)

`Matcher.matchAgainstContent` (in-tree, `src/content/matcher.ts`) is the **service's own** dialect dispatch — `Mimetypes.query` is NOT consumed (§mimetype-methods). It handles the **content dialects** and switches on each, calling the daughter's individual primitives: `glob → queryGlob` and `regex → queryRegex` over the raw content; `jsonpath → queryJsonpathObject` over the `deepJson` projection and `xpath → queryXpathString` over `deepXml` (both pulled from `mimetypes.process({channels})`, so a structural dialect works over any source type), returning `QueryMatch[]` rendered as `<source-line>:\t<line>`. `~semantic` and `@graph` are **relation dialects, not content matchers** — FIND resolves them upstream to `(file, span)` items (`~`semantic via `rankSemantic`, `@`graph via `EntryGraph`), so they never reach `matchAgainstContent` (a fail-hard invariant guards the impossible routing). Status mapping (content dialects):

| Result | HTTP status |
|---|---|
| Match array | 200 |
| Empty match array | 204 |
| Malformed matcher expression | 400 |
| Source unparseable for its mimetype | 203 (soft fallback: raw content as text with `reason`) |

203 is HTTP-creative ("Non-Authoritative Information"). On parse failure, returns raw bytes as text primitive with `reason` so the model can fall back to regex/visual parsing or fix source. {§matcher-dispatch-203-soft-fallback}

Glob anchoring (`TODO*` starts-with, `*TODO*` contains, `*.log` ends-with, `[Tt]odo*` char class) lives in framework's `BaseHandler`.

### §matcher-result Matcher result shape — READ returns matching LINES, uniformly

The contract is the grammar's: **plurnk.md §"`<Line> / <Result>`" — "FIND returns rows of results, READ returns lines of content"**, and READ "prefixes every line with line numbers and a hard tab, `N:\t`" (one source-line number, not part of the source). This section documents the service's implementation of that.

**A matcher selects locations; it never extracts a value.** Every dialect identifies *where* in the source it matches; READ returns the **source line(s)** at those locations, faithfully — one shape for every dialect: `<line>:\t<line-content>`, prefixed with the single source-line number per plurnk.md (shifted back to source coordinates inside an `<L>` slice), never double-numbered. Empty → 204; mimetype `text/markdown` regardless of source. The model reads the line and adapts whatever it needs out of it — READ never pre-chews a match down to a bare value. {§matcher-result-read-returns-lines}

| Dialect | Selects | Natural use |
|---|---|---|
| regex `/pat/` | the lines the pattern occurs in (it *matches*, never captures-and-extracts) | the lines mentioning X |
| glob `pat` | the lines the glob matches | the lines containing TODO |
| jsonpath `$.path` | the line(s) where the structural path resolves | the line defining `host` |
| xpath `//sel` | the line(s) of the selected node (text/html) | the line(s) of the h1 |
| `~`semantic `~q` | the line span of each ranked chunk (a relation, resolved by FIND) | the section about X |
| `@`graph `@<sym` | the line span of each matched symbol occurrence (a relation, resolved by FIND) | where X is referenced |

**READ honors FIND.** A READ that resolves to more than the single exact entry — a glob/folder scope, OR any matcher — fans out: the engine runs the scheme's FIND, then writes **one log row per MATCH** (not per file), each delivering that match's content — READ is the content retrieval over FIND's survey (§find-result-catalog-rows). A file with N matches → N rows. It costs **one command** (the model emitted one READ) yet writes N rows, each its own concrete `(file, span)` — individually foldable/killable/re-READable. A matcher row carries the source LINES at the match's span, delivered via a **raw line-slice** so a structural mimetype's item-index `<L>` never mis-slices a span that is, by construction, source lines; a body-less folder/glob row carries the whole entry. A **bare entry, body-less** is the single direct read. Zero matches writes a single `204` row (never silence). {§read-multi-file-fanout}

> **Source-line provenance (shipped, every dialect).** Each hit carries a source-line span: regex/glob over raw content; jsonpath/xpath over the parsed `deepJson`/`deepXml` projection (the mimetypes daughter reports each hit's line span); `~`semantic the ranked chunk's span; `@`graph the symbol occurrence's span. So the per-match `(file, span)` item is well-defined for every dialect, and READ returns the line uniformly.

### §slice-semantics `<L>` semantics by source mimetype

**General**: sentinels `<0>` (before pos 1) and `<-1>` (after last) are EDIT insertion points; READ/COPY select empty. Other negatives in a single-position marker → 416. In a range, `M = -1` normalizes to "last" so `<1,-1>` is the whole content.

**Line-navigable** (text/markdown, source code, csv, yaml/toml): indexes by line via `sliceLines`. Output mimetype = `text/markdown`.

**JSON**: indexes by item via `sliceJsonItems`. Every JSON value becomes a list of top-level items:

| Source | Items |
|---|---|
| Array `[a, b, c]` | array elements |
| Object `{k1: v1, k2: v2}` | key-value pairs as single-key wrappers (insertion order) |
| Scalar | the scalar itself (length-1 list) |

`<L>` indexes 1-based. READ result always a JSON array. Output mimetype = `application/json` (preserves structure for compose).

- `<N>` → `[items[N-1]]`
- `<N,M>` → `items.slice(N-1, M)`
- `<1,-1>` → whole top-level
- `<0>` / `<-1>` → `[]` for READ
- Out-of-range → 416; malformed JSON → 400

**Compose by addressing the match.** Under per-match fan-out a matcher READ writes one row per match, so the **N-th match IS `log:///<l>/<t>/N`** — its own addressable row, read directly. There is no `<P>`-slice of a combined blob (no blob exists). To process a match further, READ its row and apply a matcher/`<L>` to that content (the body-less compose-chain). {§slice-semantics-compose-pattern}

### §json-edit Structural EDIT on JSON

When effective mimetype is `application/json`, EDIT dispatches through `applyJsonItemEdit`. {§json-edit-structural-json-edit} Body shape rule (parse-then-discriminate):

- Body parses as JSON array → items to splice
- Body parses as non-array JSON → single item to splice
- Empty body → delete the selection
- Body fails JSON parse → 400 (path-extension declares intent; honor strictly) {§json-edit-json-parse-fail-400}

**Array source marker × body:**

| Marker | Body | Effect |
|---|---|---|
| `<-1>` | `"d"` | append one |
| `<-1>` | `["x","y"]` | append multiple |
| `<-1>` | `[[1,2]]` | append inner array as one element (wrap-workaround) |
| `<0>` | `"x"` | prepend |
| `<N>` | `"X"` | replace position N |
| `<N>` | `["X","Y"]` | replace position N, expanding |
| `<N,M>` | `"X"` | range collapses to single item |
| `<N,M>` | `[...]` | range replaced with array items |
| `<N>` | (empty) | delete position N |
| `<1,-1>` | (empty) | clear to `[]` |
| `<-1>` / `<0>` | (empty) | no-op |

**Object source** (items are kv-pairs): body items must be objects (multi-key body inserts multiple kv-pairs). Array body → 400.

**Scalar source**: `<1>` replaces only. Grow markers (`<-1>`, `<0>`) and multi-item bodies → 400 (no implicit promotion scalar→array).

### §ext-mimetype Path-extension declares mimetype

`resolveEntryMimetype` (exported from `@plurnk/plurnk-schemes`): pathname extension → `Mimetypes.detect({ ext })` (with `text/plain` normalized to `text/markdown` per the text-primitive rule §markdown-primitive); falls back to scheme manifest channel default when no extension.

- `known:///users.json` → `application/json` (extension wins)
- `known:///notes.md` → `text/markdown` (extension; matches default)
- `known:///config.yaml` → `application/yaml`
- `known:///users` (no suffix) → `text/markdown` (Known manifest default)

Same rule applies across Known, Unknown, Skill, Plurnk, File. Effective mimetype is stored in `entry_channels.mimetype` on write and drives `<L>` and matcher dispatch on read. {§ext-mimetype-extension-mimetype}

### §render-rule Render rule (mimetype-driven)

`packet-wire` log render branches on `isLineNavigableMimetype`:

- **Line-navigable** (text/markdown, text/plain, csv, source code, yaml, toml) → `N:\t` line-number prefix per line {§render-rule-line-navigable-prefix}
- **Tree-navigable** (application/json, application/xml, text/html, +json/+xml suffixes) → verbatim body (no `N:\t` — outer line numbers would collide with structural navigation like jsonpath/xpath) {§render-rule-tree-navigable-verbatim}

A log row renders its **result body** for the content-returning ops — `READ@200` (the content it pulled) and `FIND@200` (the catalog rows / matched entries it returned) — under the query's fence, mimetype-driven per the rules above; every other op re-emits its statement. FIND included: the model must see what a find *returned*, not just its echoed query, and the turn-0 foisted `FIND(scheme:///**)` reaches the packet through this branch — without it the catalog preview is invisible. {§render-rule-find-renders-result}

An `EDIT` log row renders its **resulting span** — the edited area as it looks now (`rx.span`), under the target's fence — not the input statement: the log reads "and here's X now," so the model sees its edit's effect. The meta line still carries op + target; the model's own EDITs and the system delta-EDITs (§env-delta) render identically; an emptied span → meta line only. With no span stored, the row falls back to re-emitting the statement (the heredoc the model wrote). {§edit-result-render}

The `N:\t` prefix is presentation/reference per plurnk.md ("not part of the source"); stripped before any matcher operation on the log entry.

### §markdown-primitive Mimetype primitive: text/markdown

Auto-derived text mimetypes anywhere in plurnk-service normalize to `text/markdown`:

- `<L>` slice on line-navigable source → `text/markdown` {§markdown-primitive-text-markdown-normalize}
- File scheme extension fallback → `text/markdown`
- `Mimetypes.detect()` returning `text/plain` → normalized via `normalizeAutoTextMimetype`

`text/plain` survives only where a scheme explicitly declares it (exec stdout/stderr — subprocess byte-streams aren't markdown). The model never auto-encounters `text/plain` from defaults.

### §op-invariants Op-level invariants and resolved ambiguities

Carried from the contract walk; durable.

- **Dialect/mimetype mismatch** → 415 (xpath on text/plain → 415; jsonpath on JSON-shapeless mimetypes → 204 because outline is empty, not 415).
- **Binary entries** → 415 across the board for READ/EDIT/OPEN/FOLD.
- **EDIT `<L>` on non-existent entry** → body becomes content; `<L>` is positional-only on existing content.
- **COPY/MOVE `<L>`** → slices the SOURCE range into the destination (every channel), symmetric with READ `<L>` but WITHOUT the `N:\t` prefix (`sliceLinesRaw`); an out-of-range marker → 416. MOVE `<L>` copies the slice, then deletes the whole source (relocation of a fragment). Binary channels can't be sliced (the binary→415 rule above). {§copy-l-source-range}
- **READ rx** prefixes each line with `N:\t` per §render-rule. `sliceLinesRaw` (used by COPY) returns the lines without prefix.
- **FIND body matcher** applies to entry content (all dialects), per-candidate via the in-tree `Matcher.matchAgainstContent` (§matcher-dispatch; status 200 = content hit → entry selected). Scope + tags select candidates in SQL; the path-glob is the (target).
- **OPEN/FOLD** operate on the **log** (`log:///`), not entries (§open-fold) — FOLD collapses a log row to its path, OPEN restores its body. Aimed at an entry scheme they return 501.
- **SEND[410]** deletes as a side-effect (not the model idiom; §move): with `#fragment`, that channel only; without, the whole entry. **SEND[499]** is owned by the streaming scheme that holds the subscription.
- **File scheme** reads disk content with mimetype detected via `Mimetypes.detect({ path })` (plumbed through `PlurnkSchemeContext.mimetypes`). Binary mimetypes → 415 on READ and EDIT.

### §send-status-policy Directed-SEND status code policy

Status codes outside 410/499 on directed SEND return 501 from entry schemes. plurnk.md doesn't prescribe semantics for arbitrary HTTP status codes on directed sends; each scheme decides. 501 is the default; new interpretations land as concrete use cases arise.
