### Plurnk Service — Project Grounding, Policy, and Rules

plurnk-service is the MOM of the ecosystem: the primary service daemon — the engine, the DB, the packet, the op surface. General ecosystem ground, policy, and rules live in `../AGENTS.md` (the metaproject doc) and bind here too; this file holds only what is **specific to plurnk-service**.

**This file is read verbatim and foisted into the model's packet** as privileged policy (`<projectRoot>/AGENTS.md`, `readProjectPolicy` in `src/core/packet-inject.ts` — no carve-out, the whole file). It is simultaneously the operating instructions for whichever agent (human-directed or plurnk-driven) is doing dev work on this repo. Both audiences need the same thing: durable policy, teaching-grade and lean — never a personal worksheet, a dated TODO, or scratch. GitHub issues (labeled by lane) are the live backlog; this file states what does not change week to week.

**Stance: plurnk is an agent OS — the model is the CPU, plurnk is the kernel.** Before treating any problem as "agent behavior," route it to the OS subsystem that owns it and apply that subsystem's solved theory (paging, fork-join, VFS, scheduling, signals) rather than re-deriving it at the prompt. The offload — moving capability from the weak model into the deterministic substrate — *is* the recovery-rails moat. The Rosetta stone (component → OS analogue → theory): **`ARCHITECTURE.md`**.

#### Service Conventions

- **The DB is the application.** State and state transitions live in SQL (triggers, generated columns, views, FTS5, JSON1, CHECK constraints). TS is the thin glue: parameterized statements + named views + transport (network, IO, tokenization, plugin dispatch). When SQL becomes onerous, convoluted, or hacky for a specific case, retreat to TS for that case.
- **The service owns storage + render; grammar owns the protocol.** The persistence shapes — `Entry`/`Workspace`/`Worker`/`Loop`/`Turn`/`LogEntry`/`Packet` — are the **service's own** (our migrations + the `schema_alignment` test), never grammar's contract.
- **The model curates its *log*, not the manifest — deliver, don't decide.** The model READs entries into its `log://`; *that selection is the curation*. The catalog is the complete, unranked directory the engine **delivers** — never ranked, never auto-injected. Anything that "helpfully" anticipates what the model wants is the ranking growing back. {§actor-boundary-catalog-preview}, §actor-boundary.
- **"index" is plumbing, never a concept.** The term is too overloaded (SQLite indexes, FTS, 1-indexed offsets, the symbol graph, JS barrels) to carry conceptual meaning. The model-facing entry directory is the **catalog**; per-row OPEN/FOLD render state is **`expanded`**. Reserve "index" for arcane technical plumbing where it's unambiguous; never name a concept, column, table, or doc term "index".
- **Model context vs database context — NEVER conflate.** Two orthogonal axes, two different relief levers; always name which one.
  - **Model context** = the per-turn PACKET / token window — what the model *sees* this turn, bounded by `tokensFree`. Pressure: the packet won't fit. Lever: **FOLD** (collapse a render — the entry STAYS in the db) + the budget grinder (→ 413 packet-overflow terminal).
  - **Database context** = PERSISTENT sqlite storage — what's on disk, bounded by disk / `PLURNK_SQLITE_MAX_PAGE_COUNT`. Pressure: the db is filling. Lever: **KILL** (DELETE the entry from the db).
  - FOLD frees model-context TOKENS (entry persists); KILL frees database STORAGE (entry is gone). Never let one lever or one limit stand in for the other.
- **Visibility has three grantors; plurnk grants none of its own.** A file is visible to the model only when admitted by (1) the client's explicit grant, (2) git's inclusion semantics (`ls-files` ∪ untracked-not-ignored − ignored), or (3) the AGENTS.md policy knob. Git-absent fails **closed** (zero members → every READ 404). A file physically inside the root that no grantor admits DOES NOT EXIST for the model — this is the sandbox narrative's center: every visible byte traces to the client's constraint table or the operator's own gitignore, never to a plurnk decision. `.env`-protection is this law's theorem: gitignored → never a member → never readable, never clobberable. {§fs-visibility-grantors}
- **Client activity is DSL ops in its own worker; the model's worker is its conversation.** The packet renders the *model's* worker, so a client's own worker is **structurally invisible** — invisibility by *worker*, not a render-filter. {§actor-boundary-isolation}
- **Speak in DSL, not plumbing.** `op.*` RPCs construct DSL statements and dispatch through the same engine path the model uses. Any client (TUI, CLI, nvim, Telegram) does exactly what the model can — no more, no less. {§methods-op-mirror}
- **Operational hygiene on what the model sees.** The model's view (packet.system/user) is its world — leaking infrastructure (YOLO outcomes, resolution mechanisms, security metadata) into it is a bug. It sees *what happened* (status, log, body), never *how it was administratively resolved*. {§telemetry-no-error-scheme}
- **Gamification policy: the model sees errors that happened, never the engine's bookkeeping about them.** `parse_error`/`action_failure`/`max_commands_exceeded` surface; strike counts, cycle/sudden-death thresholds, no-ops accounting stay internal. The test: did something happen *to the model's emission*, or is it the engine's reasoning *about* it? The latter never surfaces.
- **Contracts carry `{§}` anchors; the guard enforces alignment.** Every SPEC promise ends in a `{§<id>}` tag cited by a test named `[§<id>] …`; `test/intg/spec-anchors.test.ts` fails on either an orphan ref or an uncovered promise. When a promise is unbuilt, mark it deferred with a deliberately-red test, never a green stub.
- **Read the DB via the digest, not via raw SQL.** `bin/digest.ts` writes curated artifacts (`digest.md`, `digest.json`, `reasoning.md`). Direct SQL spelunking encourages half-engaged review and hallucinated patterns.
- **Full repo management authorized for plurnk-service.** Agent commits, branches, pushes, opens PRs, AND merges PRs autonomously. Agent confirms before destructive ops that can't be undone cleanly: force-push to main, branch deletes that destroy unmerged work, rebases that rewrite shared history, `git reset --hard` on tracked changes.
- **Delegation over inheritance.** Shared scheme logic is a static utility class the schemes *call* (`_entry-*`), never a base class they inherit. Extract only when commonality is proven across ≥3 deep instances.
- **Triggers for cascades, TS for branching.** SQL triggers do simple cascades/denormalization; conditional status logic (terminal codes, loop-detection) is explicit engine TS. CHECK enforces; the trigger needn't compute.
- **Extension points are a promise.** A scheme handler with zero subscribers is still an extension point — don't delete it as unused.
- **Every DB JSON blob carries a declared schema.** `entry.attributes` is the one deliberate dumpster, reviewed for graduation.

#### Engineering Discipline

Hard-won, generalizable — the misalignments that cost real time when skipped. Applies to any agent (human-directed or plurnk-driven) doing dev work on this repo.

- **Audit the rendered packet before blaming the model.** When a run struggles, read the actual artifacts the model received (`bin/digest.ts` output — `digest.md`, `packetNNN.user.md`, `reasoning.md`, `requiem.md`) line by line before any "the model is weak/non-deterministic" framing. Routing the blame to another lane (grammar, providers) without reading the packet first is the *same deflection*, just wearing a process costume — verify firsthand, don't hand off a guess. The recurring true cause: a tooling bug (a canonicalization gap, a render defect, a budget table advertising a lever the law refuses) that a struggling model was reacting to rationally.
- **Core never injects teaching.** Packets carry DATA and terse law-facts (an error naming a key, a channel-miss naming its declared universe) — never explanatory prose about format or semantics. Teaching the model how to read its own packet is grammar's surface (`plurnk.md`), not core's. When a model misreads a packet: fix the DATA, or hand the teaching need to grammar — never add prose.
- **Protect core by owning less.** The default answer to a client/module need is "here's the seam," never "I'll build it in core." A core change needs core-justification, never client convenience — see `ARCHITECTURE.md`'s daughter-module discipline. Before building a novel mechanism: is it best-practice? already solved by config? whose plugin owns it?
- **Never revert; fail forward.** Never revert, restore prior state, re-pin a version, or add a fallback to dodge a conflict. Fail hard and fix the root cause forward — don't even offer "hold/revert" as an option.
- **Flakes are stop-everything.** Never dismiss an intermittent failure as noise — it's a race or stochastic bug. Drop everything and drill to root cause.
- **Green proves no-regression, not correctness.** For model-facing changes, reading the rendered packet and reasoning about honesty/recoverability/weighability is the real gate — a green tier alone doesn't certify it. Never cite unverified coverage or report a tier green from a partial/filtered run; run the whole tier, show real totals, surface failures the moment seen.
- **A security regression closes in the same change that opens it.** A fix that opens a destructive/contract/security hole (even as a side effect) must close it before landing — never "defer" on a security-model violation.
- **Code presence is not proof.** A handler method existing does not mean the feature works — prove it through the real dispatch/RPC path across every form (client, model, RPC mirror), never a code-sighting.
- **Tests prove behavior, not intent.** Never mint a `{§}` SPEC promise from a green test without checking the test actually asserts the claimed behavior, not just a nearby symptom.
- **Filter a model's self-audit; don't launder it.** A model auditing deliberate design emits mostly misreadings, not findings — triage adversarially. Before "fixing" any model complaint: (1) is it even true? (2) is it that way for a reason? (3) what does changing it cost? Default verdict is no change.
- **No fake choices, no docs-as-remedy in errors.** A decision offered needs real, defensible forks — never pad with an alternative that can't be argued for. An error or steer message states the fact or the law, never a how-to tutorial; teaching lives in grammar/docs, not the error string.
- **A scheme's op coverage includes engine-minted rows, not just tidy model-op rows.** Test FOLD/KILL/OPEN against `error`/`model`-origin rows too — the untested class (a lowercase engine-authored row) is exactly where a silent 400 or a jumbo spiral hides.
- **The grinder folds only the newest turn boundary — never history.** The log is the model's memory and the model alone curates it (FOLD/KILL); the engine only blocks NEW memories from landing when there's no room. This doctrine's guard test must never be weakened.

#### Toolchain

- **Node ≥ 26.** Native TypeScript (`.ts` files, no compile step in dev). `tsc --noEmit` is the lint pass.
- **ESM only.** `"type": "module"`. `node:` prefix on every built-in. No CommonJS.
- **No biome.** Discipline lives in this file plus code review plus TS's type system.
- **Test runner:** `node --test` with `--experimental-test-coverage`. Native only.
- **Coverage target:** 50% lines / 50% branches / 50% functions. Floor, not ceiling.
- **SQLite:** `@possumtech/sqlrite` (anti-ORM wrapper around `node:sqlite`). All SQL lives in `.sql` files; not a single SQL string exists in `.ts`/`.js`. Schema in `-- INIT: <name>` blocks (idempotent at open); prepared statements in `-- PREP: <name>` blocks (compiled at boot, exposed as `db.<name>.{run,get,all}({...})`); raw EXEC in `-- EXEC: <name>` blocks.
- **Env management:** the assembled `.env.defaults` floor < `~/.plurnk/.env` < `./.env` < shell (SPEC §operator-config-env-defaults: every package ships its own `.env.defaults`; one owner per key, collision = boot crash). No boot-time validators or fallback constants: a read failure means fix `.env.defaults`, not the read site. Feature-flag bools are `=== "1"` exactly, never `=== "true"`.
- **Operator env surface:** `~/.plurnk/.env` is the house surface for projectwide box settings shared across agents (default model SKU etc.) — let it cascade naturally. Agents NEVER create or maintain `.env`/`.env.test` in worktree/private folders — private shadow config drifts and bites. A one-off knob for a single run is a shell override on the command (`PLURNK_MODEL=x npm run test:demo`), never a file. Live/demo model selection is per-operator and categorically off-repo. The cascade tooling itself is settled machinery — read it before ever proposing changes to it.
- **CLI parsing:** `parseArgs` from `node:util`.
- **HTTP:** built-in `fetch`. No axios, no node-fetch.
- **No external mocking lib.** `node:test` mocks for the few places mocks are tolerated (unit only; integration uses the mock provider).

#### Shell & verification hygiene

- **Pipelines launder failure.** A piped command exits with the *last* stage's code — `npm test | tail` reports tail's exit, not npm's. `set -o pipefail`, or don't pipe when pass/fail matters; read the real summary line (`ℹ fail N`), never infer green from a downstream exit.
- **`grep` false-negatives on `§`.** Source and spec files contain `§`; plain `grep` silently returns empty instead of matching. Use `grep -a` or `rg`.
- **Live/demo default model.** `PLURNK_MODEL=gemma` → free local llama-server at `127.0.0.1:11435`. Never a paid model unless explicitly directed — gemma is the affordability floor the architecture is proven against.

#### Test taxonomy

Four tiers (SPEC §test-taxonomy): `unit` / `intg` (mock provider) run in CI; `live` / `demo` are real-provider, env-gated. `live` pins wire-level behavior, `demo` pins holistic outcomes; the mock provider is `intg`-only.

- **No DB mocks, ever** — intg opens a real on-disk SqlRite file (`test/intg/.tmp/db-<uuid>.db`) and runs migrations; `:memory:` makes false-green bubbles and skips the digest path.
- **Specific assertions** — a specific error type/message, never a generic "it errored."
- **Stochastic agentic tests accept the engine's terminal set, not strict 200** — a `live`/`demo` test pinning strict 200 is flaky by construction.
- **"Green" means unit AND intg for any claim** — but don't run full tiers pre-commit; the pre-push drill runs the same coverage parallelized (iterate targeted → commit → push gates). Manual whole-tiers only for release gates or reportable evidence.

#### Troubleshooting a demo/live failure — the digest workflow

When a `demo`/`live` storyline fails, do NOT re-read the raw test log or spelunk SQL. The forensic loop:

0. **Confirm the worker was unconstrained (GBNF debug mode) before trusting any emission.** A `live`/`demo` digest is only diagnostic when the model generated *free*: `PLURNK_GBNF_DEBUG=1` validates the grammar locally and does **not** transport it → the request runs unconstrained. If `PLURNK_PROVIDERS_GBNF` is applied instead, the emission is the *grammar's* constrained output, not the model's intent — and a buggy GBNF can manufacture the symptom.
1. **Find the worker's DB.** Every `openMigrated()` keeps its DB and logs `[openMigrated] db kept: test/intg/.tmp/db-<uuid>.db` on close, printed just before the `✖ <storyline>` result. The `test:intg`/`demo`/`live` runners pre-clean `.tmp` (`test:clean-tmp`), so it only ever holds the current worker's DBs.
2. **Digest it.** `node bin/digest.ts test/intg/.tmp/db-<uuid>.db --requiem` → writes `test/digest/digest.md` (per-turn waterfall: each op as `← OP[status] scheme://pathname`), `packetNNN.system.md` (byte-exact what the model saw), `reasoning.md`, `requiem.md` (the model's own exit interview), and `digest.json`. Always pass `--requiem`. Forensic specimens preserved for later review go to `~/repo/plurnk/benchmarks/run<N>/` (`plurnk.db` + `digest/`), reported by number.
3. **Read `digest.md` first.** The waterfall usually names the failure in one line. Open `packetNNN.system.md`/`.user.md` only when the exact bytes matter.
4. `npm run test:clean-tmp` purges `.tmp/` when kept DBs accumulate.

The diagnosis is always "what is the packet missing / advertising / mis-teaching?" — the digest *shows* it. Reaching for "the model is weak" before reading the waterfall is the deflection § Engineering Discipline warns against.

#### Source layout

`src/{core,server,schemes,content,digest}` + `bin/` (CLI + digest), `migrations/` (numbered idempotent SQL), `test/{intg,demo,live}/`, `scriptify/` (one-offs, never build steps). In-tree schemes: `file`, `worker`, `log`, `exec`, `prompt`, `skill`.

- **One class per file** (`export default class FileName {}`); SQL in co-located `.sql` files — no `db/` subdir, no inline SQL in `.ts`/`.js`.
- **Mimetype handlers + providers + executors are sibling `@plurnk/*` packages**, boot-discovered (SPEC §plugin-discovery); the in-tree set stays minimal.
- **Sysprompt** comes from `@plurnk/plurnk-grammar/plurnk.md` — single source of truth upstream.

#### Git workflow

- **Conventional commits.** Type prefix (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, etc.), then `#<issue>` reference(s), then a short lowercase description — no subject sentence-case/start-case (commitlint rejects it).
- **Author, not co-author.** `git commit --author="Claude <noreply@anthropic.com>"` (committer stays the git-config user = agent wrote, user approved). One-liner subject ≤80 chars; no body, no trailers (`Co-Authored-By`/`Claude-Session` rejected by the commit-msg hook). Context rides references (`#N`, a `git-bug` hash, a `§spec` tag), never a trailer.
- **Issues.** Prefer real issue numbers. A `fix:`/`feat:` subject carrying `#N` auto-closes #N on merge to main — for a commit that references but does not resolve, use `refs #N`; reopen if an auto-close was wrong.
- **Branches.** `main`, or `lane/<lane>` for the family agent's dedicated worktree, or `type/kebab-slug` for feature work. Sisters push straight to main from their lane branch after the pre-push drill (whole-monorepo test) passes.
- **AGENTS.md is tracked and committed** — durable shared project policy, not local scratch. Keep it lean; GitHub issues carry the backlog.
- **PRs and merges.** Agent opens PRs AND merges them autonomously per user authorization. Agent confirms before destructive ops that can't be undone cleanly: force-push to main, branch deletes that destroy unmerged work, rebases that rewrite shared history, `git reset --hard` on tracked changes.
- **Commit-msg hook.** A commit-msg hook enforces conventional commits + issue refs + subject case. When commits get rejected, fix the message — never bypass with `--no-verify`.

#### Logging

- Runtime logging is DB rows in `log://` per the grammar's persistence schema.
- Stdout is for boot-time banners and crash reports only. No `console.log` in the hot path.
- Forensics via `bin/digest.ts`; standing rule says read the digest, not raw SQL.

---

## Operating Recipes (execute these; don't re-derive them)

### R1 — Bump-adopt (any upstream release)
1. Survey: for each family package, compare installed vs `npm view @plurnk/<p> version`.
2. Read the delta: the release's issue/comment trail; for grammar, `diff` the shipped `plurnk.md`/gbnf.
3. `npm i` the exact new versions. Peer lag (exact pins mismatching) is the alarm working: install the family's full aligned wave, or if upstream shipped half a wave, file the issue and STOP — never `--legacy-peer-deps` into a pub.
4. Gates: `npm run test:lint` → `test:unit` → `test:intg` (whole tiers, real totals).
5. `npm ls --all | grep -iE "invalid|missing"` — zero non-optional hits.
6. If the bump touches teaching/model behavior: one live sanity (R4, single chunk) before calling it adopted.

### R2 — Release (the four gates, then the OTP handoff)
1. Gates: full drill (lint/unit/intg) · `npm ls` clean graph · `npm run test:installation` PASS · `npm publish --dry-run` clean.
2. `npm version <x.y.z> --no-git-tag-version`; commit; push.
3. Hand the user: `! npm publish --otp=<code>`. NEVER publish yourself.
4. After they confirm: `npm view @plurnk/plurnk-service version` (expect the new tip), then post bench/daughter notes on the affected issues.
5. Schema changed? Say so loudly in the release commit AND the handoff: dbs recreate (`rm ~/.plurnk/plurnk.db* && plurnk-service migrate`).

### R3 — Forensic capture (a failing/interesting model worker)
1. Drive the exact scenario via a probe script (liveWorkspace/liveLoop from `test/_live-harness.ts`), NOT by re-running the test blind.
2. Capture the db BEFORE cleanup, verified BY SESSION NAME (open candidates in `test/intg/.tmp/`, match `workspaces.name`) — never newest-file.
3. Copy db(+wal/shm) to `~/repo/plurnk/benchmarks/run<N>/plurnk.db` (next N).
4. `node bin/digest.ts ~/repo/plurnk/benchmarks/run<N>/plurnk.db --requiem` (writes to `test/digest/` for the owner, or `... run<N>/digest` to keep it with the specimen).
5. Read turn-by-turn: emissions, rx statuses, steers. The three questions in order: what did the model emit · what did the packet show it · what did the engine do.
6. Issues cite the specimen by number.

### R4 — Live/demo sweep (foreground, attended, honest)
1. Preconditions: `pgrep -fc 'node.*--test'` ≈ 0 (nothing foreign on the box), llama-server slot idle (`curl -s :11435/slots`).
2. Chunks, each a foreground Bash call with `--test-concurrency=1`, output `tee`'d to a scratch file (failure detail must survive).
3. NEVER `run_in_background` for live/demo — a background sweep gets reaped/contended and a liveness check misjudges both ways. Foreground only, watched.
4. Report REAL totals per tier. A red reruns ISOLATED ×2-3: consistent → R3 capture + root-cause; rerun-green → check for box contention before any other theory.
5. Known accepted reds get filed as issues, not silently re-accepted each sweep.

### R5 — Issue triage
1. Mode check first: is this an explicit instruction (execute as given) or a proposal imposing a HOW that is ours to own (evaluate critically)? When unsure, ask — one cheap question.
2. Demand/locate the specimen (benchmarks/run<N>) before theorizing; file-format findings from model audits are mostly misreadings — verify against the code before accepting.
3. Route by zone (§ Zones). Cross-repo? Declare it out of scope, name the owning repo, file the instructing issue there (mom→daughter is directive).
4. Anything matching the escalation fence goes to § Parked for Depth with full written context — never attempted.

### R6 — New operator knob
1. It lives in `.env.defaults` with a decision-table comment (what it classifies, the shipped default, what changing it means). No code fallback hides a default; feature-flag bools compare `=== "1"`.
2. `PLURNK_SERVICE_*` knobs must satisfy the flag-parity test (declared in `.env.defaults` ⇔ read in src).
3. Ceilings compose tighten-only (env AND workspace); defaults compose REPLACE; per-workspace client knobs ride `workspace.create settings` with validation in `session_create.ts#parseSettings`.

### R7 — New SPEC anchor + guard test
1. The behavior gets a `{§kebab-name}` anchor in SPEC.md stating the ONE-SENTENCE story first, mechanism after.
2. At least one test cites it as `[§kebab-name]` — `spec-anchors.test.ts` enforces the lockstep both ways.
3. If the anchor states a doctrine (a "never"), write the guard test that FAILS when the doctrine is violated (the grinder's history-untouched test is the model).

## Zones (bounded comprehension — load the brief for the zone you're touching)

### Z1 — Loop lifecycle (`Engine.runLoop`/`runTurn`, daemon drain/wake, parks)
Story: a loop is turns until a terminal; waiting is a mode of continuing.
Invariants: a park (`[102]<T>`/`<-1>`, internally loops.status=202) always resumes — by arrival, deadline, or voice; a wake re-queued loop is never broadcast terminal {§worker-lifecycle-wake-requeue-not-terminal}; hold-listed exec streams pause the cycle bounded+fail-open {§exec-hold-until-concluded}.
Tests: Engine.run-loop, Daemon.exec-wake, exec-hold, run-topology. Don'ts: never add a loop-status value without owner schema ruling; never make a park terminal.

### Z2 — Op semantics (`Dispatcher`, the pending set, terminals)
Story: SEND[200] terminates unless the pending set (streams ∪ live children ∪ this turn's retrievals) is non-empty; 499 always terminates; everything else is comms or parks.
Invariants: judged at the terminal's OWN dispatch, post-batch (KILL+200 repairs in one turn) {§send-premature-terminate}; a refusal is 409 on the record, a strike, and a PERSISTED turn demotion — the digest surface never lies; SEND[300] is ask+park, gated by the questions cascade {§send-300-choices}.
Tests: premature-terminate-child, send-300-choices, exec-entry-sink. Don'ts: no new gates without a SPEC anchor; never re-derive grammar rules engine-side (parse shapes are grammar's).

### Z3 — Tokenomics (`PacketBuilder`, the grinder, `TokenGauge`)
Story: the window partitions into reserves + a prompt budget; on overflow the grinder folds the newest turn boundary — NEVER history — then strikes, then 413s.
Invariants: {§grinder-layer1-rollback} is the project's central doctrine (model-curated memory; the engine only refuses room for NEW memories) — its guard test must never be weakened; ONE model-agnostic ruler (`ceil(chars/2)`, no per-model tokenizer cache — the per-tokenizer cache was retired) {§tokenomics-agnostic-ruler}; a model-COMPOSED op body (PLAN/SEND/WORK/FORK/EXEC command) renders preview-bounded — content ops (READ/FIND/EDIT/COPY/MOVE) render full {§arrival-law-authored-bodies}.
Tests: Engine.budget-enforce, token-gauge, context-gauge, budget demo tier, packet-wire. Don'ts: no caps on legitimate retrieved/inspected content, ever; no grinder scope growth into history.

### Z4 — The entry substrate (`_entry-crud/find/manifest/semantic/chunk`)
Story: entries are the one address space; writes stamp (tokens, content_hash, FTS at write); deep channels (symbols/refs/embeddings) derive async via the pump, deep_hash-gated, smallest-first.
Invariants: the pump never blocks a turn {§derivation-off-hot-path}; embeddings consume the handler's readable projection when offered; writeEntry REPLACES tags — callers wanting union read-then-merge.
Tests: semantic, semantic-cold-parity, token-gauge, graph.*. Don'ts: no mimetype handler invocation at write {§mimetype-schemes-do-not-invoke-handlers}; no size caps.

### Z5 — Schemes (in-tree handlers + the exec surface)
Story: each scheme is a manifest + op methods over the entry substrate; exec runtimes are discovered daughters with a per-workspace policy cascade.
Invariants: writableBy gates writes; the capability sheet and docs render only what the workspace can actually use; the entry() sink materializes+tags+narrates via the plurnk worker's ambient rows.
Tests: Exec.effect, execs-workspace-policy, exec-entry-sink, worker-scheme. Don'ts: never edit another repo's scheme package; daughters own their how.

### Z6 — The daemon surface (RPC methods, notifications, workspace settings)
Story: thin JSON-RPC over the engine; workspaces carry client-chosen open-context (settings bag); every log row streams as log/entry.
Invariants: settings validate at workspace.create (tighten-only ceilings; REPLACE defaults; MCP keys never ride the wire); loop.run acks 100 and outcomes ride loop/terminated; questions ([300]) require allowed(env)+requested(workspace).
Tests: Daemon.*, workspace-ceilings, send-300-choices e2e. Don'ts: no method without params docs; no notification without a registered description.

## Parked for Depth (the escalation fence — add to this list; do NOT attempt from it)

Fence classes (park, never attempt, regardless of how tractable it looks): paradigm changes · SPEC-semantics changes · schema migrations · cross-repo contract design · anything reversing a standing ruling · new gates/rails.

Nothing is currently parked here — specific parked items belong on a GitHub issue (labeled, discussed, resolved there), not as standing entries in this policy file. When something genuinely needs to sit for later without an issue home, add it here with full written context; otherwise route it.
