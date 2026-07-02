### Plurnk Service — Project Grounding, Policy, and Rules

plurnk-service is the MOM of the ecosystem: the primary service daemon — the engine, the DB, the packet, the op surface. General ecosystem ground, policy, and rules live in `../AGENTS.md` (the metaproject doc) and bind here too; this file holds only what is **specific to plurnk-service**.

#### Service Conventions

- **The DB is the application.** State and state transitions live in SQL (triggers, generated columns, views, FTS5, JSON1, CHECK constraints). TS is the thin glue: parameterized statements + named views + transport (network, IO, tokenization, plugin dispatch). When SQL becomes onerous, convoluted, or hacky for a specific case, retreat to TS for that case.
- **The service owns storage + render; grammar owns the protocol.** The persistence shapes — `Entry`/`Session`/`Run`/`Loop`/`Turn`/`LogEntry`/`Packet`/`Agent` — were scoped OUT of the grammar contract (grammar 0.65–0.67) and are the **service's own**: our migrations + the `schema_alignment` test, never grammar. This is the "true protocol" scoping (owner) — it dissolved the old packet/entry drift outright.
- **The model curates its *log*, not the manifest — deliver, don't decide.** The model READs entries into its `log://`; *that selection is the curation*. `plurnk://manifest.json` is the complete, unranked directory the engine **delivers** — a kernel-injected "magic" entry, not something dogfooded through ops or repatriated onto a run (it's how the world is shown, not an actor's work). Git membership and the constraint overlay are likewise out of bounds for ops by design. Never rank or auto-inject; anything that "helpfully" anticipates what the model wants is the ranking growing back. {§packet-manifest-catalog}, §actor-boundary.
- **"index" is plumbing, never a concept.** The term is too overloaded (SQLite indexes, FTS, 1-indexed offsets, the symbol graph, JS barrels) to carry conceptual meaning — disambiguating it during a rename tripped over dozens of unrelated mechanics, and the misnamed `log_entries.indexed` once cost a real debugging panic + seeded a fiction that OPEN is a manifest/content lane. The model-facing entry directory is the **catalog** (`manifest.json`); per-row OPEN/FOLD render state is **`expanded`** (`log_entries.expanded`). Reserve "index" for arcane technical plumbing where it's unambiguous; never name a concept, column, table, or doc term "index".
- **Model context vs database context — NEVER conflate (we will choke on it).** Two orthogonal axes, two different relief levers; always name which one.
  - **Model context** = the per-turn PACKET / token window — what the model *sees* this turn, bounded by `tokensFree`. Pressure: the packet won't fit. Lever: **FOLD** (collapse a render — the entry STAYS in the db) + the budget grinder (→ 413 packet-overflow terminal). The manifest *listing* and entry *renders* consume model context.
  - **Database context** = PERSISTENT sqlite storage — what's on disk, bounded by disk / `PLURNK_SQLITE_MAX_PAGE_COUNT`. Pressure: the db is filling. Lever: **KILL** (DELETE the entry from the db). The "80% full" nudge + storage-full are database context.
  - FOLD frees model-context TOKENS (entry persists); KILL frees database STORAGE (entry is gone). "Manifest too large" is MODEL-context (grinder / 413); "db full" is DATABASE-context (KILL / 80% nudge). Orthogonal: a huge manifest of tiny entries vs a full db of few fat entries. Never let one lever (FOLD/KILL) or one limit (`tokensFree`/`max_page_count`) stand in for the other.
- **Membership is the security boundary — git `ls-files`, fail-closed.** Relevance is outsourced to git (membership) + client (overlay: add/ignore/read-only) + model (READ/FOLD); the engine materializes exhaustively, never ranks. Membership is *strictly* `git ls-files` (no fs-walk exists), so `.gitignore` is law by construction; git-absent fails **closed** (zero members → every READ 404). READ and EDIT are both membership-gated — a non-member is 404/403'd *before* any disk read or write (no leak, no silent overwrite); new paths stay open via propose→accept. yolo gates proposal *review*, never *what is addressable*. Don't commit secrets; ls-files is law. {§membership-git-membership}, {§membership-edit-membership-gate}
- **Client activity is DSL ops in its own run; the model's run is its conversation.** The packet renders the *model's* run, so a client's own run is **structurally invisible** — invisibility by *run*, not a render-filter (no origin-tag). Two deliberate cross-actor channels: **`btw`/inject** (voice) and the **entry-change → log waterfall** (environment — a signal, not a turn). Chosen over the #194 origin-filter: one way for a thing to be invisible, not two. {§actor-boundary-isolation}, {§machine-processes-one-filesystem}, §connection-lifecycle.
- **Speak in DSL, not plumbing.** `op.*` RPCs construct DSL statements and dispatch through the same engine path the model uses; clean-shape params (`path`, `content`, `tags`) are fine for ergonomics, but the *semantics* must be the DSL's. Any client (TUI, CLI, nvim, Telegram) does exactly what the model can — no more, no less. {§methods-op-mirror}
- **Operational hygiene on what the model sees.** The model's view (packet.system/user) is its world — leaking infrastructure (YOLO outcomes, resolution mechanisms, security metadata) into it is a bug. It sees *what happened* (status, log, body), never *how it was administratively resolved*; strip that from the wire, keep it in DB rows for forensics. {§telemetry-no-error-scheme}, §dual-yolo.
- **Gamification policy: the model sees errors that happened, never the engine's bookkeeping about them.** `parse_error`/`action_failure`/`max_commands_exceeded` surface; strike counts, cycle/sudden-death thresholds, no-ops accounting stay internal (they drive abandonment silently). The test: did something happen *to the model's emission*, or is it the engine's reasoning *about* it? The latter never surfaces. {§telemetry-no-error-scheme}
- **Channel suffix clobbers URI fragment.** A known quirk of the `<<URI#channel:body:URI#channel` convention: we can't faithfully address real URI fragments like `https://example.com/page#section` because the `#section` would be reinterpreted as a channel name. Currently accepted; revisit if a use case forces it.
- **Keep starved:** `plurnk://` and `packet.augment` (§packet-assembly) are hooks-n-filters in URI costume if ever built as interception — design as addressable state, never interception. That late-bound-everywhere spine is what tar-pitted the prior attempt; plurnk's closed plug points (provider/scheme/mimetype/exec) cannot host it.
- **Contracts carry `{§}` anchors; the guard enforces alignment.** Every SPEC promise ends in a `{§<id>}` tag cited by a test named `[§<id>] …`; `test/intg/spec-anchors.test.ts` fails on either an orphan ref or an uncovered promise. Keep spec↔code↔test↔intent in agreement — the failure mode is a *coarse anchor* masking a partial build or quiet drift (the §tokenomics/§membership disease: one tag over a multi-decision lattice). When a promise is unbuilt, mark it deferred with a deliberately-red test, never a green stub — an anchor for an unbuilt promise is a *happy anchor*, anchored first with its deferred-red test riding along. Each built promise also carries a `§<id>` comment at its implementation site; `scriptify/spec-audit.mjs` reports the spec↔code coverage (a daughter-only contract like `§mock-provider-mock-fixture` is the lone exception — no service call site to tag).
- **Read the DB via the digest, not via raw SQL.** `bin/digest.js` writes curated artifacts (`digest.md`, `digest.json`, `reasoning.md`). Direct SQL spelunking encourages half-engaged review and hallucinated patterns.
- **Full repo management authorized for plurnk-service.** Agent commits, branches, pushes, opens PRs, AND merges PRs autonomously. Agent confirms before destructive ops that can't be undone cleanly: force-push to main, branch deletes that destroy unmerged work, rebases that rewrite shared history, `git reset --hard` on tracked changes.
- **Delegation over inheritance.** Shared scheme logic is a static utility class the schemes *call* (`_entry-*`), never a base class they inherit. Extract only when commonality is proven across ≥3 deep instances.
- **Triggers for cascades, TS for branching.** SQL triggers do simple cascades/denormalization; conditional status logic (terminal codes, loop-detection) is explicit engine TS. CHECK enforces; the trigger needn't compute.
- **Extension points are a promise.** A scheme handler with zero subscribers is still an extension point — don't delete it as unused.
- **Every DB JSON blob carries a declared schema.** `entry.attributes` is the one deliberate dumpster, reviewed for graduation.


---

# Project Worksheet

_(Migrated from PROJECT.md, 2026-06-27 — the project reorg is reverted; the worksheet now lives here in ./AGENTS.md. NOTES.md is also retired.)_

# Scratch

Untracked dev scratchpad — the owner's stakeholder space and plurnk-service's dev-management. AGENTS.md
is **policy** now (it foists into the model's packet); this file holds everything that is NOT policy:
the live TODO + open epics, the owner's note inbox, and the toolchain/working-hygiene orientation.

---

## Notes (foundation)

### Toolchain

- **Node ≥ 25.** Native TypeScript (`.ts` files, no compile step in dev). `tsc --noEmit` is the lint pass.
- **ESM only.** `"type": "module"`. `node:` prefix on every built-in. No CommonJS.
- **No biome.** Discipline lives in this file plus code review plus TS's type system.
- **Test runner:** `node --test` with `--experimental-test-coverage`. Native only.
- **Coverage target:** 50% lines / 50% branches / 50% functions per CLAUDE.md global. Floor, not ceiling.
- **SQLite:** `@possumtech/sqlrite` (user's anti-ORM wrapper around `node:sqlite`). All SQL lives in `.sql` files; not a single SQL string exists in `.ts`/`.js`. Schema in `-- INIT: <name>` blocks (run idempotently at open); prepared statements in `-- PREP: <name>` blocks (compiled at boot, exposed as `db.<name>.{run,get,all}({...})`); raw EXEC in `-- EXEC: <name>` blocks. Multi-dir overlay is deterministically basename-sorted.
- **Env management:** the `--env-file-if-exists` cascade — `.env.example` < `.env` < `.env.<profile>` < shell (SPEC §operator-config). No boot-time validators or fallback constants: a read failure means fix `.env.example`, not the read site. Feature-flag bools are `=== "1"` exactly, never `=== "true"`.
- **CLI parsing:** `parseArgs` from `node:util`.
- **HTTP:** built-in `fetch`. No axios, no node-fetch.
- **No external mocking lib.** `node:test` mocks for the few places mocks are tolerated (unit only; integration uses mock provider).

### Shell & verification hygiene

- **Pipelines launder failure.** A piped command exits with the *last* stage's code — `npm test | tail` reports tail's exit, not npm's, and a background task wrapping it reads that same masked code. `set -o pipefail`, or don't pipe when pass/fail matters; read the real summary line (`ℹ fail N`), never infer green from a downstream exit.
- **`grep` false-negatives on `§`.** Source and spec files contain `§`; plain `grep` silently returns empty instead of matching. Use `grep -a` or `rg`.
- **Live/demo default model.** `PLURNK_MODEL=gemma` → free local llama-server at `127.0.0.1:11435`. Never opus or a paid model unless explicitly directed — gemma is the affordability floor the architecture is proven against.

### Test taxonomy

Four tiers (SPEC §test-taxonomy): `unit` / `intg` (mock provider) run in CI; `live` / `demo` are real-provider, env-gated. `live` pins wire-level behavior, `demo` pins holistic outcomes; the mock provider is `intg`-only.

- **No DB mocks, ever** — intg opens a real on-disk SqlRite file (`test/intg/.tmp/db-<uuid>.db`) and runs migrations; `:memory:` makes false-green bubbles and skips the digest path.
- **Specific assertions** — a specific error type/message, never a generic "it errored."
- **Stochastic agentic tests accept the engine's terminal set, not strict 200** — a `live`/`demo` test pinning strict 200 is flaky by construction.

### Troubleshooting a demo/live failure — the digest workflow (don't relearn this)

When a `demo`/`live` storyline fails, do NOT re-read the raw test log or spelunk SQL. The forensic loop:

0. **Confirm the run was unconstrained (GBNF debug mode) BEFORE trusting any emission.** A `live`/`demo` digest is only diagnostic when the model generated *free*: `PLURNK_GBNF_DEBUG=1` validates the grammar locally and does **not** transport it → the request runs unconstrained. If `PLURNK_PROVIDERS_GBNF` is applied instead (debug off, e.g. set in `.env`), the emission you're reading is the *grammar's* constrained output, **not the model's intent** — and a buggy GBNF can MANUFACTURE the symptom. Cost paid: a backwards `no200` strip in the grammar forced every multi-op `SEND[200]`→`SEND[202]`, which I diagnosed as "the model hibernates / dead-parks" for a whole session before the raw `assistantRaw.json` reasoning (intended 200) exposed it. The GBNF is `@plurnk/plurnk-grammar`'s artifact — not ours to own, and the first thing to suspect when an emission looks wrong. [[never blame the model]]
1. **Find the run's DB.** Every `openMigrated()` keeps its DB and logs `[openMigrated] db kept: test/intg/.tmp/db-<uuid>.db` on close. That line is printed in the test output *just before* the `✖ <storyline>` result — so `grep -nE "db kept|✖" <log>` maps each kept DB to the storyline that produced it (the `db kept` line immediately above the `✖` is that test's DB). The `test:intg/demo/live` runners pre-clean `.tmp` (`test:clean-tmp`), so it only ever holds the *current* run's DBs — no digging through prior runs' piles. (A bare `node --test <file>` bypasses the runner; run `npm run test:clean-tmp` first if you go around it.)
2. **Digest it.** `node bin/digest.ts test/intg/.tmp/db-<uuid>.db` → writes `test/digest/digest.md` (per-turn waterfall: each op as `← OP[status] scheme://pathname`, with `outcome` and, for ≥400, the rx error string inline), plus `packetNNN.system.md` (byte-exact what the model saw that turn), `reasoning.md`, and `digest.json`.
3. **Read `digest.md` first.** The waterfall usually names the failure in one line — e.g. `← EXEC[500] exec://sh/1/1/2 ✗ → exec dispatched without an executor registry` is "the harness didn't wire `ctx.executors`," a missing-infra packet problem, not the model. The emission + reasoning per turn show what the model *tried*. Open `packetNNN.system.md` only when you need to see exactly what the model was shown (log + manifest, prior op results).
4. `npm run test:clean-tmp` purges `.tmp/` when the kept DBs accumulate.

The diagnosis is always "what is the packet missing?" — the digest *shows* it. Reaching for "the model is weak / non-deterministic" before reading the waterfall is the deflection [[never blame the model]] warns against.

### Source layout

`src/{core,server,schemes,types}` + `bin/` (CLI + digest), `migrations/` (numbered idempotent SQL), `lang/en.json` (i18n; no bare english in core), `test/{intg,live,demo}/`, `scriptify/` (one-offs, never build steps). In-tree schemes: `plurnk`, `log`, `exec`, `known`, `unknown`, `skill`, `file`.

- **One class per file** (`export default class FileName {}`); SQL in co-located `.sql` files — no `db/` subdir, no inline SQL in `.ts`/`.js`.
- **Mimetype handlers + providers are sibling `@plurnk/*` packages**, boot-discovered (SPEC §plugin-discovery); the in-tree set stays minimal (no `src/providers/` — `ProviderInstantiate.ts` does the dynamic import).
- **Sysprompt** comes from `@plurnk/plurnk-grammar/plurnk.md` via `PATHS.instructionsSystem` (single source of truth upstream).

### Git workflow

- **Conventional commits.** Type prefix (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, etc.), then `#<issue>` reference(s), then ` — ` em-dash, then short description.
- **No `Co-Authored-By` trailer — the agent is the SOLE author.** "No co-author" means *just the agent*, not *strip the agent*: the user directs at a high level and gives the thumbs-up, the agent writes the code and takes the credit for it. Encode it as the author/committer split — `git commit --author="Claude <noreply@anthropic.com>"` (committer stays the git-config user = agent wrote, user approved). Never a co-author footer; commit body ends at the last paragraph of substance — authorship lives in the author field, not a trailer.
- **Issues.** Prefer real issue numbers; **use `#0` when there's no valid issue** (owner, 2026-06-22) — it satisfies commitlint `references-empty` for ref-requiring types (`feat`/`docs`/…) without dodging into `chore`. Multiple issue refs in one commit is fine. Reopen issues to thread continued work onto them — better than spawning new issues for incremental scope. A `fix:`/`feat:` subject carrying `#N` auto-closes #N on merge to main (GitHub's keyword rule) — for a commit that references but does NOT resolve (a mitigation, not a fix), use `refs #N`; reopen if an auto-close was wrong (#204 was auto-closed by its mitigation commit and had to be reopened).
- **Branches.** Feature work goes on a branch named `<type>/<short-description>`.
**AGENTS.md is gitignored** — durable local-only project memory, never committed.
- **PRs and merges.** Agent opens PRs AND merges them autonomously per user authorization. Agent confirms before destructive ops that can't be undone cleanly: force-push to main, branch deletes that destroy unmerged work, rebases that rewrite shared history, `git reset --hard` on tracked changes.
- **Commitlint hook.** A user-level commit-msg hook enforces conventional commits + issue refs. Body lines must be under 100 chars. When commits get rejected, fix the message (don't bypass with `--no-verify`).

### Logging

- Runtime logging is DB rows in `log://` per the grammar's persistence schema.
- Stdout is for boot-time banners and crash reports only. No `console.log` in the hot path.
- Forensics via `bin/digest.js`; standing rule says read the digest, not raw SQL.

---

## TODO

Lean checklist. Ordered by chapter; chapters run in order. Items are imperative one-liners. When something lands, delete the bullet. No ✓ marks, no PR-number tombstones, no embedded discussion.

### SURVEY & SEQUENCING (owner steer 2026-06-27) — the cross-cutting work map

A broad survey (open issues + this doc's User Notes + the budget chapter) clustered by shared context. **Owner sequencing: telemetry quick wins + the issue backlog FIRST, THEN budget — "I don't want to deal with budget while we have random bugs floating around."** The Op Semantics Contract epic below stays the standing TOP-PRIORITY chapter (it gates budget). Branches in flight (stacked off main): `repo-glob-expand` (repo `*` glob-expand) → `fix/run-scratch-kill` (#282) → `feat/loop-usage-context-size` (#274).

- **Telemetry cluster (B) — DONE/routed.** #274 (contextSize on loop usage) SHIPPED (`feat/loop-usage-context-size`). #275 (grammar_unenforced from response.telemetry) was ALREADY shipped → verified + closed. #276 (`level` on TelemetryEvent) is grammar-owned → raised as **grammar#43**, service half (set level at emit sites) follows the contract. Remaining: Entries-in-Scheme table (count + tokens per scheme — DEFERRED, overlaps catalog/FIND) · decide `tokensFree` training-vs-telemetry naming.
- **Issue backlog — triaged firsthand.** Closed (shipped): #279, #270, #275. Fixed on branch `feat/adopt-grammar-0.74.28`: #280 (parse-drop — grammar 0.74.28 bump), #281 (`run://self`), #282 (run-scratch KILL), #284 (op.parse surfaces parse failures), #277 (EXEC `<0>` turn-scoped + poll floor). Routed upstream: #276 → grammar#43. STILL OPEN: **#240** (executor-owned schemes RFC — owe service wiring positions) · **#272** (embedBatch — CORPUS-LEVEL batching; the per-entry swap churns the worker pool and breaks timing tests) · **#276** (awaiting grammar#43, then set `level` at emit sites).
- **Error presentation — the model row IS the error context.** A model-facing error carries a content-offset `line:col`; the turn that erred has its `model` row born OPEN (§model-entry), so the model resolves the line against its own emission — no embedded snippet (`{§telemetry-content-offset-pointer}`). The `op.parse` client path (no model row) surfaces each parse failure as a 400 result carrying its `line:col` (de-offset for the injected `<<PLAN`; the benign trailing "unexpected end of input" is dropped — a complete set of statements is valid for parse-and-dispatch, the genuine unterminated case rides the `unparsedTail`).
- **intg testing config:** runs serial (`--test-concurrency=1`) — its real-subprocess/daemon-timer tests (exec timeout/poll, wake, teardown, drain) can't share CPU with co-scheduled files behind bounded `waitFor` gates. Tests run via `npm run test:*`, deliberately; no CI workflow. The only red intg tests are the 4 budget ones (parked, below).
- **THEN — Budget chapter (cluster C, after bugs clear):** land `budget-meta.test.ts` · revisit budget formulas pre-launch · resolve the uncommitted requirements.md FOLD/KILL MUST + requirements.md role (dedupe vs plurnk.md Imperatives) · the 238s degenerate-flail run.
- **Op Semantics Contract (cluster A)** = the TOP-PRIORITY epic immediately below; gates budget; #278 Stage 2 is the live work.
- **Strategic (cluster F):** packet pluggability / the complete-override audit (the moat) + docs-in-hot-path vs manifest + docs-catalog residue (schemes#25, session-scope seeding).
- **Launch readiness (cluster G):** naive install e2e (`test:installation` exists — verify) · `--api-key` flag · SEARXNG default → model.plurnk.ai · i18n · out-of-sqlite-space story · digest golden refresh · CI cadence · more-providers shakedown.
- **Last-mile model/agent forensics (cluster I — owner steer 2026-07-01, first thing post-prepub):** the terminal-contract steers verify claims correctly (§send-premature-terminate, §send-groundless-hibernate; live/demo digests prove every rail firing per SPEC) — the open variable is gemma's ADAPTATION to a steer: the same refusal repeats verbatim to strike-out on some runs (paris→tokyo) and resolves next-turn on others (config-lookup). Work items: probe steer WORDING as a tunable (does prescriptive "SEND[102] to receive it" converge faster than a terse conflict?) · decide whether the submitted-op gate extends to FIND/OPEN (a SEND[200] on an unseen FIND survey — the READ-regex red — is the same "data you don't have" logic; weigh against over-steering spirals before widening ANY gate) · paris→tokyo test acceptance (429 at `maxTurns:6` is a legible bound, not a failure — admit it or grant turns) · whether any rail should SEE no-progress-with-variety (fingerprints deliberately read varied matchers as exploration; the loop wall + turn ceiling bound it today) · budget-tier digests: under a pinned ceiling the model emits ZERO FOLD/KILL curation even across three consecutive overflow steers (grinder → 3 strikes → 500) — the log-KILL lever is REACHABLE now (writableBy fixed) but UNUSED; a teaching/steer question, and the floor-vs-ceiling arithmetic (the static packet alone can exceed a demo ceiling → instant hard-413) belongs to the budget-formulas revisit (cluster C) · personality-round digests (first tier ever WITH the policy in-packet): budget-meta all-green with the model working AT the ceiling (codename peak 4316/4300 — it curated); edit-todo regression = the personality's verify-doctrine colliding with the terse submitted-read steer (EDIT lands, then verify-READ+SEND[200] refused 409 ×3 → 500 — make THAT steer prescriptive like the live-thing one: "SEND[102] now; conclude next turn") · fan-out dead-park cascade = delegation-shape grammar mangle (marker in the body slot → dest became a literal file path) + proposal-REJECT rx carrying only {status} (deliberate hygiene, but the model got zero why and parked on a phantom worker — reconsider a terse reason on reject) · the file-write mkdir bug it exposed is FIXED · CONSTRAINED sweep (grammar 0.74.47 #47 in-sampler): submitted-READ 409s = ZERO across every digest — the class is unsampleable; live 14/15 + all 13 stories green (edit-todo 8 turns → 200, the grammar walking verify→receive→conclude); paris→tokyo now fails DILIGENT (no refusals, EXEC[search]-per-city outruns maxTurns:6 — pure test calibration) · live-thing 409s remain engine-owned (CFG can't see runtime children; delegate steered correctly, timed out slow) · budget grind/codename stay the cluster-C pinned-ceiling frontier.
- **Deferred:** global resources `wiki:///` (cluster H, post-v1) · CPU-spike-on-load progress signal (pairs with #272).

> The full raw User-Notes inbox (below, § User Notes) still needs triaging INTO these clusters — do that once the telemetry cluster lands so this doc stops drifting.

### ACTIVE EPIC — Operation Semantics Contract (URI resolution + matcher rendering) — TOP PRIORITY, no deadline

**Why (owner, 2026-06-26):** gemma must be able to TRUST its mental model of our tooling. The op contract drifted silently in multiple directions; the model "behaving badly" was rational behavior against broken ops. Getting the contract clean + right is above budget and shipping — no timeline pressure. [[audit-tooling-before-blaming-model]]

**THE CONTRACT IS plurnk.md:31 (owner):** *"FIND returns rows of results, READ returns lines of content"*; plurnk.md:32 — READ prefixes each line with ONE source-line number `N:\t`. The grammar defines it; the service implements it; SPEC §matcher-result now DOCUMENTS it (grounded in plurnk.md, anchor `{§matcher-result-read-returns-lines}`). We implemented it WRONG. Contract changes that need ecosystem coordination are fine (file the daughter issues).

**Verified via the coverage matrix (`test/intg/op-uri-contract.test.ts`):**
1. **FIND path canonicalization — FIXED + committed (738b096-ish).** `File.find` delegated raw to `EntryFind` → bare `notes.md` globbed `notes.md*`, missed `/notes.md`. Now calls `#normalizeFileTarget` like READ/EDIT (§scheme-address). Matrix: FIND(bare)+FIND(/slash) GREEN. (Nothing reads disk — content is in `entry_channels`; the "disk" framing was a fabrication.)
2. **READ does NOT return lines — the live bug.** Per plurnk.md:31 READ returns *lines of content* for EVERY dialect (a matcher SELECTS; READ returns the line at the match). Matrix: glob → lines GREEN (achievable); **regex → substring RED**, **jsonpath → value RED** (deferred). The OLD §matcher-result documented the buggy `regex→substring`/`jsonpath→value` as if intended — it was wrong, now rewritten to plurnk.md. My twice-flipped "regex is fine" was reading that buggy SPEC, not plurnk.md.
3. **Double line-numbering.** `File.read` is single-numbered (`2:\ttarget one`); the `1:\t143:\t…` double appears at the PACKET render (`packet-wire` re-numbers the matcher's already-`N:\t` body). plurnk.md:32 wants ONE source-line prefix → the render must not re-number matcher output.

**Stage 2 — implement (the live work):** matcher returns the LINE not the value (regex/glob: line is in hand; jsonpath/xpath: need source-line provenance → **mimetypes-daughter issue**, the owner-flagged coordination); kill the render double-numbering; FIND result carries match LOCATIONS (line numbers) — overturns `{§find-result-catalog-rows}` "no per-match extent" (update the promise + `Known.find.test.ts` in lockstep); multi-file READ fan-out (engine-level, one log item per matching file). **Still to cover:** COPY/MOVE dest canon; `<L>` slice; the render double-numbering cell; the FIND-locations cell. OPEN/FOLD = Log/log:// (N/A).

**Staged plan (contract-first):**
- **STAGE 1 — document + matrix (pin current behavior, expose ALL drift at once).**
  - [ ] Write the contract as a SPEC `{§}` section: (a) path resolution — every model-emitted path form → the one canonical member key `/rel`, every entry op normalizes before resolution; (b) matcher-result semantics — regex → matching LINE, jsonpath/xpath → extracted value, numbered ONCE with the source line; (c) `<L>` slice vs matcher slot.
  - [ ] Build the matrix intg test: op × path-form (FIND/READ/EDIT/COPY/MOVE) and matcher-result (regex/jsonpath/xpath × single/multi). RED where broken — deliberately, so "broken" becomes "exactly which cells."
- **STAGE 2 — centralize + fix against the matrix.**
  - [ ] One normalization chokepoint every entry op passes through (FIND fixed as a consequence; COPY/MOVE audited).
  - [ ] Regex returns the matching LINE; kill the double line-numbering (matcher body is already numbered — READ must not re-number).
- **STAGE 3 — confirm + close.**
  - [ ] Full matrix green; guard/anchors 1:1; intg + tsc clean; re-run SPEC-jumbo demo (gemma's `#grinder#` should return lines, fold, answer) — the end-to-end trust proof.

> **PARKED under this:** budget meta-scenario (`budget-meta.test.ts`, SPEC-jumbo red) + the budget thread resume — both wait on the contract being clean (the demo can't pass while FIND/regex are broken).

### Errors into the log (one surface) — DONE 2026-06-26 (8eec114)

**SHIPPED.** Every error is a foldable log item; the errors section is a minimal derived pointer index (status + `log:///<coord>`) over recent `log≥400`. A parse failure writes an actionless `op='error'` row (status 400; parser message + the model's own snippet as its foldable body, fenced at the log coord; pointer stays minimal). `action_failure` already worked this way → parse errors joined with zero new derivation. Engine NOTICES (`grammar_unenforced`/`max_commands`/`budget_overflow`/steers) stay telemetry — not the model's failures. No advice; clients read errors from the log. Schema `log_entries.op +'error'`. SPEC §telemetry reframed, 4 anchors kept + re-scoped; guard 184/184, intg 876/0, tsc clean. The owner's budget invariant ("can't overflow if you fold your prior turn's log items") holds again — errors are now foldable.
- Residue (minor, not blocking): pointer renders `"error":""` for parse rows (could omit the empty field); an explicit fold-error-reclaims-budget test would close the invariant loop (covered today by composition: error = log item ∧ log items fold to reclaim). The `response.telemetry` providers#24 located-event path (Engine.ts:1015) still buffers — correct (those are NOTICES).

> **RESUME BUDGET (the detour's origin):** recalibrated `budget-grind` demo (CEILING 3500) is healthy + red-by-design. RESOLVED (e52fd5f): the "honest overshoot" was a SPEC error — the budget % is of the DELIVERED (post-fold) packet, always ≤100%; >100% lives only in the un-foldable hard-413 forensic record, never delivered (owner: "the packet literally can't be over 100%"). Code was already correct. Remaining budget thread: the grinder's prior-turn-ONLY fold lever (§grinder-layer1-rollback) — now that errors are foldable log items, an over-budget delivered packet should be impossible if everything's correct; the un-foldable hard-413 is the corner case to keep rare. KEEP budget speculation parked until digesting runs under pressure.

#### (history) ACTIVE EPIC — Errors into the log — IN PROGRESS 2026-06-26

**Why (owner, surfaced while stress-testing the budget demo):** errors lived on TWO budget surfaces — the foldable `log` AND a non-foldable telemetry `errors` section. Parse errors had no log entry (an actionless emission), so they bloated the non-foldable section, and the grinder's prior-turn-rollback (which only folds *log* items) couldn't reclaim them → hard-413 that the model couldn't curate out. Owner's invariant: *"impossible to go over budget if you started under and fold all of your previous turn's log items."* Broken only by non-foldable error bytes. Owner: errors as durable log items = the model can remember/curate its own mistakes (transient telemetry was a deprivation).

**LOCKED design (owner):**
- **Every error is a plain log item.** No per-kind handling. A parse failure writes a `log_entries` row: `op='error'`, `status_rx=400`, `origin='model'`, `source='grammar'`, no target (scheme/pathname null), `rx` = `{message, position, snippet, parserSource}` (snippet = the model's offending line — the foldable body). Coordinate `log:///<L>/<T>/<S>/error`. Foldable/killable/budgeted like any log entry → the invariant holds.
- **The only special surface:** a system-packet section listing the MOST RECENT errors as `<status> log:///<coord>` pointers — a derived index to aim the model, no bodies, no own budget/fold state. This already half-exists: `engine_render_telemetry_errors` (Engine.sql) derives `action_failure` from `log_entries WHERE status_rx>=400` of the prior turn; parse-error rows (status 400) join it automatically. `#buildTelemetryErrors` (Engine.ts:1490) collapses to ONLY that log-derivation; the buffer drain for errors goes.
- **Errors are durable, not transient.** The "clears once seen" telemetry buffer retires. Recency = derived (prior-turn log≥400). The errors persist in the log until the model folds/kills.
- **Clients read the log** (owner): retire the `telemetry/event` ERROR path; `log/entry` + `log.read` cover it.
- **No advice stays** (owner): facts only (kind/status/position/snippet); no imperative. Engine-internal accounting (strike/cycle/sudden-death/no-ops) stays silent (gamification) — NOT errors, out of scope.

**STATUS 2026-06-26: CORE LANDED + VALIDATED, tree RED on 3 expected anchors (mid-refactor).**
- DONE + green: schema (`log_entries.op` enum +`'error'`, migration), mint (parse failure → `op='error'` status-400 actionless log row after the dispatch loop, Engine.ts), and `[§telemetry-no-error-scheme]` REWRITTEN + PASSING — proves a parse failure is a queryable+foldable log item with a derived errors-section pointer. The existing `engine_render_telemetry_errors` (log≥400 prior-turn) picks the error row up as an `action_failure {op:'error',status:400}` pointer with ZERO new derivation code.
- RESOLVED design split (the rails/steers open-Q): **ERRORS = model failures (parse, action) → log items**; **engine NOTICES (grammar_unenforced, max_commands, budget_overflow, premature_terminate, idle_turn) stay TELEMETRY** — they aren't the model's failures, they're the engine steering/narrating/diagnosing (ephemeral, drain-on-read, `telemetry/event`). So 3 of the 4 anchors KEEP, re-scoped to notices.
- REMAINING — ordered checklist (decisions made; the green `[§telemetry-no-error-scheme]` rewrite is the assertion TEMPLATE):
  - [ ] **T1 `contract-telemetry.test.ts`** — only the parse-error-driven tests broke (#256/#275 grammar_unenforced tests are unaffected). DELETE the old parse-error snippet test (~74) + drain test (~115). Onto the **#275** test (already drives `grammar_unenforced` + asserts drain-once + structured snippet) ADD: the `[§telemetry-drain-on-read]` + `[§telemetry-content-offset-snippet]` citations to its name, and a WIRE assertion (snippet under `error://<line>` in `renderSlot(user)`). Re-point the **notify** test (~292) `BROKEN_STMT` → a `grammar_unenforced` event (notices broadcast; errors are log rows clients read via `log.read`). (If the guard rejects two `[§]` on one test, split #275 into two.)
  - [ ] **T2 SPEC §telemetry reframe** — errors are LOG ITEMS; the errors section = derived pointer index over recent `log≥400`. Re-mean the 4 anchors: `{§telemetry-no-error-scheme}` = errors live in `log:///` (op='error'), not a bespoke `error://` scheme (name still apt); drain/snippet/notify scope to engine NOTICES. Broaden the glossary `action` line (log holds executed actions AND actionless `error` rows).
  - [ ] **T3 render** — confirm an `op='error'` row renders legibly in the LOG section (snippet body, foldable) via `packet-wire #renderLogEntries:289`; adjust if the JSON-rx body is ugly.
  - [ ] **T4 sweep** — other parse_error-asserting tests (Engine.run-loop, Engine.budget-enforce, packet-wire, telemetry-event-schema, turns): expect an `error` LOG ROW + derived pointer, not a `parse_error` telemetry kind.
  - [ ] **T5 verify + commit** — guard 1:1, full intg, tsc; commit.

**Implementation (core-path, do in verified increments):**
0. **Schema** — `log_entries.op` is `CHECK (op IN ('FIND','READ',…,'PLAN'))` — widen it to admit `'error'` (greenfield: edit `migrations/0000-00-00.01_schema.sql` directly). `pathname` is already nullable (actionless errors carry no target). Check what else validates the op enum (grammar types? render?).
1. **Mint** — `Engine.ts:998` parse-error loop: stop `#pushTelemetry`; instead write a log entry per parse error AFTER the op-dispatch loop (`Engine.ts:~1145`, at `nextActionIndex + opsToDispatch.length + j` so it threads the turn's sequence). Same for the providers#24 `response.telemetry` located events (1015) if they're errors.
2. **Derivation/render** — `#buildTelemetryErrors` → log≥400 only (drop `#drainTelemetry` for errors); `packet-wire #renderTelemetryErrors` → pointer index (`<status> log:///<coord>`), NOT bodies/snippet (snippet now lives in the log row body). Put a terse `error` field in the row `rx` so the derivation's `error` extraction still works.
3. **Grinder** — drop the `telemetryErrors` preservation through rebuild (`Engine.ts:1432`); errors fold like log now.
4. **Notify** — retire the error path of `telemetry/event` (clients read the log).
5. **Open Qs to resolve in build:** `max_commands_exceeded` + `budget_overflow` are `engine:rail` narrations, not failures-with-a-body — owner said "all errors are log items, no special types," but these aren't model *failures*; lean: keep as rail telemetry OR log them too (decide, don't assume). `Log.ts` error-row render.
6. **Docs/anchors (lockstep, guard 1:1):** reframe SPEC §telemetry; retire/replace `{§telemetry-no-error-scheme}` (errors ARE log items now), `{§telemetry-telemetry-event-notify}` (clients read log), `{§telemetry-drain-on-read}` (no buffer; recency derived), `{§telemetry-content-offset-snippet}` (snippet → log-row body). Broaden glossary `action = …→ log row` (log holds actions AND actionless failures). All 4 cited by `contract-telemetry.test.ts`. Other tests asserting parse_error telemetry: Engine.run-loop, Engine.budget-enforce, packet-wire, telemetry-event-schema, turns.
7. **Test the invariant:** a parse-error log item folds → reclaims budget; the pointer section derives from the log; a client reads an error via `log.read`.

> **DETOUR from the budget-grind work** (owner: "we take a detour to get our error story straight, taking as much time as we need to get it right"). After this lands, return to budget: the recalibrated `budget-grind` demo (CEILING 3500) + the §tokenomics-over-budget-floor "honest overshoot" vs owner's "never >100%" divergence + the grinder's prior-turn-only fold lever. KEEP budget speculation parked until digesting runs under pressure.

### ACTIVE — grammar conformance: remaining pins
`run://` (spawn/fork/irc) is built + SPEC-anchored (§run-scheme), honored end-to-end (`run-scheme.test.ts`): spawn = EDIT (new sister + prompt), fork = COPY (Fork.fork the log + prompt), irc = SEND (deliver via Daemon.inject). One engine seam — `ctx.injectRun` → `Daemon.inject`. Remaining:
- [ ] Pin the remaining hand-curated grammar examples in `plurnk-md-conformance.test.ts` (matcher-only) — `#channel` READ; the `run://` family optionally (behavior already covered).
- grammar (grandma — raise-the-need): re-export `RegexPath`/`LocalPath` from the package entry — `ParsedPath` members not importable by name. (grammar#31, open.)
- daughter (schemes — raise-the-need): `SchemeManifest.category` is `"data"|"logging"` with no control value; `run://` is forced to `"data"` (inert — category is read nowhere). schemes#21.

### ACTIVE — User-Notes follow-ups (triaged 2026-06-16; verified done-notes cleared, see § User Notes)

**Catalog path + channel format — grammar#32 RESOLVED (closed, service-owned). NOT gated — grandma: "the manifest render is a service concern… proceed on both." GO:**
- [ ] (note 1) Membership "escape" rework — PARTIAL (reconciled 2026-06-25): an INSIDE-root absolute echo now maps to its member (`toWorkspaceRelative`, `File.ts`). Still open: an OUTSIDE-root forest member (a `..`-prefixed `repo` declaration) hits the `relBare.startsWith("..")` containment 403 BEFORE the membership lookup. Now INTERSECTS the shipped Forest epic — move membership-by-canonical ahead of the containment guard so a declared outside-root member resolves instead of 403ing. Design as one pass.

**Status checks / docs:**
- [ ] (note 8) Web fetch + web search — RE-DIAGNOSED 2026-06-25 (my "not installed" was wrong twice over; this is the real story):
  - **http:// IS installed + discovered.** `@plurnk/plurnk-schemes-http@0.15.9` rides in transitively via `schemes-all` (peer = our exact `schemes@0.30.8`); `discoverExternal` registers it (`isExternal('http')=true`). search likewise: `execs-all` → `execs-search@0.2.8` (tags search/images/videos/news/map), dispatches to a **SearXNG** instance — needs `PLURNK_EXECS_SEARCH_SEARXNG_URL` (no API key).
  - **PRIMARY BUG — FIXED (58d98e6, #195).** The daemon double-registered schemes: `#discoverAndLoadPlugins` (old PluginLoader path) registered http IN-TREE, then `discoverExternal`'s in-tree precedence SKIPPED it → never flagged external → no `SchemeCtxImpl` → `ctx.subscriptions` undefined → 500 on every external streaming scheme's first op. GENERAL (every `@plurnk/plurnk-schemes-*`), not http-specific. Removed the redundant path; `discoverExternal` is now the sole scheme seam. Verified: the 500 advanced past the capability layer.
  - **http:// — DONE ✅ (51d74c1).** Secondary gap was a daughter gap (schemes-http#3, fixed in 0.15.11: `entries.write` seeds the entry before `subscriptions.open`, mirroring exec's create-then-subscribe). Adopted the coordinated bump (schemes 0.30.9 / mimetypes 0.15.27 / schemes-all 0.2.11 / schemes-http 0.15.11). `test/live/web.test.ts` is GREEN against real network (no model, no mock). intg 874/0.
  - **search — TURNKEY ✅ (af90e2a), one env var from green.** Complete live test (`test/live/web.test.ts`): real Engine + ExecutorRegistry dispatch of `EXEC[search]` (effect=read, auto-run) → executor fetches SearXNG → streams JSON into the `search:///` `results` channel → read back + asserted. VERIFIED GREEN against a local SearXNG-shaped stub (our full dispatch→stream→read path proven, no mock of our stack). The probe gates on `PLURNK_EXECS_SEARCH_SEARXNG_URL`; set it to a real SearXNG endpoint (no API key) and the test goes green in production. Owner action: stand up / point at a SearXNG instance.
- [ ] (note 11) Plugin READMEs (mimes/providers/execs/schemes) are LLM-facing plug-in/extend guides; service's README is the custom-client parallel — terse "what it does / the interface / wire up your own." Service README is ours; daughter READMEs are raise-the-needs.

**Dogfood findings (deepseek-v4 packet audit, 2026-06-18) — CLOSED.** The ONE legitimate item (budget % rounding sub-1% to `0%`) is fixed (be85626: show `<1`). The rest were the model misreading deliberate design — filed grammar#36 + mimetypes#35 over-eagerly, then **closed**. [[filter-model-audit-findings]]: triage a model's audit of a deliberate-design contract like an adversary, not a stenographer — the bar is "demonstrable defect," not "the model said something."

### ACTIVE EPIC — Scope model `{session, run}`: run-scope scratch + the docs catalog

> **⚡ IN-FLIGHT (2026-06-22) — live design w/ owner. SUPERSEDES parts of this epic (run_id → owner-in-pathname; item E → manifest→FIND) and reshapes the Packet epic's catalog. run-scope + the manifest→FIND merger are CO-DEPENDENT (run-scope rides the unified FIND). Nothing built yet.**
>
> **run:// — ONE scheme: control + run-scoped storage. Authority = the run, ALWAYS.**
> - `<name>`/`<alias>` are the same thing — the run's **immutable name IS the domain/authority** (refines the older "runId as authority"; control scheme already resolves by name). Path = the entry. `run:///` = empty authority = self.
> - **Storage = ordinary entries, NO run_id** (SUPERSEDES item C's "run_id discriminator"). Owner = the pathname's first segment = the folded authority; names immutable → stable; a `run_id` FK would be a 2nd source of truth. Row `(scope='run', scheme='run', pathname='/<owner>/<path>')`. `EntryOps.#pathnameOf` ALREADY folds authority→path, so `run://other/x`→`/other/x` is free; only self (`run:///x`) needs the empty→my-run-name inject, in Run.ts before it delegates.
> - **`scope='run'` is LOAD-BEARING** (not redundant w/ scheme='run'): every entry query filters `WHERE scope='session'` (crud / Engine.sql manifest / FIND / ops / channel-write) → scope='run' rows auto-excluded → isolation free; owner opted back in only on read paths that should see own.
> - **Ops** — path-presence discriminates: path present → storage (READ any run's entry by address = cross-run READ ALLOWED; `EDIT run:///x` self only, cross-run write → 403). Path absent → control: `EDIT run://<new>` spawns (self→400), `SEND run://<name>` ircs, `COPY` forks.
> - **Breaking**: today Run.ts reads the run from the PATH; switch to AUTHORITY (`target.hostname`); spawn/irc re-address `run:///name`→`run://name`.
> - **No grammar blocker**: grammar parses `run://` generically; `scope` is our own `entries.scope` column. Item C's "scope enums gain 'run'" is a phantom — verify, don't re-file.
>
> **manifest.json → FIND merger (owner: "FIND results = manifest.json today, but filtered"). SUPERSEDES item E.**
> - `FIND(X)` = the catalog array filtered to X's matches; `FIND(**)` = whole array ≡ today's manifest.json. Result is a **JSON array of structured catalog objects** (NOT tabular), explored by jsonpath/matchers. Per-run scoping is just FIND's scope, not a bespoke manifest build.
> - **Catalog-row contract (TRUE merger, drop nothing):** `{ path, seconds?, tags?, channels: { <uri>: { mimetype, tokens, lines } } }`. Subtleties a shallow merge loses: **tokens = LIVE `tokenize(content)` at render** (not stored `ec.tokens` — a stale tokenizer lies); **lines = mimetypes `process().totalLines`** (derived); **channels = per-channel MAP keyed by addressable URI** (default→bare path, non-default→`path#channel`); **tags** (entry_tags); **seconds** (live stream age); **path render** = `#toPath` (bare for file/scheme=null, `renderAddress` else).
> - **Cross-scheme**: catalog spans all schemes, FIND is per-scheme today → `FIND(**)` must aggregate cross-scheme (engine-level). Metadata-narrowing = jsonpath over the array, NOT a new query engine. Per-scheme tally = a fold over the array (kills `engine_scheme_catalog_summary`).
> - **Pump decouple**: `buildManifestBody` is double-duty — catalog metadata AND the per-turn derivation pump (symbols/refs/embeddings/FTS + deep_hash gate), re-derives EVERY turn. Killing manifest.json orphans the pump → it becomes an explicit per-turn maintenance pass (one process()/changed entry; refresh derived + live tokens/lines); FIND reads what it leaves. Pump + catalog SHARE the per-entry process() — one walk, don't double-process.
>
> **▸ manifest→FIND MERGER COMPLETE (2026-06-22, branch `feat/run-scope-catalog`, pushed @ `4602fab`).** FIND **is** the catalog; there is no `plurnk:///manifest.json`.
> - **A** (`d715f33`) — FIND returns uniform catalog rows (NO extent); `Finding`/`findingsForMatch`/`enclosingSymbol` retired; `EntryManifest.toPath`+`catalogRowsFor` the shared render; file:// rows BARE; SPEC `{§find-result-catalog-rows}`.
> - **B1** (`85a980a`) — `maintainDerivations` (the pump) split out of `buildManifestBody`, byte-identical. **B2** (`3a1e1eb`) — direct catalog test callers retargeted.
> - **B3** (`ce84834`) — `manifest.json` DELETED. Turn-0 = `maintainDerivations` (pump, no entry) + a **per-scheme `FIND(scheme:///**)` foist** over schemes-with-entries (source `engine_scheme_catalog_summary`, REPURPOSED; `log://` absent — no find(), present-mode). `manifestItems N` = per-scheme `<L>{1,min(N,count)}` cap (clamped, never 416s); -1 full; 0/unset off. `buildManifestBody` deleted; Plurnk example → FIND. The "single directory to READ" invariant RETIRED. SPEC `{§actor-boundary-manifest-preview}`+`{§packet-manifest-catalog}` rewritten. **Cleanup** (`4602fab`) — `#MANIFEST_PATH` self-exclusion (inert + would mis-hide a model note) + stale comments retired.
> - Verified throughout: guard 170/170, intg 861/0, tsc clean.
> - **RESOLVED (87432fa):** SPEC `§run-scheme` storage anchors landed (`{§run-scheme-scratch}`/`-find-perspective}`/`-fork-scratch}`). `FIND(**)` ban = non-issue (parses `kind:local`, a scoped file-scheme glob, not a toxic cross-scheme global; the foist never emits bare `**`). plurnk.md advertising is the grammar's, not ours.
>
> **Build sequence:** **A** enrich FIND→catalog-row (cross-scheme JSON array, jsonpath) so `FIND(**)`≡manifest · **B** foist `FIND(**)` at run's first turn + decouple pump + delete `plurnk:///manifest.json` (+ self-exclusion + the 2 bespoke queries) · **C** run-scope on the unified FIND (storage scope-threading + Run.ts authority-addressing + ownership=path-prefix). SPEC `§run-scheme`. **Inc-1 (additive run-scope SQL variants `crud_find_run_entry`/`crud_insert_run_entry`/`ops_read_channel` run-form + a `manifest.scope==='run'` branch in EntryOps/EntryCrud; session path byte-identical → 0 test risk) is invariant — needed regardless.** Storage template = Known.ts → EntryOps/EntryCrud/EntryFind.
>
> **OPEN sub-points:** (1) does a content-matched FIND row carry the match EXTENT/symbol (`Finding.extent`) nested, or collapse to entry-level rows? (2) cross-scheme `FIND(**)` mechanism (engine fan-out vs one cross-scheme walk). (3) addressable durable catalog doc vs ephemeral FIND result — owner leans ephemeral ("FIND = filtered manifest").
>
> **LOCKED (owner, 2026-06-22):** no run_id (owner in pathname) · scope='run' (isolation partition) · run name = authority · cross-run write DENY (SEND/irc owns inter-run comms; safe-to-loosen) · JSON-array materialization (jsonpath, not tabular) · FIND result = filtered manifest.
>
> **FURTHER-SETTLED (2026-06-22 cont. — supersedes the `FIND(**)` bits above):**
> - **`FIND(**)` is DISALLOWED** (toxic global, banned in plurnk.md). The 1/1 catalog foist = a **sequence of `FIND(scheme:///**)`**, one per active scheme — NO cross-scheme aggregation; per-scheme arrays are independently cacheable (order `log://` last for prefix stability). `FIND(X)` = a scheme's array filtered to X.
> - **FIND rows are UNIFORM catalog rows — NO per-match extent.** A content match includes/excludes the entry; it never changes the row's shape. Match-location is a `READ`, not a FIND field. (Resolves old sub-point 1; sub-point 2 cross-scheme is moot.)
> - **log STAYS — present-mode, irreducible to the catalog.** Only the `log:///**` URI handle is shared. The log is content+ordered (pushed); the catalog is metadata+navigable (pulled). Do NOT try to collapse the log into the catalog.
> - **FOLD CORRECTED (I had it wrong):** `OPEN/FOLD` toggle `log_entries.expanded` — the run curating its own LOG view ("what I am looking at", §open-fold / §machine-processes-run-is-its-log). NOT entry content-vs-metadata; NOT the catalog.
> - **Scratch is REAL** (owner confirmed: a large *evolving private workspace*, not just notes → the log does NOT subsume it). run:// storage earns its scope; the "a run is its log and nothing beside" doctrine is RETIRED. SPEC excision started (§155 done); **§157 (`{§machine-processes-one-filesystem}`) + §161 (`{§machine-processes-run-is-its-log}`) anchored + §171/§173 remain — excise WITH the run-scope build, guard + tests verified.**
> - **Digest broke on the db-move:** `bin/digest.ts:336` defaults to `<projectRoot>/plurnk.db`, but the service writes `~/.plurnk/plurnk.db` (`service.ts:24 #homeDir`). FIX: digest resolves the service's db path, not the repo-local hardcode.

**The frame (settled 2026-06-18; supersedes the retired `run://`-private Deferred note).** Entries live at one of two scopes — the axis is *which identity discriminator*:
- **session** — the shared world ("one filesystem"), `session_id`-discriminated: the work + the seeded docs.
- **run** — per-run scratch, `run_id`-discriminated. Perspective-private, NOT ACL-private: `FIND(run://other/**)` reaches it cross-run, so privacy was never on the table and we don't pretend it is.

`agent` scope is **KILLED** — proven vestigial (no scheme defaults to it, the engine never writes it; the lone `agent` literal was the type union). The session is the top durable unit; no above-session concept exists or is coming (owner, 2026-06-18).

**`Manifest(run) = session-scope ∪ this-run's-run-scope`.** The manifest is the run's *perspective*, not one identical catalog for all runs. run-scope entries are catalogued only in their owning run's manifest (full token/line/existence data — what a run needs to manage its own scratch); other runs FIND them but don't see them catalogued. Invariant restated: *complete for the run's perspective*, not complete-globally. Excluding a whole scope is **structural**, never the forbidden relevance-curation — "deliver, don't decide" stands. Mind [[the model/db-context lock]]: this is all model-context (the manifest the run sees), orthogonal to database storage.

**run:// becomes a real storage scheme** (today a fake scheme that can't hold entries — the inconsistency this fixes). `run://<runId>/<path>`, runId as authority. spawn → fresh scratch; **fork → COPIES the scratch** (run state, rides the copied log, then diverges — `fork = everything-in-common-but-name`).

**Docs catalog — the self-documenting surface.** `plurnk://docs/<tag>.md`, **`docs` as AUTHORITY** (double slash; 96cae8f wrongly shipped `plurnk:///docs/`). **SESSION-scoped** (sessions register different scheme/exec/plugin sets → the doc set is per-session), seeded from that session's capability set, always in the manifest, READ on demand. `# Plurnk Service Tools` stays terse (live examples — push); deep docs are pull. Every scheme/exec/plugin (and the engine) registers a doc → the model's compose-competence grows with the catalog at ~zero hot-path cost (generalizes the #note12 doc-materialization).

**Work — sequenced. Grammar/schemes coordinate the scope-enum; the service leads and breaks loudly (never reverts to dodge the lag, per [[move-forward-break-freely]]).**

> **RECONCILED 2026-06-25 (firsthand): C SHIPPED, E still OPEN.** **C** landed (NOT a run_id discriminator — the owner's later LOCKED design won: owner-in-pathname). `entries.scope CHECK IN ('session','run')`, `entries_run_identity` unique index `(session_id, scheme, pathname) WHERE scope='run'`, `src/schemes/Run.ts` (authority=run name; write self-only, cross-run write 403; cross-run READ ok). §run-scheme anchors all green (spawn/fork/irc/collect/cap/terminate). **E** is the genuine remainder: the per-scheme catalog/FIND foist does NOT union the building run's own `scope='run'` rows (session queries filter `scope='session'`, auto-excluding them) — so a run's own scratch isn't catalogued in ITS manifest. Wire the union (owner opts back in on the building run's own-scope read path). **F** rides E (the per-run-manifest SPEC bit); the run:// storage anchors themselves exist.
- [x] **E. Per-run manifest — FIND core DONE (0932c03).** Run-scope FIND + catalog perspective: a run FINDs its own scratch (`run:///**`) and a sister's only by name (`run://name/**`); isolation structural. Additive variants (Inc-1, session path byte-identical): `find_run_entry_candidates`, `engine_list_run_entries(+tags)`, `engine_run_scratch_count`; EntryFind branches on `manifest.scope==='run'`; `catalogRowsFor` sources run-scope by owner prefix; `toPath` renders `run://owner/path`; `Run.find()` folds the owner. Turn-0 foists `FIND(run:///**)` when the run holds scratch. SPEC `{§run-scheme-find-perspective}`. guard 182/182, intg 875/0.
  - **fork-copies-run-scope — DONE (4731135).** `Fork.fork` now deep-copies the parent's `scope='run'` entries (new ids) with the owner remapped in the pathname (parent → branch) + channels (deep_hash preserved → pump skips re-derivation) + tags. A fork opens with the parent's scratch under its own name and diverges on its own edits; the parent's copy is untouched. SPEC `{§run-scheme-fork-scratch}`. This ACTIVATES the turn-0 perspective foist (a fork now holds scratch at its first loop). The shared session world is still never copied — only the run's private workspace.

**▸ RUN-SCOPE SCRATCH: COMPLETE (2026-06-25).** Storage (C) + FIND/perspective (E, 0932c03) + fork-inheritance (4731135) all shipped + tested. A run writes/reads/FINDs its own scratch (cross-run read by name), the catalog foists it, and forks inherit it. Remaining run-scope residue lives in the epic above (F: per-run-manifest SPEC prose; the `FIND(**)` ban; §run-scheme storage anchors — all minor/doc).
- [x] **D. Docs catalog — service half landed.** `definition`=plurnk.md, a lean `schemes` directory section below `tools`, scheme docs materialize as pull `plurnk://docs/<scheme>.md` (per loop.run). Open residue: **session-scope one-time seeding** (docs re-materialize per loop.run today; seeding at session.create shifts initial entry/run state + the no-loop.run op.* tests — revisit with this epic); **schemes#25** (add `documentation` to `SchemeManifest` — the catalogue's `teach` is a duck-typed in-tree paragraph today; service-side NOT blocked: catalogue render → `example` + doc-link, in-tree schemes adopt `example`+`documentation`, verbose `teach` relocates into `documentation`); **requirements.md decision** — its 2 YOU MUSTs are verbatim in plurnk.md `## Imperatives`, decide if it's the operator's custom-rules slot (slimmed of dupes) or dropped.
- [x] **F. SPEC — DONE (87432fa).** `{session, run}` (agent-scope retired, glossary + §workspace-identity); run:// storage anchored `{§run-scheme-scratch}` (self-write/cross-read/403) + perspective `{§run-scheme-find-perspective}` + fork-inherit `{§run-scheme-fork-scratch}`; §161 "a run is its log" reconciled (the doctrine is *no shadow of the world*, not *no private state* — scratch is owned state). `FIND(**)` ban = NON-ISSUE: it parses `kind:local` (a scoped file-scheme glob), not a toxic cross-scheme global — the per-scheme foist never emits bare `**`; no service guard needed (plurnk.md advertising is the grammar's, and it doesn't).

### ACTIVE EPIC — Packet construction: standardize into an ordered list of sections

**Why (the moat).** 100% MIT → the ecosystem is the only moat → the moat is LEGIBILITY: extending the core must always be more obvious than forking it (rummy was rebuilt, by its own author, when its extension model got confused — a confused extension model, not pluggability, is the doom). A single credible fork-reason = doom. So every packet input must be overridable as addressable state by ONE mechanism a stranger learns once.

**The finding (audited 2026-06-18).** The packet's section *list + order* are hardcoded in `packet-wire` (`renderSystemContent`/`renderUserContent`), and the 8 sections (plurnk.md, scheme catalogue, `# Log`, manifest, prompt, telemetry, tools, requirements) are each sourced + overridden by a DIFFERENT mechanism — wire param / env / plugin / knob / none. That heterogeneity is the illegibility that drives forks; three sections have no override at all.

**The answer — a SIMPLIFICATION, not a feature build (owner's frame: "disable ours, do yours").** The packet is a render of an **ordered list of sections**. The override actor is the **plugin developer**, NEVER the client — client-side packet manipulation hands an untrusted party the model's whole world (delete the `requirements` that bound it, inject a redirect), violating the first security law. A trusted plugin reshapes the list — add / remove / reorder — through ONE strictly in-process hook (`transformSections`, below); "disable ours, do yours" is a plugin returning a list with our section dropped and its own added. Lands as LESS code; the diff stays negative.

**Out of scope — do NOT get carried away (owner).** Per-section modification (e.g. editing OUR telemetry) — disable + replace, never a hook. The assembly ALGORITHM (budget grinder, fold) stays engine-owned + knob-tuned; NOT a plug point this pass. If the section model tempts either, stop.

**Design — the principled target.**
- **Stored shape:** `Packet = { tokens, sections: PacketSection[], telemetryErrors, assistant, assistantRaw }`, `PacketSection = { name, slot: "system"|"user", header: string|null, content, tokens }`. The stored section is RENDERED markdown + measured tokens — what the digest re-parses and what the model saw.
- **Slot = the cache boundary:** `system`-slot → the system ChatMessage (cache-stable prefix), `user`-slot → the user ChatMessage. Order is the render order: `requirements` LAST in `user` (recency). The `# Tools` → `system` cache move LANDED (3rd packet commit) — definition + tools lead the system slot (static → the cached prefix), the dynamic log after.
- **The 8 default sections, in order:** `definition` (system, no header), `log` (system), then `prompt`, `budget`, `errors`, `git`, `tools`, `requirements` (user). **Telemetry UNBUNDLED** into peer one-hash sections `budget`/`errors`/`git` (owner steer 2026-06-19 — "errors as its own section… one hash"): each independently overridable, no `##` sub-bundle. The two-pass budget renders placeholders → measures the assembled total → substitutes into the `budget` section.
- **Structured-data homes (owner delegated the mechanics, 2026-06-19 "too in the weeds — you decide"):** (a) telemetry events are EPHEMERAL (`#drainTelemetry` empties the buffer on read) → the packet is their only home → kept structured as `packet.telemetryErrors` (the grinder threads them through its rebuild), with the `errors` section as their rendered view; (b) the log is PERSISTED in `log_entries` → rendered-only on the packet (no 2x storage). Tests parse the rendered `log` section back via the `logEntries` helper and assert by entry IDENTITY (origin/op/target), not index.
- **The grinder/fold stays engine-owned** (locked non-goal): a closed build-time concern over the structured log, never a section the consumer edits.
- **Legibility bar (the moat test):** a plugin changes ANY section by ONE move — return a rewritten list from `transformSections`. The whole list, one trusted in-process hook; zero env/knob/wire-per-section.

**Work — sequenced. Stages 1–5 are ONE migration (the type ripples — the build is red only mid-migration; land it whole, then verify). ~17 files / ~79 accesses — a real refactor of core internals, done with care, not speed.**
- [ ] **7. Contract typing (sibling — plurnk/plurnk-schemes#24).** The hook works duck-typed for any scheme, but external authors need it in the scheme contract — `PacketSectionTransformer` + the `PacketSection` shape — for types + discoverability. Open Q to the maintainer: where `PacketSection` lives (service-owned post grammar 0.67).

### ACTIVE EPIC — Project Semantics: lossless chunked `~query`

**Goal.** One vector per entry truncates large entries at the embedder window, so the body is invisible to `~query`. Tile each entry into ≤window chunks, embed each, rank chunks, max-pool to the entry. **Invariants:** lossless (every token in ≥1 chunk); model-agnostic (window + tokenizer DISCOVERED from the embedder, never hardcoded); structure-aware (reuse `@graph` symbol line-ranges as cut hints).

**Ownership (the `§mimetype` line).** SERVICE owns the dialect + its impl: chunker, schema, rank, `deep_hash` gate, `<L>`. DAUGHTER (`-embeddings`) owns only model facts — `embed(text)`, plus (one issue) `maxTokens` + `countTokens`; it never sees a chunk or a line. The service PROBES the embedder's capabilities and adapts, so the daughter upgrade is transparent (no service change).

**Locked decisions.**
- Chunker = lossless, structure-preferring, budget-driven tiler. Pure fn, own class/file `_entry-chunk.ts`. All numbers are params (no constants).
- Counting = per-line `countTokens`, summed (cross-line BPE merges only shrink the real count → the sum is a safe upper bound → lossless). Source = the embedder's real tokenizer, surfaced via the daughter capability. ABSENT → chunking is OFF (fallback below), never a lossy char-proxy (it would make every entry tiny-chunked — a regression).
- **Activation = gated on the embedder exposing `countTokens` + `maxTokens`** (the daughter issue is the activation key). Absent → ONE whole-entry chunk = today's behavior, ZERO regression. Present → lossless tiling. Schema is UNIFORM (always chunk rows; the fallback is a single chunk spanning line 1..totalLines), so storage/rank never branch. The service side lands regression-free and dormant-until-capable.
- Budget `B` = `PLURNK_SEMANTIC_CHUNK_TOKENS` — a concrete portable-aligned default in `.env.example` (the law-file carries the number, not code; override to sweep or for a bigger model). Clamp to `min(B, maxTokens)` once the daughter reports a window. Overlap = `PLURNK_SEMANTIC_CHUNK_OVERLAP` (`.env.example` default, no code fallback).
- Storage = `entry_embeddings` reshaped one-to-many: `(entry_id, chunk_seq, line_start, line_end, vector, embedding_model)`, composite PK.
- Rank = cosine per chunk, `GROUP BY entry MAX(cosine)`, `WHERE embedding_model = $current` (dim-safety across model swaps).
- Return = pathnames (max-pooled). **LOCKED as a deliberate Project Findings shim** — parity with today's contract. Chunk extents (`line_start`/`line_end`) ARE stored; only the rank `SELECT` returns bare paths. Project Findings (below) MUST enroll this dialect; the upgrade is a return-layer change, not a re-derivation.
- `deep_hash` folds resolved config: `sha256(content + model + B + overlap)` ⇒ swap model or knob → corpus re-derives at the next turn's manifest build.

**Remaining work (delete as landed).**
- [ ] (later) Project Findings enrolls this dialect — drop the path-only shim for `<L>` passage extents.

> Model-id re-derivation — SHIPPED (reconciled 2026-06-25): `embedderInfo()` now returns `model`, and `deepConfigSignature` folds it (`embed:${info.model}:${maxTokens}:…`), so a model swap re-derives. (was: mimetypes#31.)

### Testing — no special tracks (standing rule)

**Principle (owner):** test-performance is NOT grounds to special-track a real feature out of normal intg. Heavy-but-real (the embeddings model) runs in `test:intg`. No "fast tier" carve-out that hides a working feature from integration coverage.

### ACTIVE EPIC — Repatriation (§actor-boundary-self-hosting): runtime work is a plurnk run, not a privileged engine pathway

**The contract (SPEC §actor-boundary-self-hosting).** Runtime-initiated work (fs reconciliation, git auto-add) is an *ephemeral `plurnk` run firing ordinary ops*, seen by other runs through the environment door — not a privileged engine write. The engine keeps only the irreducible kernel (spawn, dispatch, packet assembly, the budget rails, the fs-watch); everything expressible as ops on session entries is a run doing ops. Dogfooding is the architecture, not a test mode.

**State.** The keystone `dispatchAsPlurnk` (`src/server/methods/_dispatchAsPlurnk.ts`) is BUILT + proven — doc materialization (`PLURNK_MD_<ALIAS>`, `loop_run.ts:145`) already routes through it. What remains is *repatriating* the three inline privileged pathways still bolted into the model's loop onto that seam.

**The three legs — RESOLVED by firsthand audit 2026-06-25 (the spec line-145 framing was loose; SPEC corrected to match):**
1. **env-delta materialization (the EMI).** Splits into two halves with DIFFERENT correct homes:
   - **Disk→entry *ingestion*** (`#materializeMember`'s `EntryCrud.writeEntry(...ctx, null)`) is **fs-watch KERNEL, not a violation.** Ingestion is the INVERSE of an EDIT — an EDIT *proposes egress to disk* (`File.ts:83`, gated/proposed); there is NO actor op for "pull disk INTO an entry." So by §actor-boundary-self-hosting's own carve-out ("everything *expressible as ops*…"), ingestion correctly stays kernel. The change-gate already exists (`synced_sig`, mtime:size) — unchanged members are no-ops.
   - **Divergence *narration*** (`#logFsFictions`, `Engine.ts:1634`) is **already a plurnk-run op** — it writes `origin=plurnk, source='file'` EDIT rows into the reserved plurnk run; the model pulls them via `engine_pull_env_deltas` (the environment door). Built + tested. Done.
   - **Why the split is load-bearing, not laziness:** `engine_pull_env_deltas` pulls EVERY plurnk-run EDIT (200/201, since-last-turn). If ingestion itself became a plurnk EDIT, the model's env-delta would FLOOD with first-loads + mtime-only re-syncs. The silent-ingest + filtered-narration split is what keeps the model seeing only TRUE divergences.
2. **git auto-add.** The ONE genuinely-outstanding *expressible* piece. NOT BUILT — `ls-files --others --exclude-standard` member-on-creation, surfaced as a plurnk-run op. Gated on Forest part-B (`repo` overlay + verb rename).
3. **manifest build.** `maintainDerivations` (`Engine.runTurn:809`) — the per-turn derivation pump (graph/FTS/embeddings over existing entries). Computes derived channels; creates no entry from external input → **packet-assembly KERNEL, NOT a repatriation target.** Confirmed.

**"mtime-vs-hash" SETTLED: keep mtime:size.** The stat-gate catches every realistic edit (a content change touches mtime); content-hash's only marginal gain is the exotic same-mtime-AND-same-size case, at the cost of reading every member every turn (~85ms) instead of stat'ing. Not worth it. Ratify the existing choice.

**VERDICT (the Challenger answer to "is now a great time?"): the epic is ~complete and correctly architected — the spec prose, not the code, was behind.** Doc materialization → keystone (built, Phase 1 test). Divergence narration → plurnk-run op (built). Disk ingestion → fs-watch kernel by nature (not a violation). Derivation pump → kernel. The only outstanding repatriation is **git auto-add**, and it is Forest-part-B-gated (unbuilt overlay). There is no safe standalone materialization-repatriation to "do now" — routing ingestion through a plurnk op is both semantically backwards (EDIT=egress) AND floods env-delta.

**Phasing.**
- **Phase 1 — seam-proof. DONE (d9a4491).** `[§actor-boundary-self-hosting]` is a real test (was `{todo}`): the materializing EDIT lands in the plurnk run's log (origin=plurnk), absent from the model's, result reached via the env door. The contract is real + green.
- **SPEC alignment. DONE.** Line 145 corrected: the remaining line is one of *kind* (expressible→keystone, ingestion→kernel), not a list of pending dispatches.
- **Phase 2 — git auto-add — DEFERRED behind Forest part-B.** When the `repo` overlay lands, the model-created-file surfacing rides `dispatchAsPlurnk` (it IS expressible — a real new entry). This is the only remaining repatriation.

**Do NOT** try to route disk→entry ingestion through a plurnk op: it's backwards (EDIT proposes egress) and floods the model's env-delta. The narration already carries self-hosting; ingestion is kernel.

### Open epics & chapters — each a focused session or a decision

- **#240 executor-owned output schemes (RFC — "design with you", owner present 2026-06-22).** I OWE the service-sphere wiring positions: dispatch + storage + the `<tag>://` containment invariant for executor-owned output (`EXEC[sh]`→`sh://`, retire generic `exec://`; one global plugin-name namespace, plurnk-execs/schemes stay separate frameworks). Read the full RFC (#240), bring concrete positions to iterate. Deferred mid-session for the run-scope/FIND chore — do NOT drop.
- **HTTP scheme**, **Deep Skills** (addressing decision first) — design then build.
**Now buildable:** **`EXEC[git]`/`EXEC[gh]` operations** — git/gh executors registered; the service-side flows (auto-add new files, ambient git→telemetry) are buildable.
- **Digest golden refresh** — needs a demo re-record of `plurnk.db` (live gemma).
- More-providers shake-down, mimetype-handler refinement (live/demo obs), plurnk-client owes (#6/#24), CI cadence, e2e-live `file://`@YOLO (F.5 + live).
### Guard: render-derived aggregation stays JS

`packet-wire.measureBudgetSections` sums per-scheme render-weight (render + tokenize per entry) — SQL can't compute it. Do NOT move it to SQL. (Aggregating STORED columns in JS *is* soup → SQL; render-derived is not.)

### Adopting plurnk-schemes — "pull don't copy"

schemes is canonical for the result contract, manifest/flag types, and the utility modules we forked in-tree; `plurnk://` and `log://` stay **permanent in-tree** (designation, not deferral). Pattern: each local twin → re-export barrel (`core/types.ts`) or delegate facade (`core/results.ts`); `tsc` is the gate. Remaining:
- [ ] HTTP scheme is the next concrete sister (`@plurnk/plurnk-schemes-http`); git deferred until contracts settle.

### Workspace / file authority

Membership (`git ls-files`, no git-library dep), the constraint-overlay RPCs, and the File-scheme gates are defined by SPEC §membership. Remaining:
- **#200 (`--add`/`--ignore`/`--read-only` at invocation) is the client's** — a consumer of the overlay RPCs, not service work.

### Multi-repo workspace membership (forest) — SHIPPED (verified firsthand 2026-06-25)

The forest reframe is BUILT + SPEC-anchored + tested. `git-membership.ts` is the heart; `contract-workspace.test.ts` carries the green tests. What landed:
- **Forest union** — `#forestMembers`: every declared `repo`'s members (tracked ∪ untracked-non-ignored), each path-prefixed by `relative(root, repoRoot)`. Repos OUTSIDE `project_root` mount with a `..`-prefix (root is the relative base, not a boundary); the universal `join(root, pathname)` disk-resolver works unchanged. `{§membership-forest}` `{§membership-overlay-repo}`.
- **Overlay verbs** `pick | view | hide | repo` (validated in `session_constraints.ts` `EFFECTS`); **`drop` = `session.unconstrain`** (deleting the row IS the un-declare — never a 5th effect). `{§membership-overlay-pick/view/hide}`.
- **Two flags** — `PLURNK_GIT_ALLOWED` (hard ceiling, un-re-enableable `=0`) gates `PLURNK_GIT_AUTO` (`=1` auto-declares `repo` at `project_root`). Session-level `git:false` (#232) tightens further (env AND session). `{§membership-git-flags}`.
- **gitlink filter** — `ls-files --stage`, mode `160000` rows dropped (submodule boundaries). **Auto-add** — untracked-non-ignored files are members the moment they exist (`ls-files --others --exclude-standard`); `.gitignore` still filters. `{§membership-auto-add}`.
- **Change-gated single-pass sync** — `#materializeMember`: per-member `synced_sig` (mtime:size); unchanged → no-op (no re-read/re-tokenize/rewrite). The same pass narrates EMI divergence (prior-body ≠ disk → `#logFsFictions` source=file). `{§membership-change-gated-sync}`. (mtime-vs-hash SETTLED → mtime:size: a content change touches mtime; hashing buys only the exotic same-mtime-same-size case at a per-turn read-all.)

**Residue (genuine, minor — none blocking):**
- **Per-turn `ls-files` cadence.** Member-level work is change-gated, but `resolveGitMembership` (Engine.runTurn every turn) re-runs `ls-files` per declared repo UNGATED by index-change. Cheap (index read, ~ms/repo), but unbounded in repo count. Lever if it ever bites: gate on `.git/index` mtime. Distinct from the member-level gate.
- **Render-`view` prose collision.** The membership verb `view` vs "the model's view" noun — coexists by-layer in the shipped docs; revisit only if it confuses a reader.
- **Cold-derivation parallelization** — DEFERRED (one-time cold-start cost: first-turn deep-channel derivation of every member, ~31s on a 271-file repo, persists in db). NOT the membership sync (that's ~85ms). Earlier attempt had a service-side aggregation race dropping refs (`graph.file` cap=1 pass / cap=8 fail), never pinpointed (parked). If revisited: code-content invariance test (markdown missed it). Cold-start `{done,total}` progress notification also deferred (~6-site mechanism for a rare event). mimetypes IS re-entrant (`mimetypes#33` CLOSED — the drop was OURS).
- **git auto-add as an explicit plurnk-run SIGNAL** (the Repatriation bridge). The MEMBERSHIP is built (new file → member → materialized → catalogued → model sees it via the env door). Whether a new file ALSO warrants an explicit surfacing op/telemetry (beyond its silent catalog appearance) is the one open design Q — and per the §actor-boundary finding it's debatable: first-materializations are deliberately silent to avoid env-delta flood, and the catalog IS the env door. Owner-collaborative if pursued; small (a new-file narration, not a Forest blocker).

Supersedes service-side auto-discovery (no topology guessing).
### Git / gh integration

Paradigm: scheme for sight, executor for action; the §membership gates make it safe; daughters do the mechanics, the service owns policy. Decisions:
- **`EXEC[git]` / `EXEC[gh]` own all git** — read *and* write via the CLI the model knows cold; no `repo://`/`gh://` scheme, no structured sugar. Mutations propose; push confirms. git is local-standing, gh is network-on-demand.
- **Ambient git state → telemetry (§telemetry)**, not a standing scheme.
- **Auto-add NEW files only**, logged (`origin=plurnk`) — never auto-stage edits, never auto-commit; the model/user own git history. Rides a plurnk run distinct from the model's.
- **`PLURNK_GIT_ALLOWED`** (hard ceiling, was `PLURNK_GIT_ENABLED`): `=0` flatly denies git, un-re-enableable. **`PLURNK_GIT_AUTO`**: `=1` auto-declares a `repo` at `project_root`; `=0` explicit `repo` declarations only. ALLOWED gates AUTO.
- `ls-files` membership stays a direct service shell-out — no git-library daughter.

Auto-add is folded into the multi-repo membership reframe above (per-repo `ls-files --others`).

### Parking lot (owner-dropped — return after git/gh)

- **Path/pattern grammar corners** — `~` and `@` may overload pattern-operator vs literal path text; unclear if a quote forces literal. Litigate with grammar.
- **Auto-fold the model's OWN superseded views** — a write to (entry, channel) folds the model's prior reads/edits of that same (entry, channel). Off the curation line (own-write trigger, exact scope, reversible). Decide if worth the machinery.
- **Config scope axis** — source precedence + ceiling-vs-default are settled (SPEC §operator-config); remaining is the {scope} axis — server-global vs per-session ceilings (none exist yet, e.g. one session capped at 100 turns, another at 50). The project `.env` is shared (plurnk prefix + project vars).

### Exec / streams

Five executor siblings (`-sh`/`-node`/`-python`/`-search`/`-sqlite`), pinned + probe-discovered into a boot `ExecutorRegistry` (one probe per tag); `Exec.ts` resolves via `ctx.executors`, the scheme stays runtime-agnostic + in-tree. Effect-gating per SPEC §exec — `host`→propose, `read`/`pure`→auto-run inline. **#240 (executor-owned schemes, landed c3a4135):** each executor registers its own `<tag>://` face (`ExecOutputScheme`) — `READ`/`FIND` tag-scoped via the executor's manifest, process-KILL delegated to the shared Exec handler, rich executors (MCP/sqlite) override read/find. EXEC return is **receipt-only** — the `<tag>:///<coord>` address + an `OrientIndex` (Summarize), never the inline body (read/pure included); the model READs the address to pull content, and that read lands in the foldable log. Built-in scheme names are reserved (boot fail-hard on a claim). The handle lives in the manifest (the complete directory), the content in the log — no manifest exclusion (stage 4 dissolved). Deferred: per-executor self-documentation in the catalogue (kept "exec taught once"). `seconds=` elapsed on active streams is service-rendered (`_entry-manifest.ts`, recomputed each render), not a grammar field.
### KILL — signal ladder (#203 CLOSED, 49425fa)

Entry-KILL (`<<KILL(known://x)::KILL` → scheme `deleteEntry`) and process-KILL (`KILL(<tag>://…)` → AbortController) are built; MOVE→/dev/null kept as harmless backward-compat. **#203 resolved (49425fa):** the MODEL owns escalation, not core. Bare `KILL` → the executor's SIGHUP polite default; `KILL[15]` → SIGTERM; `KILL[9]` → SIGKILL — the model picks the signal, and `KILL[9]` IS taught (plurnk.md). Core runs NO TERM→wait→SIGKILL policy; `plurnk-execs` delivers the chosen signal once. The one bounded reap is loop/run TEARDOWN: SIGHUP then SIGKILL after `PLURNK_EXEC_KILL_GRACE_MS`, so `idle()` can't wedge on a signal-ignoring spawn. The service speaks the executor's `{ signal }` / `{ housekeeping, graceMs }` abort-reason protocol via `src/schemes/exec-abort.ts`.

### Demo-surfaced backlog

**Sequencing (owner): live/demo fixes are POST-EPIC.** Right before the epics, run ONE triaged live/demo sweep to surface real *architectural* gaps (those inform the epics); skip the fails that belong in a focused, collaborative session. Don't chase live/demo reds before that sweep — noise until then.

Each reproduced + digest-confirmed; the model does the reasonable thing and the op surface gives way. These are features/epics/daughter-needs, not quick patches:

- [ ] **413→499 + a 238s degenerate run (whoami).** A loop with a malformed `READ[400]` + EXEC churn overflowed budget (413 → grinder-abandon 499, by-design) but ran **238 seconds**. The grinder-abandon is correct; the time-to-abandon is not — budget/loop behaviour under a flailing model needs a look.

### Providers / mimetypes

mimetypes is the tree-sitter consumer model (per-language grammars framework-internal; every type gets `deep-json`/`deep-xml`/`symbols`, code types add `references`; plurnk-service filters via `Matcher`). The framework owns its floor + loaders; we pin `@plurnk/plurnk-mimetypes` (framework) + `@plurnk/plurnk-mimetypes-all` (every non-floor handler — a runtime dep, like execs-all/providers-all/schemes-all; #244) + `@plurnk/plurnk-mimetypes-embeddings`, plus `xmldom`/`xpath`. `@plurnk/plurnk-mimetypes` loads per-language GRAMMARS as phantom peers — **RESOLVED via mimetypes#34**: `mimetypes-all` 0.5.0 deps all 28 self-contained `.wasm` `grammar-*` packages, so they install transitively, **zero `tree-sitter-*` pins downstream**. The service dropped its 25 band-aid devDeps (the forcing function) + bumped `-all` → 0.5.0; `#186-graph-*` is GREEN again carrying no pins. The repo uses STRICT npm resolution (no `.npmrc legacy-peer-deps`), so a grammar bump requires the exact-peer siblings to move in lockstep to versions peering the new grammar — only `plurnk-schemes` pins `peer @plurnk/plurnk-grammar` — or `npm install` ERESOLVE-fails.
- **Never pin-bump a deprecated package** — `npm view <pkg> deprecated` first (burned four rounds; the per-language sub-packages were deprecated + removed when treesitter replaced them).
- [ ] More-providers shake-down beyond openai/ollama (xai/google/openrouter/cloudflare).
- [ ] Mimetype handler refinement driven by `live`/`demo` observations.

### Testing

Spec-anchor guard scans `test/` only — new conformance anchors must live in `test/intg/` to be enforced; `src/**/*.test.ts` anchors (matcher §matcher-result) are documentation, not enforced.

- **Run intg via `npm run test:intg`, never bare `node --test test/intg/*`.** The runner sets `PLURNK_MANIFEST_ITEMS=0` *and* the `--env-file-if-exists` cascade (`.env.example` < `.env` < `.env.test`); bare `node --test` misses both → false failures: the turn-0 manifest READ adds a phantom log row (off-by-one entry counts), and fail-hard knobs like `PLURNK_SEMANTIC_CHUNK_OVERLAP` throw on `undefined`. Targeted file: replicate the full prefix `PLURNK_MANIFEST_ITEMS=0 node --env-file-if-exists=.env.example --env-file-if-exists=.env --env-file-if-exists=.env.test --test <file>`. (Tripped twice in the 0.42 status-code work.)
- **`~query` runs in intg against the real embedder.** `DEFAULT_MIMETYPES` is production-identical (`new Mimetypes()`, embeddings daughter included) — every intg manifest build exercises the real tile+embed path, no fast-tier carve-out [[no special tracks]]. (Declining it for speed once hid the chunk-mimetype crash from coverage; reversed.) `test/intg/semantic.test.ts` adds end-to-end `~query` ranking. The switch is the daughter's presence in the injected `Mimetypes`, never an env flag.
- [ ] **plurnk client owes** (both service-ready, client implements): `--run=<name>` (filed plurnk#6; `session.attach({runName})` wired) + the `noProposals` no-review-channel UX (filed plurnk#24; server auto-reject in `noProposals.ts`).
- [ ] Documented CI cadence for live/demo.
- [ ] End-to-end live test with model using `file://` under YOLO.
- [ ] Refresh the digest golden — demo re-record of `plurnk.db` (live gemma).

### Deferred / design

- [~] **Run topology & awakening — substrate stays neutral** (CONSOLIDATED 2026-06; **CORE SHIPPED**). **Built:** EXEC `<T>` timeout (5d184f1) + `<T,P>` poll (20d233e); child-conclusion wakes a parked parent — the join (30bd086, `#onDrainExit`→`#wakeParkedRun`); premature-terminate counts live child runs (9a6240e); 202 subtree-quiescence → soft `loop/quiesced` (9377b3d, reawakable, not terminal — also resolves the dead-park hang). Verbs resolved (200=done/202=yield, no new codes); children = streams uniformly. SPEC: {§run-lifecycle-child-wake}, {§run-lifecycle-quiesced}, §send-premature-terminate, §send-groundless-hibernate (READ+202 orphan-park refused 409; the bare voice-door park stays legal → quiesced), §exec-timeout/poll. **REMAINING (refinements, not blocking):** session-level GC sweep of quiesced 202s (precise reachability/cycle detection vs today's per-park conservative signal); parked loops must not count against the active-runs cap (§run-scheme-cap); coalesce N wakes per park into one resume; the wire collapse-vs-distinct is decided (distinct: loop/quiesced≠loop/terminated). Merges with run-scope #270 for run:// storage. Models compose their own topologies (fork-join, supervision, pipeline, mesh) from primitives; the runtime never bakes in "a spawn implies an await." **Grounded in POSIX `wait`/SIGCHLD/`exit` + generators (yield/return) + structured concurrency (a scope completes only when its children do; cancel cascades)** — design the parent/child rules (error + cancel propagation) against the structured-concurrency literature. **Substrate SHIPPED: EXEC `<T>` timeout (504, 5d184f1) + `<T,P>` poll-wake (20d233e) — the *stream-half* of one "watch a uri, wake when it ends" primitive; the topology work is that same primitive over `run://` children.** Shape:
  - **`SEND[202]` = yield** (suspend, resumable — the generator `yield`; cf. an idle daemon on epoll): park, **auto-watch own open streams + dispatched children**, resume-in-place when any ends. **Harmless / never a footgun** — a 202 with anything still running always has a wake edge; not GC'd while the subtree can wake it. (`500` failed · `499` aborted · `102` continuing; the *done/return* verb is fork-1 below.)
  - **Child termination = a wake edge, same path as a stream conclusion** — "a watched uri reached its end"; scheme (`{tag}://` vs `run://`) the only difference. [extends `#handleWakeRun` to `run://` children]
  - **Wake = control edge ONLY; resume-in-place, NEVER a synthetic prompt** (owner smell: auto-injected system-messages-as-prompts = a paradigm we failed to close). The resumed run reads its own world — the child's collect delta (§run-scheme-collect), the manifest. The retired "automated environment update" injection stays retired.
  - **Quiescence → a soft CLIENT signal.** When a 202's subtree is idle (no open stream, no non-terminal child), emit a completion signal to the **client** (the CLI's yes/no). Honest *"idle now,"* **reawakable**, and **never a terminal code** (200/499/500) — in a topology where any sibling can `irc` any run, true finality below the session doesn't exist, so quiescence IS the honest "done." Quiesced-202 is its own wire thing; a reawaken re-enters active → re-quiesces → re-fires.
  - **Verbs — RESOLVED (owner conceded the 201/200-reserve fork, 2026-06):** keep `200 = done` (the model's trained terminal, untouched), `202 = yield`; NO `201`-return-cascade and NO `200`-as-daemon-signal. **Children are treated EXACTLY like streams — one uniform rule, three faces:** a `SEND[200]` with a live child/stream → **premature-terminate** (downgrade 102 + steer, §send-premature-terminate); the model then explicitly `KILL(run://child)` / `KILL({tag}://stream)` or `SEND[202]` to yield. A live child/stream is a **wake edge** for a parked 202. A child/stream **termination surfaces as a collect-delta** (its own exit status in the parent's log, read on resume-in-place — SIGCHLD-as-env-delta). So "done + tear down my subtree" = explicit KILL + SEND[200]; no magic cascade verb. The symmetry IS the design: a child run and a `sh://` stream are the same kind of "live thing the run holds."
  - **Open forks (pin before build):** **(1) wire:** quiesced-202 *distinct* from a 200-terminal (lean: distinct — a CLI that cares whether `loop.run` resumes-vs-restarts needs the bit) vs collapsed. **(2) quiescence detection:** start *conservative* (a parked 202 survives while any session run is non-terminal; sweep when the last active run goes terminal) → precise reachability/cycle detection later.
  - **Sequence:** (a) the deferred **grammar-compliance check** (the 202/poll verbiage in plurnk.md 0.74.20 — a live/demo pass confirming the model still drives cleanly *before* building on it) → (b) pin fork 1 (the only grammar touch) → (c) the epic, **merged with run-scope #270** (rides on `run://`). Parked loops must NOT count against the active-runs cap (run slot ≠ concurrency slot); coalesce N completions per park into one resume.
- [ ] **Entry-change → log waterfall signal.** When an independent entry changes out-of-band — a stream/file/entry grew by N lines/tokens — inject a synthetic log row so the model is alerted to the relevant change (post-index, nothing auto-shows it). Generalizes the §membership EMI divergence signal beyond git files to any entry/stream.
- [ ] **Deep Skills** (scheme daughter) — portable, self-contained markdown+asset bundles. Two net-new axes: per-skill authority-as-identity (`skill://skill-id/guide.md`, so relative `./helper.md` resolves within the skill) and relative-link rewrite (likely a mimetypes daughter). Revisit addressing FIRST when it lands — don't re-inherit the flat empty-authority default by accident.- [ ] **Executor tags self-describe into `# Plurnk Service Tools`.** Today `# Plurnk Service Tools` (§tools) renders above Requirements — the *live* capability surface (vs. requirements' static education and `manifest.json`'s entry-directory), `<<PLAN` advertised on `PLURNK_PLAN=1`. **Remaining:** each wired executor tag injects its own line describing tag + functionality (the boot `ExecutorRegistry` probes availability per tag; the line is the executor's to supply — a daughter surface), retiring the blind `<<EXEC[sh]…`. Gates on availability.
- [ ] **Semantic: rerank pass after cosine** — precision refinement, lands after the chunking epic (ACTIVE EPIC above). Freshness is NOT a gap: embeddings/FTS/@graph are one `deep_hash`-gated batch, re-derived from one `process()` at the per-turn manifest build (`Engine.ts:755`, before the model's ops), so a changed entry is re-embedded at the next assembly — the same on-change semantics every derived channel gets (`§mimetype`: derivation fires at manifest-add, never at a scheme write).
- [ ] **SEND[300] multiple-choice prompt.** `<<SEND[300]:question;choice;choice;…:SEND` (300 Multiple Choices). Grammar now ALLOWS 300 as an exit code (owner added it, undocumented — its teaching must be *injectable*: a multiple-choice prompt isn't always appropriate to advertise). Deferred: service interpretation (parse the `;`-delimited body → choice set; how the selected answer returns), client rendering (choices UI + selection), and the injectable-doc mechanism.- [ ] **Out-of-sqlite-space story.** Owner shape: a telemetry line firing ONLY above ~80% of the storage ceiling (`PLURNK_SQLITE_MAX_PAGE_COUNT`) — "persistent entry storage 80% full: KILL irrelevant logs/knowns/unknowns to free space" — targeting the model's OWN entries, never `file://` (the user's, git-tracked). No new crash: a write past 100% returns a CLEAN storage-full status (model recovers by KILLing); the manifest-too-large corner is already the budget grinder's 413 (the manifest is the un-foldable lifeline → overflow → clean 413 terminal). So the nudge prevents; 413 (packet) + a clean storage-full (disk) catch the ignored-nudge case. Build: the % threshold read, the telemetry kind, the wording.

---

## User Notes

Inbox triaged 2026-06-16 — pending items moved into the TODO (§ ACTIVE — User-Notes follow-ups), grouped by gate; verified-done notes cleared (disposition reported in-session). New raw notes land here; triage + clear when processed.

_(inbox drained 2026-06-18 — done notes cleared: sqlite-perf/size → sqlrite#7 + `PLURNK_SQLITE_*` knobs; doc-links → `plurnk:///docs/<tag>.md`; "Plurnk Service Tools" naming → already shipped. Design/feature notes moved to § Deferred / design: SEND[300], run:// authority, tools placement, prompt-preview knob, out-of-space story.)_

It would be catastrophic for our business case if there was a credible excuse for forking rather than extending the service core. We need to do a complete audit of opportunities to ensure that everything a consumer could POSSIBLY wish to override can be overriden idiomatically. For example, our injection of plurnk.md and requirements.md is default and good, but maybe consumer wants to do something else with the packet? Can we consider a way to make the entire packet assembly process elegantly pluggable? Need big thoughts here.

Is there a way to produce a sort of lean sandbox naive installation e2e test which ensures that npm i -g @plurnk/plurnk followed by running plurnk just *works*? Friction there is terminal for our project. I'm thinking we could have:

build:global:install
build:global:uninstall
build:local:install
build:local:uninstall
test:installation

With test:installation being an optional off-hot-path test of whether plurnk successfully installs and uninstalls in a global and separate local environment and works out of the box without issues, going with "plurnk" instead of limiting to "plurnk-service", and achieving a complete user experience, including connecting to the model.plurnk.ai and receiving a response. That endpoint doesn't actually work yet, so that will be a deliberate red for now.

_(RESOLVED/STALE 2026-06-26 — this frith/pi paste was an OLD plurnk-service whose bin was a `.ts` under node_modules. Current bin is the compiled `dist/service.js` (shebang preserved, no `.ts` shipped) → runs clean. The only live install gotcha is node-version: the ecosystem floors at `engines.node>=26`; a node-25 shell emits an EBADENGINE warning per @plurnk dep (a noisy cascade, not failures). Fresh node-26 shell installs clean. Keep for the `test:installation` design below.)_

Look at this result when I attempted to install our stuff on my raspberry pi box:

frith@frith:~/.nvm/versions/node/v26.3.1/bin $ ./plurnk-service
node:internal/modules/typescript:164
    throw new ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING(filename);
          ^

Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently unsupported for files under node_modules, for "file:///home/frith/.nvm/versions/node/v26.3.1/lib/node_modules/@plurnk/plurnk-service/bin/plurnk-service.ts"
    at stripTypeScriptModuleTypes (node:internal/modules/typescript:164:11)
    at ModuleLoader.<anonymous> (node:internal/modules/esm/translators:681:29)
    at #translate (node:internal/modules/esm/loader:437:20)
    at afterLoad (node:internal/modules/esm/loader:505:29)
    at ModuleLoader.loadAndTranslate (node:internal/modules/esm/loader:510:12)
    at #getOrCreateModuleJobAfterResolve (node:internal/modules/esm/loader:563:36)
    at afterResolve (node:internal/modules/esm/loader:610:52)
    at ModuleLoader.getOrCreateModuleJob (node:internal/modules/esm/loader:616:12)
    at node:internal/modules/esm/loader:635:32
    at TracingChannel.tracePromise (node:diagnostics_channel:539:22) {
  code: 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING'
}

**DB MODEL + backup/migration story (design, deferred — dogfood ships monolithic).** `~/.plurnk/plurnk.db` becomes the high-value, high-lock-in artifact (life's work, potentially huge). "Your state is a sqlite file" is a strong, on-ethos story — value-based lock-in, not captivity. OPEN DECISION, per-session files vs monolithic:
- **Native per-session** (`~/.plurnk/sessions/plurnk_<name>.db`, one file/session): the file IS the session — hand someone `plurnk_rockford.db` and you've handed them the work (lean into file paradigms; the handoff story). COHERENT: a session is already "the world" (one filesystem + membership; runs are logs within it), so file boundary = session boundary. COST: daemon/engine assume ONE db handle → multi-DB routing (open/cache per session), `session.list` = dir-scan/registry, a global cost total sums across files, cross-session shared resources (`wiki://`) need a separate store.
- **Monolithic + export/import** (`plurnk export/import <session> → plurnk_<name>.db`): simple one-DB daemon, portability on demand. Pragmatic fallback.
- Rec: native per-session is the likely target (story + coherence); decide DELIBERATELY post-dogfood, NOT at the publish boundary (it touches the DB-access seam the whole engine sits on). Dogfood ships monolithic `~/.plurnk/plurnk.db`; monolith→per-session is a clean one-time migration (first exercise of the story below).
- BACKUP/MIGRATION best-practices to define+document: backup = copy the file(s), but WAL-SAFE — never raw-`cp` a live WAL'd sqlite mid-write; use the sqlite backup API / `VACUUM INTO` / checkpoint-then-copy for a consistent snapshot. Schema migrations already run idempotently on open. The monolith→per-session split is the reference migration.

**Live-test seeding (deferred to demo-gemma-mode).** `test/live` op tests 404 on pre-seeded entries — gemma emits the CORRECT `READ` of the specified path (model's fine; the entry isn't there). 8/13 fail; looks like stale live-test seeding / a seed-path shape the 839 green intg mocks don't cover, NOT a dispatch regression. Not a dogfood blocker (real usage EDITs before READing).

The ## Schemes section is still there. The fact that the docs themselves suck is a problem for sisters, but the fact that the docs are all dumped into the hot path instead of in the manifest is your fault. Is there confusion over their allowed (optional) one line example and their separate documentation doc?

We use `tokensFree` in the training but have moved on from that in the telemetry. I'm open to the win going either way, but we have to decide there.

We don't have it yet, and aren't shipping anything like it in v1. But what's our story for having a "global" resource? For example, plurnk-schemes-wiki that lets all sessions have read-only wiki:///Argentina without needing to copy that resource to every session that exists? What's our story with that?
In telemetry, we need to have an Entries in Scheme table that shows the number of entries and total tokens to stop EVERY model from hitting known://** to find out if there's anything in known every single time.

Discuss moving SEARXNG default to model.plurnk.ai, as well.

i18n story has been neglected. Need it to be clean for launch.

We definitely need to revisit the budget formulas before launch.

There's a big spike in CPU activity when a project is first loaded. This is good and on purpose. But we need a way to signal that, ideally a way to estimate progress so that clients aren't left hanging or ambiguous about what's going on.

Also, I want an --api-key flag if it's not already automatically wired so that plurnk-service --api-key="..." will be a working example in the website for people who aren't smart enough to set an environment variable.

I removed the documentation about decimals inserting between, as the models were complaining about how overloaded that bracket is. We can leave it as an undocumented feature that happens to exist in that particular syntactical context unambiguously.

**Model-entries — the first turn is an exemplary OPEN worked example (owner, 2026-06-26).** The per-turn folded `model` log items (verbatim prior output, born folded, OPEN/FOLD/KILL-able) get a special FIRST entry that is **exceptional: born OPEN** (the rest fold). It shows a **minimal example turn** — FIND ops surveying the environment + the PLAN + `SEND[102]`. Because the model ALWAYS begins from this minimal worked example, the **grammar can be a lot thinner** (the example teaches the syntax, not a heavy grammar). The example's FIND ops carry **`init` tags** — seeding the habit of using OPEN/FOLD not just to open/fold but to **categorize as they go** (tag-as-you-curate). Builds on the existing turn-0 foist machinery (`{§render-rule-find-renders-result}`, SPEC §"render rule"). NOT yet built — queued behind the #278 FIND/READ grind.
