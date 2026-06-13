# plurnk-service — Specification

Canonical contracts plurnk-service exposes, architecture it implements, promises it makes to the constellation (`plurnk-grammar`, `plurnk-providers`, `plurnk-schemes`, `plurnk-mimetypes`, `plurnk-execs`, the user-facing `plurnk` CLI). `AGENTS.md` covers process; this file covers contract.

Section numbers are stable. Promise anchors `{§<id>}` mark individual assertions; tests cite them in their names (`test("[§<id>] …", …)`). `test/intg/spec-anchors.test.ts` fails on orphan citations and reports gaps. Anchors are drift-grounding, not a forcing function.

---

## §0 Glossary

Canonical meanings. When a doc, comment, test name, or commit message uses one of these words, it means exactly what's written here. Drift is a bug.

### §0.1 Lifecycle terms

| Term | Meaning |
|---|---|
| **agent** | The plurnk runtime singleton. Owns agent-scoped state (default scheme registry, agent-wide entries). One per process. |
| **session** | Durable user-named workspace. Persists across runs and process restarts. Identity: `sessions.id` + unique `sessions.name`. |
| **run** | A stretch of work within a session. Multiple runs per session. May fork from another run via `parent_run_id`. Owns the log entries. |
| **loop** | One model-driven or client-driven iteration within a run. Status ∈ {102, 200, 499}. Many loops per run. The model runs inside a loop; each client RPC has its own loop. |
| **turn** | One round-trip with the LLM (or one client RPC dispatch). One assembled prompt sent, one parsed response handled. Many turns per loop. Identity: `(loop_id, sequence)`. |
| **op** | One DSL operation the model emits. Parsed into a `PlurnkStatement`. Examples: `EDIT`, `READ`, `SEND`, `FIND`, `COPY`, `MOVE`, `OPEN`, `FOLD`, `EXEC`. One turn produces zero or more ops. |
| **statement** | Synonym for parsed op. The AST shape `PlurnkStatement` from `@plurnk/plurnk-grammar`. |
| **action** | One executed op. Action and op are the same thing in different states (op = parsed; action = executed). The execution produces a log_entries row at `log://<L>/<T>/<S>/<op>`. |
| **dispatch** | The engine routing a statement to its scheme's op handler. |

### §0.2 Storage terms

| Term | Meaning |
|---|---|
| **entry** | The unit of canonical state. Identity: `(scope, scheme, pathname)`. Holds one or more `channels` of content plus `tags` and `attributes`. |
| **channel** | A named content buffer on an entry. Examples: `body`, `stdout`, `stderr`, `headers`, `symbols`. Each channel has `content`, `mimetype`, `tokens`, `state`. |
| **scope** | `"agent"` or `"session"`. Determines who reads. Agent-scope entries visible to every run; session-scope entries to that session's runs. |
| **scheme** | A URI prefix + handler. `known`, `unknown`, `file`, `https`, `exec`. The scheme handler interprets paths under its prefix and implements the op surface. Consumption surface §3.6; author contract: [plurnk-schemes](https://github.com/plurnk/plurnk-schemes). |
| **mimetype** | A channel's content type. Drives the handler that produces the structural projections (`symbols`, `deepJson`, `deepXml`). Consumption surface §4.5; author contract: [plurnk-mimetypes](https://github.com/plurnk/plurnk-mimetypes). |
| **provider** | An LLM transport. Implements `generate({messages, signal})` against a wire protocol. Consumption surface §2; author contract: [plurnk-providers](https://github.com/plurnk/plurnk-providers). |

### §0.3 State / status

Independent axes on entries and channels. Confusion across them is a recurring source of bugs.

| Term | Type | Meaning |
|---|---|---|
| **status** | HTTP int | Outcome of an operation. Carried on `log_entries.status_rx`, returned from op handlers. Per the catalogue (§3.5). |
| **channel state** | `static \| active \| closed \| errored` | Streaming lifecycle of a channel's content. Metadata, not gating — engine renders content regardless of state. |
| **entry state** | `proposed \| resolved \| cancelled` | Proposal lifecycle. `proposed` = pending client accept; `resolved` = side effect happened; `cancelled` = client rejected. Distinct from channel state. |
| **outcome** | `string \| null` | Short reason for `failed`/`cancelled` (`"permission:403"`, `"aborted"`, `"not_found"`). Opaque to most callers. |

### §0.4 Writer / authority

| Term | Meaning |
|---|---|
| **writer** | The identity authoring a write. One of `model \| client \| plurnk \| plugin`. Carried on `ctx.writer` for schemes; engine enforces `manifest.writableBy`. |
| **origin** | Synonym for writer in log_entries (`log_entries.origin`). Historical naming; treat as equivalent. |
| **writable_by** | The set of writers a scheme accepts. Subset of `{model, client, plurnk, plugin}`. Engine rejects writes outside the set with 403; the rejection is logged as the action-entry (§7.1 action-entry-as-outcome). |

### §0.5 Engine rails

| Term | Meaning |
|---|---|
| **verdict** | End-of-turn ruling computed directly in `Engine.runLoop` from strike/cycle/sudden-death rail state. Decides whether the loop terminates or another turn fires. No filter chain — rails are inline. |
| **strike** | A turn whose verdict counts toward `MAX_STRIKES`. Fires when `turnErrors > 0` or cycle detection trips. The streak counter resets on clean turn; reaches `MAX_STRIKES` → loop abandons at 499. |
| **cycle** | A repeated turn fingerprint across consecutive turns. Detected silently; model never sees the trigger. Strike accumulates internally. |
| **sudden death** | The last `MAX_STRIKES` turns of a loop's `MAX_LOOP_TURNS` window emit soft 429 warnings so the model can wrap up cleanly. `soft=true`: no strike, no streak increment. |
| **mode** | `"ask" \| "act"`. Per-loop. Ask = read-only (no side-effecting ops); act = full surface. |
| **flag** | Per-loop boolean shaping the active toolset: `yolo` (auto-accept proposals), `noWeb`, `noInteraction`, `noProposals`. |
| **proposal** | A deferred side-effecting action awaiting client accept/reject. State machine: `proposed → resolved` or `proposed → cancelled`. `yolo` short-circuits to immediate. |
| **resolution** | Client's accept/reject of a proposal via `op.resolve` RPC. |

### §0.6 Packet terms

| Term | Meaning |
|---|---|
| **packet** | The turn's full exchange shape: `{system, user, assistant, assistantRaw}`. Persisted on `turns.packet`. |
| **log** | `packet.system.log`. Chronological list of `log_entries` in scope this turn. |
| **render** | The act of computing the packet from current DB state at turn boundaries. Mimetype handlers fire at render time. |

### §0.7 Test taxonomy

| Tier | Location | LLM | Substrate |
|---|---|---|---|
| **unit** | `src/**/*.test.ts` | No | Isolated logic, mocked boundaries |
| **intg** | `test/intg/` | No (mock provider) | Real file-backed SqlRite (per-test DB under `test/intg/.tmp/`), real engine |
| **live** | `test/live/` | Real | Wire-level assertions |
| **demo** | `test/demo/` | Real | Holistic outcome assertions |

---

## §1 Architecture

The ecosystem and the in-process shape (§1.1–§1.2), then the two invariants the rest of the spec rests on: isolation by run (§1.3) and the session/run/fork ownership model (§1.4).

### §1.1 Ecosystem

The plurnk project is a modular monorepo-of-repos in the `@plurnk/*` npm namespace. Each repo has one published package and one agent who owns it; cross-repo coordination happens through issues, not shared code. This service sits in the middle of that ecosystem and is its **runtime substrate** — the daemon other repos plug into.

Dependency direction (from root to leaf):

- **`plurnk-grammar`** — root. Owns the JSON-Schema contracts (Packet, TelemetryEvent, AST shapes), the ANTLR parser that turns model output into `PlurnkStatement[]`, and `PlurnkParseError` with its `toTelemetryEvent()` helper. Nothing in the ecosystem can speak the DSL without it; everything else pins it exactly.
- **Framework siblings** consume grammar and define their own author-facing contracts:
    - `plurnk-providers` — Provider/Alias types, `parseAliasesFromEnv`, `resolveActiveAlias`, `Mock`, `ProviderUsage` (currency-aware, includes `reasoning`). Vendor-specific implementations are children: `plurnk-providers-openai`, `-google`, `-ollama`, `-openrouter`, `-cloudflare`, `-xai`.
    - `plurnk-mimetypes` — handler base classes, discovery, fitting algorithm, matcher dispatch. Handler children are per-mimetype: `plurnk-mimetypes-text-{python,typescript,markdown,html,csv,plain}`, `plurnk-mimetypes-application-{json,yaml,toml,pdf}`, …
    - `plurnk-schemes` — scheme-author types (`SchemeManifest`, `WriterTier`, `LoopFlags`), result-shape contracts (`EntryResult` / `ProposalResult` / `PassthroughResult`), slicing primitives, matcher helpers, `schemeError(...)` constructor. Future scheme children: `plurnk-schemes-http`, `plurnk-schemes-git`, …
    - `plurnk-execs` — `BaseExecutor`, `SubprocessExecutor`, runtime resolver, discovery. Children declare runtimes: `plurnk-execs-sh`, future `plurnk-execs-search`, `plurnk-execs-node`, …
- **`plurnk-service`** (this repo) — consumes all of the above. Implements the engine, dispatches ops through scheme handlers, hosts the in-tree set of schemes (`plurnk`, `log`, `exec`, `known`, `unknown`, `skill`, `file`), discovers installed mimetype handlers + provider vendors + executor siblings at boot, hosts the daemon (`bin/plurnk-service.ts` over WebSocket + JSON-RPC), and projects packets to the wire per `Packet.json`. Most of the substantive runtime work lives here.
- **`plurnk`** (client) — terminal UI consuming the daemon's RPC surface. Renders `telemetry/event` notifications, subscribes to log/stream/proposal events. No engine logic of its own.

The grammar is the contract. The frameworks consume the contract and add author-facing surfaces. The service consumes the frameworks and runs the engine. The client consumes the service and renders to humans. Each tier is its own published package; each tier's evolution happens in its own repo.

**This service's central role:** sole consumer of every author-facing framework contract (one set of integrations across the ecosystem), sole producer of the engine's runtime behavior (one canonical implementation of dispatch, log, packet wire), and sole orchestrator of cross-scheme operations (COPY/MOVE flow through engine-mediated `readEntry` / `writeEntry` / `deleteEntry`, never scheme-to-scheme). Most cross-repo coordination flows through us — we file the consumer-need issues at upstream repos, adopt their decisions, document the surface in SPEC.

### §1.2 In-process architecture

Engine library + admin CLI + daemon. Four plug points:

- **Providers** (§2) — LLM transports. Engine sends a turn's messages, receives raw content + usage; engine parses the content into `PlurnkStatement[]`.
- **Schemes** (§3) — addressable resources. Every op targets a URI; scheme handler interprets paths under its prefix and owns its storage substrate.
- **Mimetypes** (§4) — content interpretation. Render-time handlers consume channel content; framework owns the dispatch.
- **Executors** (§6.8 / §10) — EXEC runtime dispatch. Subprocess shells, search backends, future tool runtimes.

The engine dispatches ops, persists state to SQLite, orchestrates cross-scheme COPY/MOVE (§6.4/§6.5), writes the log. Substantive behavior lives in the four plug points.

The grammar (`@plurnk/plurnk-grammar`) owns parser + AST contract. Schemes receive parsed statement fragments via dispatch.

Server posture: this package is the runtime. User-facing CLI lives in `plurnk` and consumes the library API (`src/index.ts` + `PATHS`).

### §1.3 The actor boundary: isolation by run, two doors, self-hosting

**Question.** A session holds many runs — model, client, plurnk (§0.1, §0.4) — over one shared manifest. What keeps one run's activity out of another's conversation; what are the *only* ways a run's work reaches another; and does the engine's own work obey the boundary or get a privileged back channel?

**Decision — isolation by run; the model is not privileged.** A packet renders exactly one run's log — the assembling run's — against the session's shared manifest (§15). A run cannot see another's log: isolation is *structural*, a consequence of "a run owns its log entries" (§0.1) and "one packet, one run," never an `origin` filter at render time. `origin` (§0.4) is **attribution** — the delta's provenance (§14.5) — never read to hide a row. {§1.3-isolation} {§1.3-origin-not-filter}

**Two doors, and only two.** A run's work reaches another run by exactly two channels, and a private log is reachable no other way:
- the **environment door** — a write to a *shared entry* surfaces to every run sharing it as a folded, attributed delta (§14.5). *State.*
- the **voice door** — an **inject** delivers a turn into a *specific* run's log; `btw` is the user's mid-loop inject. *Message.*

{§1.3-two-doors}

**Wild west — no mutual exclusion.** Runs share the manifest without locks. Coordination is cooperative (tags + the shared workspace convention) and softly fenced (the §14.3 `read-only` overlay, a session policy, bounds every run's writable surface uniformly — §1.4); a conflict *surfaces* as a delta rather than being prevented. Inform, never override. {§1.3-no-mutex}

**Passive wake.** An idle run wakes on exactly two events — a prompt injected into it (voice; user or system) or a stream-status transition it subscribes to (§5.5). A delta never wakes a run; it queues and drains at the next turn one of those produces (§14.5). {§1.3-passive-wake}

**Self-hosting — the runtime is an actor, not a back channel.** Runtime-initiated work (fs reconciliation §14.3, git auto-add) is an **ephemeral `plurnk` run** firing ordinary ops, seen by other runs through the environment door like any actor's — not a privileged engine pathway. The engine keeps only the irreducible kernel runs stand on (spawn, dispatch, packet assembly, the budget rails §14.4, the fs-watch); everything expressible as ops on session entries is a run doing ops, through the same `op.*` surface (§13.5) the service offers clients. Dogfooding is the architecture, not a test mode. {§1.3-self-hosting}

**Migration path.** Largely realized: `Engine.dispatch` is origin-agnostic; client ops run in a per-connection client loop (`_dispatchAsClient`); plurnk EDITs already carry `origin=plurnk`. What remains is *repatriation* — the inline plurnk dispatches (the §14.5 materialization, today bolted into the model's loop) move into ephemeral plurnk runs via a headless spawn primitive mirroring `_dispatchAsClient`.

### §1.4 The machine and its processes: session, run, fork

**Question.** §1.3 isolates runs and lets the runtime self-host, but it stands on an ownership model it never states: what does a *session* own versus a *run*; what is shared versus private; and what does a fork carry? Unstated, the downstream questions — which run `log.read` reads, what a fork copies, where a per-client view of the workspace would live — grow subtle, then metastasize. Drawn once, they vanish.

**Decision — the session is the world; a run is a log on it.** A **session** is the world: one shared filesystem — the `session`-scoped entries, surfaced as `plurnk://manifest.json` (§15) — under one membership overlay (§14.3). Exactly one filesystem and one overlay per session; neither is per-run. A **run** is a process whose entire private memory is its **log** (§0.1) — its loops, turns, and rows, each row carrying its own content, attribution (`origin`/`source`, §14.5), and fold-state (`indexed`). A run owns **no entries** and **no membership**; even its visibility is not a possession but a bit on its own rows. It is a *history over the shared world, not a world*.

**One filesystem.** The entries are the session's: `entries.session_id`, never a run. A write by any run is a write to the one filesystem every run reads; there is no per-run entry set. {§1.4-one-filesystem}

**One overlay.** Membership — `git ls-files ∪ add − ignore` with read-only (§14.3) — is the session's: `session_constraints.session_id`, never a run. It is workspace *curation*, and the workspace *is* the session; two runs are two conversations about one curated workspace and see the same one. Divergent membership is a different session, never a per-run overlay. {§1.4-one-overlay}

**A run is its log — and nothing beside.** The run-private state is the log and only the log. *What I am looking at* (OPEN/FOLD) is `log_entries.indexed`, a bit on the run's own rows, toggled by ordinary `log://` ops — not a second store, and never membership (§6.3). *What I last saw* needs no shadow either: a run learns its world moved through log entries (§14.5) — a sibling's write broadcast into its log, an out-of-band disk change detected against the entry's own content and broadcast the same way — never through a per-run snapshot the run cannot see. The log is the whole of a run's memory. {§1.4-run-is-its-log}

**Fork — copy the log, share the world.** A fork is a new run in the *same* session (`runs.parent_run_id`, §0.1). It copies the **log** — the rows, their fold-state riding along — so the branch inherits everything the parent observed (§14.5 makes a run's timeline self-contained for exactly this) and diverges freely after. {§1.4-fork-copies-the-log} It shares the **world** — the one filesystem, the one overlay — live and uncopied, because the run never owned it. {§1.4-fork-shares-the-world}

**A session cannot be forked.** There is nothing to branch — a session *is* the shared ground. `runs` carries `parent_run_id`; `sessions` carries no parent. Parallel histories over one workspace are forks of its runs; a divergent workspace is a new session. {§1.4-no-fork-session}

**Rationale.** The model falls out of one correction: *a run is a history over a shared world, not a world.* Entries are the world (session); the log is the history (run); forking a history need not copy the world, and a run accumulates nothing the log does not already hold. The overlay's session home is forced the same way — it is the world's curation, and the world is shared; per-run it fragments the one manifest, forks the membership read-gate (the §14.3 security line), and duplicates what FOLD already does at the right level. Every "which run / what's copied / where's the per-client view" answers itself once the world/log line is drawn.

**Migration path.** Mostly stating what the schema already carries: `runs.parent_run_id` and the parentless `sessions` exist (§0.1); `session_constraints` is session-level (§14.3); §14.5 already makes a run's timeline self-contained, so a fork's log copy suffices. Additive: `run.fork` over the wire (the engine fork is built). Two repatriations: §1.3's "read-only overlay scopes a run's writable surface" becomes a *session* policy bounding every run uniformly; and the §14.5 environment door sheds its per-run watermark — a run's only memory is its log, so drift is the broadcast (run-caused) and the build-time disk-vs-entry diff (ambient), both landing as log entries, never a per-run snapshot.

---

## §2 Provider Contract

Author-facing contract: [plurnk-providers#1](https://github.com/plurnk/plurnk-providers/issues/1). Below: consumption surface + engine→provider guarantees.

### §2.1 Consumption surface

Three entry points:

- `provider.generate({messages, signal})` — once per turn; returns `{ assistant: { content, reasoning, usage, finishReason, model }, assistantRaw }`. **Engine parses `assistant.content`** into `PlurnkStatement[]` via `@plurnk/plurnk-grammar`. {§2.1-generate}
- `provider.countTokens(text)` — synchronous, called at write-time (§14.2) and render-time. Non-negative integer. {§2.1-counttokens}
- `provider.costFor(usage)` — once per completed turn; pico-USD. Engine writes to `turns.usage_cost_pico`; triggers cascade to `runs.cost_pico` / `sessions.cost_pico`. {§2.1-costfor}

Plus immutable identity: `provider.contextSize` (token total, or `null` → "no budget info"), read by the budget {§2.1-identity}; and `provider.model` — the instance identity the deferred model-switch recompute compares (§14.2), exposed but not yet consumed here.

### §2.2 Engine → provider guarantees

- `messages` is a complete prompt (`system_definition`, `persona`, `index`, `log`, `prompt`, `telemetry`, `system_requirements` pre-assembled). Provider does not reorder.
- `signal` is wired to the run's AbortController. {§2.2-signal-wired}
- `generate` is single-call per turn. No parallel calls on the same instance. {§2.2-single-call}
- `assistantRaw` is opaque to the engine (forensics-only). {§2.2-assistantraw-opaque}
- `countTokens` is cheap by contract; engine calls frequently.

### §2.3 Provider instantiation

Model alias parsing (`parseAliasesFromEnv` / `resolveActiveAlias`) lives in [`@plurnk/plurnk-providers`](https://github.com/plurnk/plurnk-providers). {§2.3-alias-resolution} Dynamic provider instantiation (`instantiateProvider` / `loadActiveProvider`) lives in `src/core/ProviderInstantiate.ts` here — `import()` resolves package specifiers relative to the calling module, so the dynamic-import path stays in the consumer where the `@plurnk/plurnk-providers-<vendor>` packages are installed.

```
PLURNK_MODEL_gemma=openai/macher.gguf
PLURNK_MODEL_opus=openrouter/anthropic/claude-opus-latest
PLURNK_MODEL=gemma
```

First path segment = provider plugin; rest = provider's own model id.

### §2.4 Mock provider (sibling fixture)

`Mock` (exported from `@plurnk/plurnk-providers`) — intg fixture + reference implementation. `{ contextSize, responses }` constructor; `generate` shifts from the queue. `MockResponse.assistant.ops?: PlurnkStatement[]` is a pre-parsed escape hatch the engine consumes directly when present; production providers don't expose this. {§2.4-mock-fixture}

---

## §3 Scheme Contract

Author-facing contract: [plurnk-schemes#1](https://github.com/plurnk/plurnk-schemes/issues/1). Below: what plurnk-service exposes to schemes and orchestrates over them.

### §3.1 Manifest

Per author contract. Each scheme declares a `static manifest: SchemeManifest` with `name`, `channels`, `defaultChannel`, `category`, `scope`, `writableBy`, `volatile`, `modelVisible`, optional `flags`. {§3.1-manifest} Identity match enforced at plugin load: `manifest.name` must equal `package.json#plurnk.name`.

### §3.2 CRUD primitives

Per author contract (`readEntry` / `writeEntry` / `deleteEntry`). Engine drives cross-scheme COPY/MOVE/SEND[410] through these — the orchestration and its 404/409/415 semantics are anchored under §6.4/§6.5. Each method is one SQL transaction; engine owns the outer transaction for orchestrations.

### §3.3 Op methods

Per author contract (`edit`/`read`/`open`/`fold`/`find`/`send`/`exec?`). Engine dispatches by `PlurnkStatement.op`. {§3.3-op-dispatch} COPY and MOVE are NOT scheme methods — engine orchestrates over CRUD primitives (§6.4/§6.5).

### §3.4 Cross-scheme orchestration

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

Same- and cross-scheme operations share the orchestrator. Same-scheme COPY is not a special case. Orchestration behavior — 404/409/415, `move` = `copy` + `deleteEntry` — is anchored under §6.4/§6.5.

### §3.5 SEND dispatch (status-code-as-verb)

Directed SEND (non-null path) routes to scheme's `send`. Status = intent:

- `SEND[200](path)` — write body into resource (WS message, exec stdin).
- `SEND[499](path)` — cancel active subscription (§7).

`SEND[410](path[#fragment])` also deletes the target entry/channel — an implemented side-effect, NOT taught to the model and with no live/demo surface. The model-facing delete idiom is KILL (the MOVE→`/dev/null` idiom is retired, §6.5).

Other status codes return 501 from entry-bearing schemes by default. {§3.5-entry-schemes-501-on-non-410}

Null-path SEND is broadcast (§6.7), engine-handled.

### §3.6 Consumption surface

Per-call context (`src/core/scheme-types.ts`):

```ts
interface PlurnkSchemeContext {
    readonly db: Db;
    readonly sessionId: number;
    readonly runId: number;
    readonly loopId: number;
    readonly turnId: number;
    readonly writer: "model" | "client" | "plurnk" | "plugin";
    readonly signal: AbortSignal | undefined;
    readonly streamEventNotify?: StreamEventNotify;
    readonly wakeRunNotify?: WakeRunNotify;
    readonly mimetypes?: Mimetypes;
}
```

Notifier fields populated by the Daemon; absent in test fixtures.

Engine → scheme guarantees:

- `ctx` is fresh per call. No mutation across calls.
- `ctx.writer` reflects the actual writer at this dispatch.
- `manifest.writableBy` checked BEFORE invocation; engine returns 403 directly on exclusion. {§3.6-writableby-403}
- `ctx.signal` is wired to the run's AbortController (§2.2-signal-wired).
- Scheme exceptions become the action-entry's outcome (status 500); summary surfaces in next turn's `packet.user.telemetry.errors[]` (§15.1). {§3.6-exception-500}

**Tokenization participation.** Schemes route writes through the shared `_entry-crud.ts` write helper (in plurnk-service today; migrates to plurnk-schemes). Helper populates `entry_channels.tokens` at write time via `ctx.provider.countTokens` (§14.2-tokens-stored-at-write). Raw DB writes bypass tokenization — out of API scope.

---

## §4 Mimetype Contract

Author-facing contract: [plurnk-mimetypes](https://github.com/plurnk/plurnk-mimetypes). Below: firing semantics + consumption surface.

**Firing semantics.** Render-time consumers. Engine invokes during packet assembly; handlers read current channel content (possibly mid-stream), produce structural view, result lands in the manifest catalog. Schemes do NOT call mimetype handlers at write time. {§4-schemes-do-not-invoke-handlers}

### §4.1 Manifest

Per author contract. Manifest declares `kind: "mimetype"`; handler class declares `mimetype` (matches manifest name) and `glyph` (single emoji). Collisions fail-hard at boot per §9.

### §4.2 Methods

Author contract owned by plurnk-mimetypes. plurnk-service consumes ONE entry point:

- `Mimetypes.process(input)` — the projection entry point; returns the structural projections (`deepJson` / `deepXml` / `symbols` / `references`) + extent (`totalLines`). {§4.2-process-entry-point}

**The daughter projects; the service queries.** `Mimetypes.query()` exists in the author contract, but plurnk-service does NOT consume it. The service owns **all** dialect matching — glob, regex, jsonpath, xpath, `@graph`, `~semantic` — resolved in-tree over those projections plus its own indexes (`symbol_defs`/`symbol_refs`, FTS5, vectors). mimetypes is mimetype-*literate* (content→structure); the service is dialect-*literate* (structure→matches). The pattern-matching DSL is plurnk's defining surface — the service's authority, never a daughter's.

Cross-cutting promises service relies on:

- Render-time only. Schemes do not invoke.
- Deterministic for a given (content, mimetype) tuple.
- Validation errors propagate (fail-hard).
- Degraded projection (a `grammarMissing` marker) rather than throw when a grammar is absent.

### §4.3 What handlers do NOT do

- **Tokenization** — provider-bound (§2).
- **Storage** — pure functions over content strings.
- **Streaming** — handlers see whatever content is current; subscription registry lives between schemes and §7.

### §4.4 Bundled vs sibling handlers

No mimetype handlers ship in-tree. Framework + every handler are siblings.

### §4.5 Consumption surface

plurnk-service is mimetype-illiterate. Engine hands channel content + mimetype label to `Mimetypes.process({content, hint})`; the manifest build uses `result.totalLines` for each channel's `lines`. Content reaches the model on READ, not as a rendered preview.

**Required dependencies** (hard deps in `package.json`):

| Package | Mimetype | Why required |
|---|---|---|
| `@plurnk/plurnk-mimetypes-text-markdown` | `text/markdown` | LLM emission default; configured as `defaultMimetype` on the `Mimetypes` orchestrator. |
| `@plurnk/plurnk-mimetypes-text-plain` | `text/plain` | Canonical EXEC stdout/stderr channel mimetype. |
| `@plurnk/plurnk-mimetypes-application-json` | `application/json`, `application/jsonc` | Service emits json for `log_entries` rx/tx, telemetry, packet serialization. |

Everything else is opt-in; framework's `discover()` picks up installed packages automatically.

**Tokenize injection.** Daemon constructs `Mimetypes` with a `tokenize` lambda capturing the active provider's `countTokens`:

```ts
new Mimetypes({
    tokenize: async (text) => this.#provider?.countTokens(text) ?? Math.ceil(text.length / 4),
    defaultMimetype: "text/markdown",
});
```

Fallback heuristic is a boot-before-provider-resolved tripwire.

**Manifest build.** `EntryManifest.buildManifestBody` is the engine-side packet-assembly pass (the §4 firing point) that walks **every** entry. It calls `process({ content, hint })` per channel for the catalog's `lines` (`totalLines`) and, for the body channel, pulls `symbols`+`references` from the *same* call to (re)build the `@graph` symbol index (`symbol_defs`/`symbol_refs`) via `EntryGraph.populateFrom` — one parse, two projections:

```ts
const result = await mimetypes.process({ content: r.content, hint: r.mimetype }, { channels: ["symbols", "references"] });
entry.channels[r.channel] = { mimetype: r.mimetype, tokens: tokenize(r.content), lines: result.totalLines };
if (isBody) await EntryGraph.populateFrom(db, sessionId, r.entry_id, result.symbols ?? [], result.references ?? []);
```

`hint` short-circuits detection. The service consumes `totalLines` (extent), `symbols`/`references` (the `@graph` index), and `deepJson`/`deepXml` (matcher dispatch); never a rendered preview — content reaches the model on READ. Because this pass runs every assembly over every entry, any content change — by any writer — is reflected in the next packet's index. The `@graph` index is NOT engine *ranking* (the anti-pattern): it's a complete, unranked index the model queries via `FIND @<sym`, the manifest paradigm applied to structure, uniform across schemes (`file://` is the primary case).

**Conformance.** Mimetype-specific behavioral tests live in each handler's own surface. plurnk-service intg covers integration: the engine routes through `Mimetypes.process` with the right hint and the catalog reflects `totalLines`; tests use auto-discovery (production handler set); a custom-handler test injects a stub `BaseHandler` via `loader + discovery`.

---

## §5 Channel Topology

Every entry has named channels. **Channels are append-only content stores** keyed by `(entry_id, name)`. Schemes write content; the engine reads at turn boundaries; mimetype handlers interpret. {§5-channels-append-only}

### §5.1 Per-entry channels

EDIT writes one channel per call — the channel resolved from the path's fragment (or the scheme's `defaultChannel` when no fragment). {§5.1-edit-writes-only-body}

No stored `preview` channel — channel content is pulled on READ, never previewed.

Schemes MAY declare multiple channels (`exec`: stdout/stderr/stdin; `http`: body/header; SSE: per-event-type). Each goes in `manifest.channels` with mimetype pinned; rendered independently.

### §5.2 Entries carry no visibility

Every entry is uniformly listed in `plurnk://manifest.json` (§15) and READable — entries have no per-run open/folded state. Context curation is the model's, on the **log** (via OPEN/FOLD, §6.3), never on entries.

### §5.3 Mimetype is a (scheme, channel) property — never a default

Mimetype is declared by scheme manifest (§3.1) or supplied per-call for dynamic schemes. Writing a channel without a declared mimetype throws. No default mimetype anywhere.

- Cross-mimetype COPY/MOVE → 415, never coerces (§6.4). {§5.3-cross-mimetype-415}

### §5.4 Channel selection in the DSL

DSL targets a specific channel via the URL fragment (`#name`).

Rules:

1. Fragment-less paths target the scheme's `defaultChannel`. {§5.4-fragmentless-targets-default-channel}
2. Paths with a fragment target the named channel. {§5.4-fragment-selects-named-channel}
3. Unknown channel name → 400. {§5.4-unknown-channel-400}
4. Schemes without `defaultChannel` reject fragment-less EDIT/READ.
5. Non-default channel EDIT requires entry to exist (404 if absent); default-channel EDIT creates. {§5.4-fragment-on-nonexistent-404}
| URI | Channel |
|---|---|
| `known://france/capital` | body (default) |
| `known://france/capital#symbols` | symbols |
| `exec://sh/1/1/2#stdout` | stdout |
| `exec://sh/1/1/2#stderr` | stderr |
| `sse://feed/y#data` | data |
| `log://N/T/A` | (no channel concept; atomic log row) |

Op implications:

- EDIT to undeclared channel → 400; read-only channel → 405.
- COPY/MOVE with fragment is per-channel; design deferred until needed.

RPC params carry fragments inline via the `target` string (`{ target: "known://x#stderr" }`).

**Wire rendering: default channel is path-only.** Heredoc fence omits `#channel` when channel matches `defaultChannel`. Single-channel entries render path-only; multi-channel entries render the default path-only and only non-default carries `#name`.

```
<<notes.md:...:notes.md             — file scheme (bare)
<<exec://sh/1/1/2:...:exec://sh/1/1/2 — exec default (stdout)
<<exec://sh/1/1/2#stderr:...:exec://sh/1/1/2#stderr — non-default
<<log://1/1/0:...:log://1/1/0       — atomic log row
```

### §5.5 Channel state — metadata, not gating

Each channel has `state ∈ {static, active, closed, errored}`. Metadata only, not an engine gate. {§5.5-state-is-metadata}

- `static` — content final, not being written. Entry schemes after EDIT.
- `active` — scheme is writing (chunks arriving). Streaming schemes during accumulation.
- `closed` — stream ended cleanly. Content final.
- `errored` — stream ended in error. Content may be partial; reads return what accumulated.

Schemes own transitions; UPDATE `entry_channels.state` as connection lifecycle progresses. {§5.5-schemes-own-state-transitions} State does not gate reads — schemes return accumulated `content` regardless (§5.5-state-is-metadata).

Model uses state to anticipate growth between turns. Clients use state for UI (spinner / red border / etc.).

---

## §6 Op Surface

Per-op semantics. AST shapes from `@plurnk/plurnk-grammar`'s `PlurnkStatement`. Engine dispatches by `op`; scheme implements per author contract (§3).

### §6.1 EDIT

AST: `{ op: "EDIT", target, body: string | null, signal: tags | null, lineMarker? }`.

- Resolves target channel from fragment (§5.4); unknown channel → 400; undeclared in manifest → engine crash (§5.3).
- Writes body; `body: null` clears. {§6.1-null-clears}- Returns `{ status: 201, entryId }` for new entries; `{ status: 200, entryId }` for content updates. {§6.1-status-201-200}
- A write that changes nothing — identical content and no new tag — returns `{ status: 304, entryId }`, mirroring OPEN/FOLD's no-op (§6.3). {§6.1-noop-304}
- Tags from `signal[]` apply additively via `entry_tags` (scheme may vary). {§6.1-tags-additive}

### §6.2 READ

AST: `{ op: "READ", target, body: MatcherBody | null, signal: tags | null, lineMarker? }`.

- Returns channel content + mimetype {§6.2-read-content}, or 404 {§6.2-read-404}.
- `lineMarker` slices per §16.3.
- `body` matcher dispatches through `Mimetypes.query` per §16.1 (all four dialects wired).

### §6.3 OPEN / FOLD

AST: `{ op: "OPEN"|"FOLD", target, body: MatcherBody | null, signal: tags | null, lineMarker? }`.

OPEN/FOLD operate on the **log** (`log://`) — the model's context-curation surface (§15). FOLD collapses a log row to its path; OPEN restores its body. Non-destructive: rows and bodies persist, re-OPENable. Entries carry no visibility (§5.2), so OPEN/FOLD against an entry scheme returns 501.

### §6.4 COPY (engine-orchestrated)

AST: `{ op: "COPY", target (source), body (destination), signal: tags | null, lineMarker? }`.

Engine orchestrates over CRUD primitives (§3.2, §3.4):

1. `src_scheme.readEntry` → 404 if missing. {§6.4-missing-source-404}
2. `dst_scheme.readEntry` → conflict verdict, deferred until the written content is known (step 5): exists with identical content + tags → 304 (no-op, mirrors EDIT §6.1) {§6.4-noop-304}; exists with different content → 409 (no overwrite) {§6.4-conflict-409}; absent → proceed.
3. Mimetype compat — channels' mimetypes must be accepted by `dst_scheme.manifest.channels`. Mismatch → 415.
4. Tags: `signal` non-null replaces source tags {§6.4-signal-replaces-source-tags}; null/empty carries source tags {§6.4-no-signal-carries-source-tags}.
5. `dst_scheme.writeEntry({channels, tags})`.

Returns 201 on success. Same- and cross-scheme COPY share the orchestrator. {§6.4-cross-scheme-copy}

### §6.5 MOVE (engine-orchestrated)

AST: `{ op: "MOVE", target (source), body: dest | null, signal: tags | null, lineMarker? }`.

- **Relocation** (`body` non-null, resolvable dest): COPY (§6.4) + `src_scheme.deleteEntry` in one transaction. 201 on success. {§6.5-relocation-deletes-source} Cross-scheme same as same-scheme. {§6.5-cross-scheme-move} Missing source → 404. {§6.5-missing-source-404}
- **MOVE never deletes.** A null body → 400 (a destination is required). {§6.5-null-body-400} `/dev/null` carries no special meaning — the MOVE→/dev/null delete idiom is retired; KILL is the canonical delete. {§6.5-dev-null-not-special}

Log history preserved — `log_entries` stores path tuple as text, not FK to `entries.id`.

### §6.6 FIND

AST: `{ op: "FIND", target (scope), body: MatcherBody | null (predicate), signal: tags | null, lineMarker? }`.

- Filters entries within scope (scheme + pathname prefix). {§6.6-scope-prefix-filter}
- `body` matcher operates on entry content (glob/regex/jsonpath/xpath), per grammar plurnk.md §"Body matcher dispatch"; the path-glob lives in the (target), not the body. {§6.6-glob-filter-on-content}
- `signal` is a tag filter; entries match if they have ALL listed tags. {§6.6-tag-filter-and-semantics}
- Session + scheme scoped — no cross-session/cross-scheme leakage. {§6.6-scoped-isolation}
- Returns `{ status: 200, results: string }` (newline-separated matching paths, `text/plain`).

### §6.7 SEND

AST: `{ op: "SEND", target: ParsedPath | null, body: SendBody | null, signal: number | null }`.

- **Broadcast** (path null): terminal status (200/499) updates `loop.status` and ends loop. Other codes return `{status}` with no state change.
- **Directed** (path non-null): routes to `scheme.send` per §3.5.

### §6.8 EXEC

AST: `{ op: "EXEC", target (cwd), body: string | null (command), signal: string | null (runtime tag) }`.

Engine routes unconditionally to `exec` scheme (path slot is `cwd`, not a URI). The runtime slot (`signal`) selects an executor, resolved against the boot-time `ExecutorRegistry` — siblings discovered and probed at startup, availability cached, default `sh`. Unknown or unavailable runtime → 501 carrying the probe `detail`. {§6.8-registry-resolves}

**Effect-gating.** Each executor declares an `effect` (`pure` | `read` | `host`); the service maps it to policy (`EffectPolicy`). A `host` runtime (subprocess; file-backed sqlite) mutates the host → **propose**: the run waits for a human gate, then spawns and writes stdout/stderr to channels of an `exec://<runtime>/<loop>/<turn>/<seq>` entry (the executor is the URI authority; the coordinate that follows matches the op's log-row coordinate, e.g. `exec://sh/1/1/2`), returning `102 Processing` immediately. Channel state transitions (`active` → `closed`/`errored`) drive the model's view at subsequent turn boundaries (§5.5). {§6.8-host-proposes}

A `read` runtime (observes external state, e.g. search) or `pure` runtime (no observable effect, e.g. `:memory:` sqlite) is side-effect-free → **auto-run** in-process: no proposal, no human gate, no notification. The run is awaited synchronously and its channel content rides back as the EXEC result body the same turn — not streamed to the entry for a next-turn read. {§6.8-readpure-inline}

`SEND[499](exec://<runtime>/<loop>/<turn>/<seq>)` cancels in-flight subprocess via subscription registry's stored AbortController (§7.5).

---

## §7 Stream Model

Streams are static content from the engine's perspective — content arrives over time, channels grow, mimetype handlers render whatever's there at turn boundaries. No engine-level transaction abstraction; schemes own connection lifecycle. {§7-no-engine-transaction-abstraction}

### §7.1 Subscriptions

READ on a streaming scheme is a subscription, not a one-shot. Scheme opens the connection (SSE/WS/subprocess), returns `102 Processing` immediately, stays alive. Engine records `(sessionId, entryId) → schemeName + handle` in a subscription registry so `SEND[499]` cancellation routes to the owning scheme. {§7.1-subscription-registry-routes-cancellation}

Subscription registry is plurnk-service runtime state (its own SQLite table). Exists ONLY for cancellation routing. Channel state (§5.5) + log entries (§7.3) carry lifecycle.

### §7.2 Chunk accumulation

SSE event types, WS message types, exec stdout/stderr each map to a named channel. Channel record (`ChannelContent`): `content`, `mimetype`, `tokens`. Active-connection state lives in the subscription registry, not on the channel. Chunks accumulate into the channel as they arrive — not buffered until close. {§7.2-chunks-accumulate}

### §7.3 No per-chunk log rows

Channels are the source of truth for chunk content. Log captures lifecycle events only: open (102), graceful close (200), cancel (499), errors (5xx), scheme-significant transitions. {§7.3-log-captures-lifecycle-only}

Model sees lifecycle events in `packet.system.log[]` per turn.

### §7.4 Deep slices on demand

`<<READ(sse://feed/x#data)<N-M>:…:READ` pulls a slice into a log row when the model wants a specific line-range of the stream.

### §7.5 SEND for stream control

- **Cancel:** `<<SEND[499](sse://feed/x)::SEND` — scheme tears down via AbortController.
- **Write:** `<<SEND[200](wss://feed/x):body:SEND` — pipes body into active connection (WS, exec stdin, etc.).

### §7.6 Engine constraints

ONE engine-level constraint: **100 MiB char-length cap per channel body**. `CHECK (length(content) <= 104857600)` on `entry_channels.content` (migrations/001_schema.sql). Violations → SQLITE_CONSTRAINT; action-entry captures rejection at status 500.

All other limits are extrinsic — providers (request size, model context, fetch timeouts), schemes (per-call validation), mimetypes (render budgets). Engine does not throttle, batch, rate-limit, or cap anything else. {§7.6-engine-one-cap}

### §7.7 Live updates for clients (between turns)

Daemon emits `stream/event` notifications (§13.6) when channel content changes; clients use them for live waterfalls without polling. {§7.7-stream-event-fires-on-chunk}

The model is NOT a stream/event consumer — turn-based only; sees whatever's in the channel at the next turn boundary.

---

## §8 Storage Model

SQLite (`node:sqlite`) with WAL mode and STRICT tables. Hand-written DDL; CI-aligned against grammar schemas.

### §8.1 DDL strategy

No generator. SQLite-optimal: STRICT (3.37+), `INTEGER PRIMARY KEY` aliasing, explicit `NOT NULL`, indexed query paths, deliberate FK `ON DELETE`/`ON UPDATE`, `WITHOUT ROWID` where access pattern warrants, generated columns, FTS5.

- One migration file per cohesive concern. Numbered, deterministic apply order.
- `migrate` CLI: idempotent; skips applied markers in `applied_migrations`.
- **Schema-alignment test**: loads `@plurnk/plurnk-grammar/schema/*.json`, parses DDL via `node:sqlite` introspection, asserts every required schema field has a corresponding `NOT NULL` column. Grammar drift fails CI.
- DDL = storage truth; JSON Schemas = wire truth. Tested-aligned, allowed to differ where ergonomics demand.

### §8.2 SQL/TS responsibility boundary

**Lives in SQL:**
- Render queries — log assembly + the manifest catalog.
- Cross-scope path collision (CHECK/trigger → 409).
- Cost rollups (denormalized pico-units; atomic on turn close).
- Sequence number issuance (1-based per grammar).
- Entry-vs-log integrity.

**Lives in TS:**
- Status-bubble rules (`turn.status` → `loop.status` → `run.status` → `session.status`). Engine UPDATEs explicitly; CHECK constraints enforce; triggers fight branching state machines.
- Tokenization (provider-bound; hot-swap re-tokenizes per §14.2).
- Provider dispatch + response normalization.
- Scheme-handler invocation (connections, subprocesses, fetch).
- Plugin loading (§9).
- Stream AbortController lifecycle.
- CLI + daemon.

When SQL becomes onerous for a specific case, retreat for that case and document why.

---

## §9 Plugin Discovery

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

## §10 Bundled Set

Plugin discovery (§9) registers whatever's in `node_modules/@plurnk/*`.

**Providers in-tree (`src/providers/`):** `Mock` (intg-only test fixture + worked example).

**Mimetypes in-tree:** none. Framework + handlers are all siblings.

**Schemes in-tree (`src/schemes/`)** — transitional; each extracts to a sibling under [plurnk-schemes](https://github.com/plurnk/plurnk-schemes) as the framework matures:

| In-tree | Future sibling | Notes |
|---|---|---|
| `Known.ts` | `@plurnk/plurnk-schemes-known` | Primary narrative entries; session-scoped. |
| `Unknown.ts` | `@plurnk/plurnk-schemes-unknown` | Open questions / decomposition. |
| `Skill.ts` | `@plurnk/plurnk-schemes-skill` | Skill docs; same shape as known. |
| `Plurnk.ts` | may stay in-tree | `plurnk://prompt/<loop_id>` carries each loop's prompt. Model-origin writes to `plurnk://prompt/*` rejected in-handler. |
| `Log.ts` | may stay in-tree | Read-only coordinate-addressed (`log://<L>/<T>/<S>`). Renders as JSON meta line in packet log; status ≥ 400 mirrors to `packet.user.telemetry.errors[]` (§15.1). |
| `File.ts` | `@plurnk/plurnk-schemes-file` | Filesystem-backed. **Model is never trained on `file://` and never sees it.** Bare paths are model-facing; `file://` accepted as input, renders bare. |
| `Exec.ts` | stays in-tree | Dispatches EXEC op to runtime executors registered via [plurnk-execs](https://github.com/plurnk/plurnk-execs). |

**Executors in-tree:** none. Framework + every runtime are siblings. `Exec.ts` dispatches by the EXEC op's `runtime` slot (`sh` default, `node`, `python`) to the matching sibling. Today's registry is hardcoded; plugin discovery migration tracked in [plurnk-execs#1](https://github.com/plurnk/plurnk-execs/issues/1).

---

## §11 Grammar Dependency

`@plurnk/plurnk-grammar` is the contract. Authoritative; surface gaps via issue, adopt what lands. Don't redesign from this side.

### §11.1 What grammar provides

- Parser (`PlurnkParser`, ANTLR4) — DSL text → `PlurnkStatement[]`.
- AST types — exported TypeScript interfaces.
- JSON schemas (`schema/*.json`, draft 2020-12) for every wire shape.
- `plurnk.md` — canonical model-facing DSL description.

### §11.2 What plurnk-service tracks (NOT in grammar)

- Channel state (`active`/`closed`/`errored`) — subscription registry, not on `ChannelContent`.
- Backpressure caps — none (§7.6).
- Stream cancel — `SEND[499]` (§7.5).
- Delete — MOVE to `/dev/null` (§6.5); `SEND[410]` also deletes as a side-effect (§3.5).
- Per-loop flags — `loops.flags` JSON column; `yolo` end-to-end today, others scheduled.
- Default-channel wire rendering — §5.4.

---

## §12 Operator Configuration

Env-var cascade: `.env.example` < `.env` < `.env.<config>` (via `--config=`) < shell < CLI flags. `bin/plurnk-service.ts` auto-loads `.env.example`; zero-setup boot.

Model selection: separate alias cascade in `ProviderRegistry` (§2.3). `PLURNK_MODEL_<alias>=<provider>/<model-id>` declares; `PLURNK_MODEL=<alias>` selects. Aliases live in `.env`, not `.env.example` (operator-specific).

| Var                                  | Default            | Status     | Purpose                                                       |
|--------------------------------------|--------------------|------------|---------------------------------------------------------------|
| `PLURNK_DB_PATH`                     | `./plurnk.db`      | enforced   | SQLite file path.                                             |
| `PLURNK_HOST`                        | `127.0.0.1`        | enforced   | Bind address for the daemon WebSocket. Local-only by default. |
| `PLURNK_PORT`                        | `3044`             | enforced   | TCP port for the daemon WebSocket.                            |
| `PLURNK_MAX_TURNS`                   | `999`              | enforced   | Per-loop turn cap (overridable per `loop.run` call).          |
| `PLURNK_MAX_COMMANDS`                | `99`               | enforced   | Per-emission op cap. Overflow ops drop silently; one `max_commands_exceeded` telemetry entry surfaces on the next packet. |
| `PLURNK_RPC_TIMEOUT`                 | `30000`            | reserved   | ms timeout for non-`longRunning` RPC handlers. Not yet enforced. |
| `PLURNK_LOOP_TIMEOUT`                | `86400000`         | reserved   | ms wall-clock budget for a single `loop.run`. Not yet enforced. |
| `PLURNK_MAX_STRIKES`                 | `3`                | enforced   | Strike threshold + sudden-death lead time (§0.5).             |
| `PLURNK_MIN_CYCLES`                  | `3`                | enforced   | Min repetitions before cycle detection fires (§0.5).          |
| `PLURNK_MAX_CYCLE_PERIOD`            | `4`                | enforced   | Max period length cycle detection examines (§0.5).            |
| `PLURNK_PERSONA`                     | `persona.md`       | enforced   | Path to the default persona file. Tail of the persona cascade: loops.persona > runs.persona > sessions.persona > this file. |
| `PLURNK_PROPOSAL_TIMEOUT_MS`         | `300000`           | enforced   | ms wait for a proposed entry (status=202) to be resolved before timing out.  |
| `PLURNK_REASON`                      | `0`                | enforced   | Reasoning-token budget. 0 = disabled. Positive = budget in tokens; provider modules translate to wire format. |
| `PLURNK_FETCH_TIMEOUT`               | `600000`           | enforced   | Service-wide ms ceiling on any outbound request (providers, future http schemes). Module-specific overrides are allowed below the ceiling. |
| `PLURNK_DEBUG`                       | `0`                | reserved   | Schema-validation toggle. Not yet enforced.                   |
| `PLURNK_LOG_LEVEL`                   | `info`             | reserved   | Stdout banner verbosity. Not yet enforced.                    |

**enforced** = engine reads and acts on the value. **reserved** = shipped in `.env.example` (forward-spec) but no-op until wired.

**Two override semantics — ceiling vs default.** Which kind a var is determines what "override" means across the cascade:
- **Ceiling** (most-restrictive-wins) — an operator-set hard bound nothing downstream may exceed: not a lower-precedence file, not a per-session constraint, not a per-call RPC arg. `PLURNK_GIT_ENABLED` (`=0` flatly denies git service-wide, §14.3), `PLURNK_BUDGET_CEILING` (§14.2), `PLURNK_MAX_COMMANDS`, `PLURNK_MAX_STRIKES`, and `PLURNK_FETCH_TIMEOUT` (module overrides allowed only *below* it). The sandbox/cost guarantee: the operator caps it; no client widens it.
- **Default** (explicit-wins) — a fallback the most-specific setter replaces freely: `PLURNK_MODEL` (a `loop.run({alias})` overrides it), `PLURNK_PERSONA` / `PLURNK_REQUIREMENTS` (the §15.3 persona cascade / per-call requirements), and the config-time vars (`HOST` / `PORT` / `DB_PATH`).

Enforcement is per-use-site — no central most-restrictive pass; each ceiling is checked where it bites. `PLURNK_MAX_TURNS` is today a **default** (`loop.run({maxTurns})` overrides it with no cap check) despite its "cap" wording — open: if an operator turn-limit should be inviolable, it moves to ceiling semantics (a per-call `min()` against the env value).

Feature-flag bools use `process.env.X === "1"` exactly — never `=== "true"`.

External plugins declare their own env vars in their own `.env.example`; service merges at boot via the cascade.

**Admin CLI flag derivation.** `bin/plurnk-service.ts` auto-derives flags from `.env.example`: every `PLURNK_*` becomes `--<kebab-cased-name>` (prefix stripped, lowercased, underscores → dashes). Comment immediately above (no blank line) becomes `-h` description. Non-`PLURNK_*` vars in `.env.example` are bugs — vendor config belongs in the vendor's package namespace.

---

## §13 RPC Surface

plurnk-service runs as a daemon. Clients (TUI/CLI/neovim/web/Telegram/etc.) drive it via self-describing RPC. This section is the wire — implementing a new client should require reading only §13.

### §13.1 Transport

WebSocket (`ws` npm). One message per `ws.send`. UTF-8 JSON. One full-duplex connection per client. Bind: `PLURNK_HOST:PLURNK_PORT` (default `127.0.0.1:3044`).

Out of scope for v0: auth, TLS, multiplexing. Local-loopback + filesystem permissions are the access control.

### §13.2 Protocol

JSON-RPC 2.0. Two message kinds:

- **Request:** `{ "jsonrpc": "2.0", "id": …, "method": …, "params": … }`. Server replies with matching `id`.
- **Notification:** `{ "jsonrpc": "2.0", "method": …, "params": … }`. No `id`; server-initiated; no reply.

Success response: `{ "jsonrpc": "2.0", "id": …, "result": … }`. Failure: `{ "jsonrpc": "2.0", "id": …, "error": { "code": …, "message": …, "data": … } }`.

### §13.3 Method registration

```ts
registry.register("loop.run", {
    handler: async (params, ctx) => { /* ... */ },
    description: "Run a model-driven loop with a prompt.",
    params: {
        prompt: "string — the user prompt for the loop",
        sessionId: "number? — defaults to current attached session",
        maxTurns: "number? — defaults to PLURNK_MAX_TURNS",
    },
    requiresInit: true,
    longRunning: true,
});
```

- `description`: one-liner surfaced by `discover`.
- `params`: `"type — meaning"` per param; `?` suffix = optional. Self-documenting, not enforced.
- `requiresInit`: rejects until a session is attached.
- `longRunning`: exempt from `PLURNK_RPC_TIMEOUT`. {§13.3-register}

### §13.4 Discovery

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
    }
}
```

`capabilities` lists registered plug-ins by `(kind, name)`. Cold clients call `discover` first. No hardcoded method names or capability lists in any client. {§13.4-discover}

### §13.5 Core method set

**Liveness + introspection**

| Method     | Params | Result | Notes |
|------------|--------|--------|-------|
| `ping`     | none   | `{}`   | No init required. |
| `discover` | none   | catalog (§13.4) | No init required. |

**Sessions**

| Method                 | Params              | Result            | Notes |
|------------------------|---------------------|-------------------|-------|
| `session.create`       | `name?: string`, `projectRoot?: string`, `persona?: string` | `{ id, name, runId, runName, projectRoot, persona }` | Creates new session + its first run; auto-name if unprovided. Returns the auto-created run's identity so clients skip the pending-dance ({§13.5-session-create}). Optional `projectRoot` pins the workspace (null/omitted = headless). Optional `persona` sets the session-level persona override. |
| `session.list`         | none                | `{ sessions: Session[] }` | Lists all sessions. |
| `session.attach`       | `id: number`, `runId?: number`, `runName?: string`, `persona?: string` | `{ id, name, runId, runName }` | Binds this connection to an existing session. Optional `runId` resumes that specific run (must belong to the session). Optional `runName` reuses-or-creates by name within the session. Both omitted → new auto-named run. Optional `persona` sets run-level persona only when a NEW run is created. {§13.5-session-attach} |
| `session.runs`         | `id?: number`       | `{ runs: Run[] }` | Lists runs in a session (defaults to attached session); most-recent first. |
| `session.set_root`     | `projectRoot: string \| null` | `{ projectRoot }` | Update the workspace pointer on the attached session. Null reverts to headless. |
| `session.set_persona`  | `persona: string \| null` | `{ persona }`  | Update the session-level persona. Null clears the override (falls through to PLURNK_PERSONA file). |
| `session.constrain`    | `effect: "add" \| "ignore" \| "read-only"`, `glob: string` | `{ effect, glob }` | Add a workspace membership constraint (§14.3 overlay): `add` admits files git misses, `ignore` drops tracked matches, `read-only` admits for read but refuses edits. Immediate. |
| `session.unconstrain`  | `effect: "add" \| "ignore" \| "read-only"`, `glob: string` | `{ effect, glob }` | Remove a membership constraint — the inverse of `session.constrain`. Immediate. |
| `session.constraints`  | none                | `{ constraints }` | List the attached session's membership constraints. |

**Re-binding.** `session.create` and `session.attach` may be called on a connection that already has a session attached — the connection switches in place, releasing the prior client loop (closed at 200). No reconnect needed to change session or run. {§13.5-rebind}

**Auto-envelope.** Clients calling a `requiresInit: true` method without first attaching get auto-created session → run → client loop. Records persist normally; auto-created ≠ auto-deleted. Cleanup is a future `session.delete` / `session.archive` endpoint. {§13.5-auto-envelope}

**Reserved run names.** `plurnk` is reserved for the runtime actor (§0.4). `session.attach` rejects it — case-insensitively, *before* the lookup-or-create — so a client can neither forge a `plurnk` run nor resume the runtime's, closing impersonation of `origin=plurnk`. The auto-namer never emits a reserved name. {§13.5-run-name-reserved}

**Loops (model-driven)**

| Method            | Params                              | Result                 | Notes |
|-------------------|-------------------------------------|------------------------|-------|
| `loop.run`        | `prompt: string`, `maxTurns?: number`, `alias?: string`, `flags?: LoopFlags`, `persona?: string` | `{ loopId, turnIds, finalStatus, hitMaxTurns, reason }` | Model-driven loop. Optional `alias` overrides the boot-time `PLURNK_MODEL`. Optional `flags` carries per-loop flags (currently `{yolo?: boolean}`; more arrive as wired — see §0.5). Optional `persona` sets the loop-level persona (highest precedence in the cascade). Streams `log/entry` and `loop/proposal` notifications during. `longRunning: true`. {§13.5-loop-run} |
| `loop.resolve`    | `logEntryId: number`, `decision: "accept" \| "reject" \| "cancel"`, `body?: string`, `outcome?: string` | `{ status, logEntryId }` | Resolve a pending proposal (status=202 log entry). Engine.dispatch unpauses on resolution. |
| `loop.cancel`     | `reason?: string`                   | `{ cancelled, runId, reason }` | Abort the attached run's active drain. `{cancelled: true}` if a drain was running, `{false}` if idle. Cancelled loops close at 499; queued-but-unclaimed loops stay enqueued. Default reason `user_cancelled`. {§13.5-loop-cancel} |
| `providers.list`  | none                                | `{ aliases: ProviderAlias[] }` | Lists configured `PLURNK_MODEL_<alias>` entries with `{alias, provider, model, active}`. Clients use to populate model-selection UI. |

**Reads**

| Method        | Params                              | Result                 | Notes |
|---------------|-------------------------------------|------------------------|-------|
| `entry.read`  | `target: string`                    | `{ status, entry }`    | Read the full entry shape (channels + tags + metadata) at the given URI. {§13.5-entry-read} |
| `log.read`    | `loopId?: number`, …                | `{ entries: LogEntry[] }` | Read recent log entries from the attached session, optionally filtered by loop. {§13.5-log-read} |

**Log coordinate.** Every `LogEntry` — from `log.read` and the `log/entry` notification alike — carries `loop_seq`/`turn_seq`, the loop+turn ordinals, beside the `loop_id`/`turn_id` DB keys, so a client renders the logical coordinate (e.g. `01/02/03`) without resolving ids. {§13.5-log-coordinate}

**DSL operations (client-driven, mirror grammar)**

Per the **Speak in DSL, not plumbing** rule (AGENTS.md): `op.*` methods construct DSL statements internally and dispatch through `Engine.dispatch`. {§13.5-op-mirror} Param shapes are ergonomic (semantic names, not HEREDOC slots); semantics are the DSL's.

Each `op.*` call creates a turn in the connection's client loop (§13.7), dispatches, fires `log/entry`, returns the dispatch result.

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

All `op.*` return `{ status, ...op-specific }`. All `requiresInit: true`. None `longRunning`.

Future: `subscription.list`, `subscription.cancel` (the latter is `op.send({status: 499, recipient})` today).

### §13.6 Notifications

Server-initiated events on the same WebSocket.

| Notification       | Params                              | When fired |
|--------------------|-------------------------------------|------------|
| `log/entry`        | `{ entry: LogEntry }`               | Every `log_entries` write. {§13.6-log-entry-notify} |
| `loop/terminated`  | `{ loopId, finalStatus, hitMaxTurns }` | Loop reaches terminal status. |
| `loop/proposal`    | `{ logEntryId, sessionId, runId, loopId, turnId, op, target, body, attrs, flags }` | Dispatch pauses on status=202. Carries `flags` so server-YOLO clients can suppress review UI. Client responds with `loop.resolve` (or `PLURNK_PROPOSAL_TIMEOUT_MS` fires). |
| `session/created`  | `{ id, name, projectRoot, persona }` | Any client creates a session. |
| `stream/event`     | `{ entryId, channel, state, contentLength }` | Channel content grows or state transitions. {§13.6-stream-event-on-channel-change} |
| `stream/concluded` | `{ entryId, target, subscriptionId, scheme, closeStatus, summary, wakeAction, wakeLoopId? }` | A streaming subscription closed (subprocess finished / errored / cancelled). `wakeAction` says whether the daemon opened a fresh loop to surface the conclusion to the model. {§13.6-stream-concluded} |
| `telemetry/event`  | `{ loopId, event: TelemetryEvent }` | A TelemetryEvent (parse error, engine-rail strike/cycle/sudden-death, scheme/provider failure) was buffered — the same envelope the model sees on the next packet, delivered live for client surfacing. {§13.6-telemetry-event} |

`stream/event` carries metadata only, never content. Clients fetch via `entry.read({target})`. **Every notification envelope carries its `sessionId`** (and `runId` where the emitter has it) so a multi-session client — one connection, many sessions — can route it ({§13.6-envelope-carries-sessionid}); the broadcast stays session-scoped too.

### §13.7 Connection lifecycle

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

**The client's run.** A client connection is an actor (§1.4); its `op.*` write to its **own run** — `origin = "client"`, one loop per connection — and `log.read` reads that run. Disconnect closes the loop's status; rows persist. Multiple connections each get their own client run.

`loop.run` and `inject` target the **model's run** — a separate run holding the conversation, `origin = "model"`. Both runs share the session's one filesystem (§1.4); the packet renders only the model's run, so the client's ops are structurally absent from it — no origin filter (§1.3-isolation). *Migration:* the daemon today opens both loops in the connection's one run (the conflation §1.4 corrects); the build gives the client and the model their separate runs.

### §13.8 Errors

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

Error responses MAY include `data: {…}` with structured context (404'd path, timed-out method, etc.). {§13.8-error-codes}

### §13.9 Versioning

Pre-stabilization. Clients track HEAD. No semver until the interface is worth committing to.

---

## §14 Architectural decisions

Each entry: question, answer, rationale, migration path.

### §14.1 Packet assembly: engine-direct, not filter-chain

**Question.** Rummy uses priority-ordered filter chains for packet assembly. Plurnk assembles directly in `Engine.#buildRequestPacket` (`#buildLog` + the materialized manifest catalog).

**Decision.** Engine-direct. Plugin-driven assembly is out of scope.

**Rationale.** Channel + mimetype split already extends rendering. Filter chain would add indirection nothing exercises. Schemes-as-URI-handlers + mimetypes-as-renderers earn extensibility through different shapes than rummy's tag-per-plugin pattern.

**Migration path.** If a plugin needs to inject a packet section, grow a single `packet.augment` hook called after `#buildRequestPacket`; plugins return system/user augmentation objects merged into the packet. Additive — engine-direct base stays.

### §14.2 Tokenomics: real provider tokens, render-weight budget, per-scheme balance

**Question.** How does plurnk track token costs accurately enough to ground the model's OPEN/FOLD/compose decisions? Accuracy is the whole game — a budget that smells wrong is one the model stops trusting and curating against.

**Two measures, never conflated:**

- **render-weight** — the tokens the model actually processes this turn (the assembled packet — manifest, log, system sections — plus meta + fences). The budget is about this.
- **content-depth** — an entry's full content size (`entry_channels.tokens`). The manifest's `tokens` is this.

**Built.**

- **Provider tokens, stored at write.** `provider.countTokens` is the source of truth; `entry_channels.tokens` (via `_entry-crud`) and `log_entries.tokens` (via `Engine.#writeLog`) are populated at write as a write-time snapshot. A `ceil(len/DIVISOR)` fallback (the divisor tripwire) applies only when no provider tokenizer is wired. {§14.2-tokens-stored-at-write}
- **Render-weight budget.** The budget headline — `ceiling`, `tokenUsage`, `tokensFree` — is measured from the *assembled packet* (placeholders substituted after measuring), so it reflects what the model actually receives. A `SUM` of stored content-depth would mis-price the rendered packet; render-weight is the accurate measure. {§14.2-render-weight-budget}
- **Per-scheme balance.** A markdown table groups the model's context by scheme — render-weight `tokens` per scheme — anchored `repo, known, unknown, log`, tail sorted by tokens. The model sees at a glance what's eating its window. {§14.2-per-scheme-balance}
- **Context-window percent.** The headline carries usage as a percent of the ceiling — `usage Y (P%)` — a fullness gauge beside the absolutes. Reads the ceiling already in hand; no extra provider call. {§14.2-context-percent}
- **Depth re-counted at render.** The manifest re-tokenizes each entry's `tokens` through the live provider at build — never the write-time snapshot — so a model change between loops can't stale the catalog. Every token figure in the packet is render-fresh, manifest and budget alike; nothing trusts a cross-loop cached total.
- **Over-budget is honest.** When usage exceeds the ceiling, `free` floors at 0 and the percent passes 100 — the readout shows the overshoot rather than a negative free, so the model knows it's over and curates down. {§14.2-over-budget-floor}

**Rejected / obviated.**

- **Hot model-switch recompute** — *obviated* by render-fresh depth (above). There's no cross-loop cache to recompute: the manifest re-tokenizes at build, the budget always did. A model change between loops can't stale a number nothing caches.
- **Reasoning-token surfacing** — *rejected* for the model-facing budget: reasoning is *output*, not window-context, and the model can't FOLD it. The thinking-vs-output distinction is cost-forensics (the usage breakdown is stored on every packet), not a curation signal.

**Rationale.** Rummy used chars/DIVISOR + compute-at-SELECT only because its sync-only SQL couldn't call a tokenizer. plurnk has real `countTokens`: store content tokens once at write (the depth), measure the small rendered output for the budget (the weight). Approximation can't ground curation — the model only curates against numbers it trusts.

**Migration path.** None on cost — SQLite, JS, and a local tokenizer are negligible against the model's token budget, the only thing worth economizing. The fallback divisor is a correctness tripwire (no provider tokenizer wired), not a performance retreat. Schema unchanged.

### §14.3 Workspace identity, membership, disk co-location

**Question.** How does plurnk represent the project a session works on? Where does file membership come from? Does writing an entry imply writing to disk?

**The boundary is the client's.** The client owns the model's filesystem access in both directions: reads are membership-gated (a file is invisible to the model unless it is a member), and writes are proposals the client accepts or rejects (`yolo` auto-accepts). Writing an entry never implies writing to disk — entries are canonical in the store; disk only moves when the client accepts a side-effecting proposal, and only where `project_root` is set (null = headless, client owns materialization).

**Built — git-substrate membership.** {§14.3-git-membership}

- **Identity on the session.** No `projects` table; `sessions.project_root TEXT` (nullable = headless). `entries.scope` unchanged (`∈ {'agent','session'}`). Workspace = session; no users/auth/multi-tenant.
- **git-ls-files membership.** git present → tracked files (`git ls-files`) are members with no explicit `add` — channel-less markers, disk is truth. git absent → no fs-walk (non-git/headless get no substrate membership).
- **EMI eager + exhaustive.** Materializes *every* active git member at prompt-composition, re-reading disk so a divergent member reflects current content. git's `ls-files` is the whole membership bound — the engine adds no relevance pass of its own. Allowing git *is* the curation.
- **Membership-gated edits.** {§14.3-edit-membership-gate} EDIT is bounded by membership exactly as READ is. An existing **member** is read from disk before diffing, so its baseline is real content, never empty — silent overwrite is structurally prevented. An existing **non-member** is refused (403) *before* any read or write: the model never reads a file it can't see (no leak into the proposal) and never overwrites one (no wiping a gitignored `.env` it never added). A **new path** stays open — proposal→accept adds it to the manifest. Reaching past membership is `EXEC[sh]`'s job, not the file scheme's.

- **Constraint overlay — `ignore`.** {§14.3-constraint-ignore} A `session_constraints` table (effect ∈ {add, ignore, read-only}, glob) is the client's supersede over git. `ignore` drops tracked matches: resolution computes `git ls-files − ignore` (`node:path.matchesGlob`) and **reconciles** — registers the desired, un-registers any git-origin member no longer desired (untracked or newly ignored) — so the entry set *equals* the member set. The lever to exclude a committed-but-sensitive tracked file; `entries.membership_origin` keeps reconciliation off model-created members.
- **Constraint overlay — `read-only`.** {§14.3-constraint-readonly} A `read-only` glob keeps a matching member readable but refuses `File.edit` — 403'd at the membership check, before any diff. A file admitted for reading without granting writes. (Admitting an *untracked* file as read-only rides on `add`'s scan.)
- **Constraint overlay — `add`.** {§14.3-constraint-add} `add` globs admit members git misses: a targeted, client-dictated `node:fs` glob scan enumerates untracked matches (files only), registered with 'constraint' origin and reconciled like git members. Enumerated, so the manifest stays exhaustive. git-absent, `add` is the *sole* membership source — the whole mechanism without git.
- **EMI divergence signal.** {§14.3-emi-divergence-signal} When git membership re-reads a member whose disk content changed out-of-band, the build-time delta detector (§14.5) surfaces it as a system `EDIT` log row naming the file, `source="file"` — the model sees what changed without diffing the manifest against memory. The model's own accepted edits advance the run's watermark, so they're never mis-attributed as external divergence.

**Rationale.** No users/tenants. Session is the right scope unit. git+constraints membership keeps the model out of fs-walk territory — and *is* the curation, outsourced: git bounds membership by tracking, the client supersedes by constraint, the model curates its view by READ/FOLD. The engine curates nothing. EMI re-reads every member each turn; the full-repo cost is git's to bound (what it tracks) and the client's to bound (`ignore`), never the engine's to bound by relevance.

**Migration path.** Tenancy / cross-session shared workspaces require a `workspaces` table joining sessions to workspace id, with constraints lifted off `session_constraints`. Disk co-location semantics unchanged.

### §14.4 Budget enforcement: the grinder

**Question.** §14.2 surfaces the budget honestly and the model curates against `tokensFree` — almost always enough. Two states defeat self-regulation, neither the model's doing: a jumbo prompt (the turn-0 environment), and an unexpectedly large read. (A jumbo repo is no longer its own case — with no index nothing auto-renders the repo; it surfaces only as a large `manifest.json` READ, which the model chunks like any big read.) What enforces the ceiling when the signal isn't enough?

**Decision — a pre-LLM grinder, fired only on actual overflow.** In `Engine.runTurn`, after the packet is assembled (`#buildRequestPacket`) and before `provider.generate`, the assembled render-weight (§14.2) is measured against the ceiling. At or under → the packet ships untouched; the grinder never trims speculatively or "helpfully." {§14.4-overflow-only} On overflow it reverts the prior turn, then hard-stops if that isn't enough:

- **Prior-turn rollback.** The immediately-prior turn's log entries — the latest emissions, the ones that pushed the packet over — are folded (`indexed=0`, the same flag the model's own FOLD uses); the prior turn fit by induction, so reverting it usually lands back under. Folded, not deleted: rows and bodies persist and are re-OPENable, so log *history* is preserved while the render collapses to coordinates. {§14.4-layer1-rollback}
- **Hard stop.** If the packet still overflows after the prior-turn rollback, the loop abandons at 499 (`engine_loop_cancel`) — the path `maxTurns` and the strike threshold already use. No further passes. {§14.4-hard-413-abort}

**Strike coupling.** A grinder fire bumps the engine's `turnErrors` — the same internal counter cycle detection feeds — so an overflow counts toward the strike streak that ends a runaway loop at 499. This is the pressure that keeps self-curation the path of least resistance. {§14.4-strike-coupling} **Turn 0/1 is exempt:** the first turn's overflow precedes any model action — it's the environment, not the model — so it never strikes. {§14.4-soft-turn-0-1}

**What the model sees.** A `budget_overflow` telemetry event (§15.1), in the model's own terms: which of its entries left the window, by scheme. No mechanism vocabulary — no "layer," no "grinder," no "reclaim" — and no advice. The engine reports *what happened to the model's world*; the per-scheme budget table (§14.2) is the diagnostic surface, and the model — which can see what changed in its repo, its reads, its turn — diagnoses the cause the engine can't attribute. {§14.4-event-model-terms} Per the gamification policy (§15.1), the *strike* the overflow triggers stays engine-internal; the model sees the hidden entries, never the accounting.

**Rationale.** The model owns curation (§14.2); the grinder is the exceptional backstop. It only *hides* — reversibly — the prior turn's render; nothing is deleted, so the model can OPEN it back and log history stays intact. Rummy's §1316 spec described clearing log *bodies*, but its code instead hid the prior turn whole — because body-clearing is destructive (it deletes the read result) and bespoke. The code was the lesson; plurnk follows it.

**Migration path.** None on mechanism. Speculative or non-overflow trimming is a different feature, deliberately excluded — the grinder fires only in response to actual overflow.

### §14.5 The environment delta: what changed since the model last looked

**Question.** The manifest (§15) is a live directory of what *exists*, re-derived each turn — but it carries *state*, not *events*. When a session entry changes out-of-band between turns — an exec stream grows, a sibling run edits a shared entry, a tracked file diverges on disk (§14.3) — the model's prior READ is now stale, and the manifest's new line count is a fact it must *diff against its own memory* to notice. The manifest also cannot say *who* changed it; with more than one actor in a session, provenance is load-bearing. What surfaces change — losslessly, attributably, without curating?

**Decision — a per-run delta of plurnk-authored EDITs.** When a session entry changes out-of-band, the engine records it the way the model records its *own* edits: a `log_entries` row, op=`EDIT`, `origin=plurnk`, carrying the new `source` attribution (the cause). The body is exactly an EDIT's body — **the edited area as it looks now, line-numbered, with a couple lines of context** (the result-rendering all EDITs share, §14.6). The set is **exhaustive and unranked** — every change, no relevance order — but **not content-free**: showing the edited region of a change that *happened* is a faithful record, not the index regrowing. The engine may inform (the §14.3 EMI divergence is the precedent), never rank or select what the model retains; the one line it must never cross is *ranking*. Volume is the model's to manage by FOLD (and the grinder's under budget), not the engine's to manage by gutting the payload.

**Form — a log entry, `origin=plurnk`, the change translated to DSL.** A delta is a `log_entries` row: an **`EDIT`** ("an EDIT happened to X"), `origin=plurnk`, carrying the new **`source`** column — the cause. A log entry, not a transient frame section, because a run's timeline must be **self-contained** (a forked run carries everything it observed). `source` renders as `run="<id>"` / `run="file"` in the meta line, **omitted when the cause is the owning run itself**. It is a third attribution axis, distinct from `run_id` (whose log owns the row) and `origin` (the actor *type*).

**Passive — computed at build, never forces a turn.** A delta materializes only while a packet is being assembled, so a change has nowhere to land until something else has already started a turn — it cannot wake an idle model. "Inform, never override," as mechanism. Urgency that genuinely needs the model routes through the *voice* door (an inject), never the environment door promoting itself to a turn.

**Coalesce per `(entry, source)`.** Net the magnitude, keep the cause: three edits to one entry by one run collapse to a single `+N`; the same entry touched by a run *and* the fs stays two deltas. Provenance is the delta's reason to exist, so it is the one thing coalescing never erases.

**Detection — announced vs ambient.** A run *knows* when it writes, so run-caused changes are **broadcast** (the existing `stream/event`, §13.6 — already session-scoped and carrying its `runId`) and **queued** per sibling run, drained into deltas at that run's next turn. Nothing announces an external disk edit, so ambient fs changes are **scooped at pre-turn** by the §14.3 EMI scan. Attribution falls out of detection: the broadcast carries the run; the scan attributes to the scheme.

**Rationale.** "The model knows its world moved" becomes a property of *reading reality at build*, not of *remembering to emit* — 100% coverage by construction. The engine records each change faithfully — as the EDIT it was, showing its result — and hands the model the wheel; it never ranks, selects, or folds on the model's behalf. The model FOLDs what it doesn't need; the grinder folds under budget.

**Migration path.** Additive. The `source` column defaults null — existing rows and the current render are unaffected; materialization and the broadcast/EMI detection layer on without touching the op surface.

### §14.6 EDIT log rows render their result, not their input

**Question.** An EDIT's log row exists so the model has a record of what it did. Re-emitting the model's *input* statement (the tx heredoc) records the *intent* but not the *outcome* — the model still has to READ the entry back to confirm "did it land, what does it look like now." And a system delta-EDIT (§14.5) has no input statement at all. What should an EDIT row's body be?

**Decision — the edited area as it looks now.** An EDIT row renders the **resulting span**: the edited region of the entry *after* the write, line-numbered, with a couple of lines of context above and below. The model sees post-edit state inline — no confirming READ — and the same rendering serves the model's own EDITs and the system delta-EDITs (§14.5) identically. The meta line still carries op + target, so "I EDITed X" stays legible; the body says "and here's X now."

**Scope.** The span is computed at edit time — the write range and the result are both known then — and stored on the EDIT's `rx`; the render reads it. A large span is bounded like any rendered slice, and FOLD collapses it to the coordinate when the model doesn't need it.

**Migration path.** Changes what EDIT rows *show* (input → output); the op surface and EDIT's behaviour are unchanged. Tests asserting the input-heredoc render move to the resulting-span render.

### §14.7 Dual-YOLO: server- and client-side auto-accept

**Question.** A side-effecting op proposes (§6.8) — dispatch pauses at 202 awaiting a client accept/reject (§0.5, §13.5). But two unrelated needs want to skip the human gate: a service running *headless* (a benchmark, a CI job, a fixture — there may be no client at all), and a *human* who wants "stop asking me" ergonomics in an interactive session. One flag, or two mechanisms?

**Decision — two distinct, complementary mechanisms.** Auto-accept lives at two layers that never substitute for each other:

- **Server-side YOLO** — a per-loop flag, `loops.flags.yolo=true`, set via `loop.run({flags:{yolo:true}})`. The engine auto-resolves the proposal **in-process** — the in-tree `yolo` listener reads the pending proposal and accepts it without any `loop.resolve` ever crossing the wire. No client need be connected. {§14.7-server-yolo-auto-accept} Its uses are non-interactive: benchmarks, CI runs, internal automation, test fixtures. Client apps deliberately do **not** expose it — it is not end-user ergonomics.
- **Client-side YOLO** — the *client's* own setting (`--yolo` / `PLURNK_YOLO`). The daemon emits the `loop/proposal` notification exactly as always; the client immediately answers `loop.resolve({decision:"accept"})`. The wire roundtrip still happens and the daemon stays **unaware** the acceptance was automatic — indistinguishable from a fast human. Its use is the interactive "stop bothering me" session.

**The notification carries the flag.** `loop/proposal` carries `flags` (§13.6), `yolo` among them, so a client attached to a *server*-YOLO loop can suppress its review UI — those proposals resolve in-process before any human could react, and rendering a doomed review prompt is noise. {§14.7-proposal-carries-flags}

**Why two.** They answer different questions. Server-side asks *"is a human in the loop at all?"* — and when the answer is no, dispatch must not block on a `loop.resolve` that will never come. Client-side asks *"does this human want to review each one?"* — a presentation choice that leaves the protocol untouched. Collapsing them would either force a client onto every headless run or leak an interactive preference into the engine's dispatch path. They are orthogonal by construction: the engine gate and the human gate, each bypassable on its own terms.

**Migration path.** Built. `loops.flags.yolo` persists and the `yolo` listener (`src/server/yolo.ts`) auto-resolves; `loop/proposal` already carries `flags`. Client-side YOLO is wholly the client's (`@plurnk/plurnk`) concern — the service offers nothing to build for it beyond the `loop.resolve` RPC it already has.

---

## §15 Packet shape

Canonical shape defined by `@plurnk/plurnk-grammar` (`schema/Packet.json`). Engine assembles in `Engine.#buildRequestPacket`; no plugin augmentation (§14.1). This section is plurnk-service's responsibilities under that contract.

```ts
type Packet = {
    tokens: number;
    system: {
        tokens: number;
        system_definition: string;
        persona: string;
        index: PacketEntry[];               // visible entries (§4 / §5)
        log: PacketLogRow[];                // chronological action-entries (§7)
    };
    user: {
        tokens: number;
        prompt: string;
        telemetry: { budget: string; errors: object[] };   // §15.1
        system_requirements: string;                        // §15.2
    };
    assistant: { tokens: number; content: string; ops: PlurnkStatement[]; reasoning: string | null };
    assistantRaw: unknown;
};
```

**Prompt as a first-class entry.** Each loop's prompt is written on loop start as a plurnk-origin `EDIT` against `plurnk://prompt/<loop_id>` (indexable, body channel, text/markdown). At render time the current loop's prompt body materializes into `packet.user.prompt`; the entry itself stays READ/FOLD-able like any other.

**The entry catalog.** `plurnk://manifest.json` is a real session entry the model READs to discover what's available — rewritten every turn as a live view of the full entry set. Built in the schemes layer (`_entry-manifest`) and materialized like any entry (the engine only orchestrates the per-turn write — the same pattern as git membership), so it's READable and queryable. Body is `application/json`: a flat, **complete, unranked** array — one item per entry across all schemes, every entry listed in no relevance order, each `{ path, channels: { <name>: { mimetype, tokens, lines } } }`. The model ranks and filters the catalog itself by querying it (task-aware); the catalog never ranks for it — the instant it did, it would be an index again. `tokens` is the provider's write-time count (budget depth), `lines` the content extent from `Mimetypes.process().totalLines`. The engine counts neither. It does not list itself. {§15-manifest-catalog}

### §15.1 user.telemetry — model-facing runtime telemetry

Slot for telemetry the model MUST react to immediately. Rendered at the bottom of the user section. Errors are transient — appear on the turn AFTER the failure, clear once seen. `packet.system.log[]` is the durable audit; `telemetry.errors[]` is the **alert**.

**Grammar contract:**

- `budget: string` — text/markdown. Empty when nothing to surface.
- `errors: object[]` — shape open at v0.

**Plurnk-service rendering:**

- `budget` per §14.2: per-scheme breakdown table with `tokenCeiling`/`tokenUsage`/`tokensFree`.
- `errors[]` from previous turn's dispatch. Required: `kind` discriminator. Additional kind-specific fields are flat on the element — NO nested `detail`. Canonical-JSON serialization sorts keys for prefix-cache friendliness.
- Wire: one `* {canonical-JSON}` line per error under `# Plurnk System Errors`, push order. Buffer drains on read. {§15.1-drain-on-read}
- **No prose `message` field.** Errors carry structured facts. The `kind` is the alert; the named fields are the data. Guidance, advice, hints, and exhortation MUST NOT appear in telemetry. Letting the model infer what to do from facts (and the log) beats handing it instructions it will second-guess.
- **Gamification policy (rummy precedent, plugins/error/error.js).** The model sees errors that **happened** — its actions failed, its emission didn't parse, its ops were truncated. The model does NOT see the engine's accounting *about* errors: strike streaks, cycle detection, sudden-death thresholds, no-ops bookkeeping. Surfacing internal state creates a gamification surface where the model optimizes for engine metrics (manufacturing a clean turn to reset the strike counter, e.g.) instead of the task. Engine bookkeeping drives abandonment silently; the model just sees its actual failures.

**Kinds emitted by plurnk-service:**

| `kind` | Source | Required fields |
|---|---|---|
| `parse_error` | Grammar parser failed mid-statement | `source: "grammar"`, `kind`, `message`, `position` (content-offset), `snippet` (model's offending line, N:\t-prefixed), `parserSource` (`lexer`/`parser`/`visitor`) |
| `action_failure` | Log entry with `status_rx ≥ 400` from previous turn | `kind`, `coordinate` (`<L>/<T>/<S>`), `op`, `status`, `target` (URI or null). May carry scheme-emitted `error` (a terse fact, not guidance). |
| `max_commands_exceeded` | Single emission exceeded `PLURNK_MAX_COMMANDS` cap; overflow ops dropped without dispatch | `source: "engine:rail"`, `kind`, `emitted`, `dropped` |
| `budget_overflow` | Assembled packet exceeded the budget ceiling; entries moved out of the window to fit | `source: "engine:rail"`, `kind`, `hidden` (per-scheme `[{scheme, count}]` — entries removed from the window) |

Strike accounting, cycle detection, sudden-death thresholds, and no-ops bookkeeping are all engine-internal — they drive abandonment silently per the gamification policy above. Action-bound failures (handler returned 4xx/5xx or threw) mirror as `action_failure` kind on the next packet. Full detail queryable via `log://`. {§15.1-no-error-scheme}

**No `error://` scheme.** Actionless failures route to telemetry, not a queryable scheme namespace.

**Client surface: `telemetry/event` notification.** Every event the engine pushes to the loop's telemetry buffer also broadcasts live via the `telemetry/event` WS notification. Same envelope on both sides — `{ source, kind, message?, position?, …kind-specific }` per the grammar's `TelemetryEvent` schema. The model sees the event on the NEXT packet's `telemetry.errors[]` (drains on read); the client sees it the moment it lands. Client uses cases: render parse errors in a debug panel (the `snippet` field is content the model emitted), surface strike/sudden_death as "loop is degrading" toasts, log everything to a session timeline. Scoped to the loop's session. {§15.1-telemetry-event-notify}

**Content-offset snippet rendering.** When telemetry carries `position: { type: "content-offset", line, column }`, plurnk-service extracts a ±N-line slice from the model's own prior `assistant.content` and renders it as an `N:\t`-prefixed heredoc under an `error://<line>` fence, immediately following the event meta line. Without the snippet, the model gets "invalid xpath at 1:0" with no way to trace what it wrote at 1:0 — and tends to regenerate the same broken emission. With it, recovery is direct (canonical case: the edit-todo demo where a READ body starting with `//` got xpath-dispatched). The snippet field is stripped from the meta JSON so it appears once, in the body block. {§15.1-content-offset-snippet}

### §15.2 user.system_requirements — static per-turn rules

Rendered at the END of the user packet under `# Plurnk System Requirements` {§15.2-requirements-render-last} — closest to the assistant turn so the contract the model has to honor is the most recent text it sees. The header is omitted entirely when the requirements string is empty. {§15.2-requirements-omitted-when-empty} Contains rules the grammar block doesn't cover (canonical example: "Conclude the loop with `<<SEND[200]:answer:SEND`").

**Sourcing:** caller supplies the string via `runLoop({ requirements })` / `runTurn({ requirements })`. Plurnk-service exposes `PATHS.defaultRequirements` (resolves `PLURNK_REQUIREMENTS` env → in-package `requirements.md`). No DB cascade — same string every turn.

**Rationale:** the user's prompt is natural language ("Reply with just the number") and routinely conflicts with the grammar's operational contract. Without an explicit requirement block, the model obeys the prompt literally and never reaches for SEND. Requirements are the contract that wins those conflicts.

### §15.3 Persona — the per-entity cascade

The persona — the character the model wears, rendered into `packet.system` — resolves per turn at packet assembly by a cascade over three nullable columns plus a file default. **`loops.persona` > `runs.persona` > `sessions.persona` > the `PLURNK_PERSONA` file** (`engine_resolve_persona` is `COALESCE(loop, run, session)`, falling to `PATHS.defaultPersona` when all three are null); the most specific level set wins. {§15.3-cascade-precedence}

**Null falls through; empty string overrides.** A null at a level defers to the next; an explicit `""` is a non-null value that wins the COALESCE and **suppresses** the cascade — the model gets no persona section. Setting `""` is how a client deliberately strips an inherited persona for one loop. {§15.3-null-falls-through} {§15.3-empty-suppresses}

**Set by RPC, evaluated at build.** `session.create` / `session.set_persona` set the session level, `session.attach` sets a *new* run's level, `loop.run({persona})` sets the loop level (highest precedence). The cascade resolves fresh each turn — not frozen at loop start — so a runtime `session.set_persona` lands on the next turn.

---

## §16 Matcher and `<L>` slicing

Body matchers and `<L>` both dispatch on entry mimetype. Body matcher: leading-char classification (`//` xpath, `/` regex, `$` jsonpath, otherwise glob). `<L>`: line-navigable → by line, structured → by item.

### §16.1 Matcher dispatch (delegated to `Mimetypes.query`)

`matchAgainstContent` (exported from `@plurnk/plurnk-schemes`) is an adapter over `Mimetypes.query(input, expression)`. Framework parses leading prefix, resolves per-mimetype handler, returns `QueryMatch[]`. Adapter maps typed errors:

| Framework error | HTTP status |
|---|---|
| `UnsupportedDialectError` | 415 |
| `InvalidExpressionError` | 400 |
| `QueryParseFailureError` | 203 (soft fallback: raw content as `text/markdown` with `reason`) |
| Empty match array | 204 |
| Match array | 200 |

203 is HTTP-creative ("Non-Authoritative Information"). On parse failure, returns raw bytes as text primitive with `reason` so the model can fall back to regex/visual parsing or fix source. {§16.1-203-soft-fallback}

Glob anchoring (`TODO*` starts-with, `*TODO*` contains, `*.log` ends-with, `[Tt]odo*` char class) lives in framework's `BaseHandler`.

### §16.2 Matcher result shape (uniform across dialects)

Body: one match per line as `<line>:\t<value>` — the same `N:\t` form READ emits, so `<L>` can page the result set. Empty → 204. Mimetype = `text/markdown` regardless of source dialect.

- `<line>` — 1-indexed source line, shifted back to source coordinates when matching inside an `<L>` slice.
- `<value>` — the extracted match, rendered bare when it is a single-line string, else JSON-encoded (preserving the one-match-per-line invariant). Polymorphic per dialect:
  - **bare regex** → string (full match)
  - **anon captures** → array `[c1, c2, …]`
  - **named captures** → object `{name: v, …}`. Mixed anon+named uses positional keys `"1"`, `"2"` alongside names.
  - **glob** → string (matching source line)
  - **jsonpath** → JSON value at the path
  - **xpath text/attr** → string
  - **xpath node** → serialized XML

| Dialect | Extracts | Natural use |
|---|---|---|
| regex `/pat/` | substring (or captures) | extract the value after X: |
| glob `pat` | whole matching lines | show lines containing TODO |
| jsonpath `$.path` | JSON values (parsed value for JSON-shaped mimetypes; bare-leaves outline for markdown/HTML/source) | get the host field / jump to Installation |
| xpath `//sel` | XML nodes/text/attrs (text/html only) | get the h1 contents |

### §16.3 `<L>` semantics by source mimetype

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

**Killer composition.** `<<READ(log://N/M/K)<P>::READ` picks the P-th match from a prior matcher result — matcher rx is `application/json`, structural `<L>` selects the P-th element. {§16.3-compose-pattern}

### §16.4 Structural EDIT on JSON

When effective mimetype is `application/json`, EDIT dispatches through `applyJsonItemEdit`. {§16.4-structural-json-edit} Body shape rule (parse-then-discriminate):

- Body parses as JSON array → items to splice
- Body parses as non-array JSON → single item to splice
- Empty body → delete the selection
- Body fails JSON parse → 400 (path-extension declares intent; honor strictly) {§16.4-json-parse-fail-400}

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

### §16.5 Path-extension declares mimetype

`resolveEntryMimetype` (exported from `@plurnk/plurnk-schemes`): pathname extension → `Mimetypes.detect({ ext })` (with `text/plain` normalized to `text/markdown` per the text-primitive rule §16.7); falls back to scheme manifest channel default when no extension.

- `known://users.json` → `application/json` (extension wins)
- `known://notes.md` → `text/markdown` (extension; matches default)
- `known://config.yaml` → `application/yaml`
- `known://users` (no suffix) → `text/markdown` (Known manifest default)

Same rule applies across Known, Unknown, Skill, Plurnk, File. Effective mimetype is stored in `entry_channels.mimetype` on write and drives `<L>` and matcher dispatch on read. {§16.5-extension-mimetype}

### §16.6 Render rule (mimetype-driven)

`packet-wire` log render branches on `isLineNavigableMimetype`:

- **Line-navigable** (text/markdown, text/plain, csv, source code, yaml, toml) → `N:\t` line-number prefix per line {§16.6-line-navigable-prefix}
- **Tree-navigable** (application/json, application/xml, text/html, +json/+xml suffixes) → verbatim body (no `N:\t` — outer line numbers would collide with structural navigation like jsonpath/xpath) {§16.6-tree-navigable-verbatim}

The `N:\t` prefix is presentation/reference per plurnk.md ("not part of the source"); stripped before any matcher operation on the log entry.

### §16.7 Mimetype primitive: text/markdown

Auto-derived text mimetypes anywhere in plurnk-service normalize to `text/markdown`:

- `<L>` slice on line-navigable source → `text/markdown` {§16.7-text-markdown-normalize}
- File scheme extension fallback → `text/markdown`
- `Mimetypes.detect()` returning `text/plain` → normalized via `normalizeAutoTextMimetype`

`text/plain` survives only where a scheme explicitly declares it (exec stdout/stderr — subprocess byte-streams aren't markdown). The model never auto-encounters `text/plain` from defaults.

### §16.8 Op-level invariants and resolved ambiguities

Carried from the contract walk; durable.

- **Dialect/mimetype mismatch** → 415 (xpath on text/plain → 415; jsonpath on JSON-shapeless mimetypes → 204 because outline is empty, not 415).
- **Binary entries** → 415 across the board for READ/EDIT/OPEN/FOLD.
- **EDIT `<L>` on non-existent entry** → body becomes content; `<L>` is positional-only on existing content.
- **COPY `<L>`** → source range, symmetric with READ `<L>`.
- **READ rx** prefixes each line with `N:\t` per §16.6. `sliceLinesRaw` (used by COPY) returns the lines without prefix.
- **FIND body matcher** applies to entry content (all dialects), per-candidate via `Matcher.matchAgainstContent` → `Mimetypes.query` (status 200 = content hit → entry selected). Scope + tags select candidates in SQL; the path-glob is the (target).
- **OPEN/FOLD** operate on the **log** (`log://`), not entries (§6.3) — FOLD collapses a log row to its path, OPEN restores its body. Aimed at an entry scheme they return 501.
- **SEND[410]** deletes as a side-effect (not the model idiom; §6.5): with `#fragment`, that channel only; without, the whole entry. **SEND[499]** is owned by the streaming scheme that holds the subscription.
- **File scheme** reads disk content with mimetype detected via `Mimetypes.detect({ path })` (plumbed through `PlurnkSchemeContext.mimetypes`). Binary mimetypes → 415 on READ and EDIT.

### §16.9 Directed-SEND status code policy

Status codes outside 410/499 on directed SEND return 501 from entry schemes. plurnk.md doesn't prescribe semantics for arbitrary HTTP status codes on directed sends; each scheme decides. 501 is the default; new interpretations land as concrete use cases arise.
