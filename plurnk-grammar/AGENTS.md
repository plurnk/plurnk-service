### plurnk-grammar — the root contract (GRANDMA)

General ecosystem ground, policy, and rules live in `../AGENTS.md` (the family doctrine) and bind
here too; this file holds only what is **specific to the grammar lane**. The durable *contract*
record is `SPEC.md` (`{§anchor}` clauses, each with ≥1 citing test — the coverage gate is built and
green). `plurnk.md` is the model-facing canon. This file is doctrine + operational notes, committed
so any agent working here — dogfooding included — inherits the alignments rather than re-tripping them.

**Grammar is GRANDMA: the settled root contract.** It owns the protocol and the JSON Schemas
(draft 2020-12); every consumer generates its TS types from them, and a drifting protocol shape is a
bug. Grammar changes are *argued, never slipped in*. Lane = this workspace only.

- **`plurnk.md` (canon) is mine.** Persona, requirements, and the teaching corpus are `plurnk-meta/`
  (MOM's lane) — runtime prose belongs in the packet tail, not canon.
- **`gbnf/` is in-tree but NOT my lane.** It is the equivalence oracle + stack-count instrument
  (an independent llama.cpp port). Never edit it; use it to verify.

#### The two grammars — the single most important boundary (#539, owner-ruled)

- **ANTLR is the FINAL SAY on what is legal.** It is the contract: a forgiving *superset* ingester
  that accepts any deterministic input and recovers. `L(GBNF) ⊆ L(ANTLR)`.
- **GBNF is a crude, strict sampling aid — a "clever hack," not the contract.** It raises a weak
  model's odds of ANTLR-valid output on llama.cpp by constraining sampling. It is a **private concern
  between grammar and the providers lane.** Core may PLUMB the gbnf (transport it) but must NOT reason
  about gbnf-conformance — that is context pollution and a dangerous distraction from ANTLR as the law.
- **"Did the rail bind" is an attestation, never a re-derivation.** Read `railsAttached`
  (`client`/`delegated`/none, #534) + the escape detector as a *fact*; never re-grade gbnf-conformance
  in core (the retired #534 `validateGbnf` grader was this mistake).
- **Forgiving-parser / strict-GBNF is THE standing split.** When they seem to disagree, the answer is
  almost always "ANTLR forgives, GBNF forbids, by design" — not a bug.

#### Syntax errors are grammar's, end to end — and errors that TEACH are a genre

- **Grammar owns syntax-error messaging start to finish.** The service passes our final message to the
  model UNALTERED (a structured-facts handoff was proposed and REJECTED). Value-adds are baked here:
  near-miss did-you-mean, turn-shape imperatives, cascade suppression.
- **Errors point at SHAPE, never content menus (#55).** No op/code/value enumerations in any
  model-facing string — that is training data leaking into errors, and it paints you into corners
  (it has, twice). Menus live in taught docs, one versioned place.
- **The moment-of-failure genre:** when a floor model has the vocabulary but misplaces the syntax,
  prose can't reach it — but the error it *hits* can. The error string becomes the teacher, redirecting
  at the parse. Catalogue (each = a `PlurnkParser`/`PlurnkErrorStrategy` hook + a SPEC `{§anchor}` +
  pinned tests): invented-closer advisory (#497), omitted-`:PLAN` advisory (#502), signal→scope
  redirect (#516), matcher→`:body:` redirect (#562), misplaced-target advisory (#563). To add one:
  match a parsed-but-almost-certainly-wrong shape, emit a `warning`-severity redirect, cite an anchor,
  pin it. This is the primary lever for floor-model reliability — not more canon.

#### Number-oriented addressing is THE paradigm (settled #563 — do NOT relitigate)

- **`<scope>` is the DSL's unified coordinate system**, polymorphic across every op and the log: an
  integer is a position (line on plain files, result index on structured), a leading decimal is a
  `~`-similarity threshold, and on EXEC/SEND it is `<timeout,poll>`. Line-oriented EDIT stays.
- **Content-anchored editing (aider-style match/replace), patterns-in-scope, hashline `number:hash`,
  and a two-body EDIT were all explored seriously and SET ASIDE as paradigm-breaking.** The floor
  model's edit reliability came up on *workflow coaching alone* (the read→edit discipline + the
  misplaced-target advisory + removing the hard-tab talk) — no primitive change. Meta's large-file
  probe confirmed the coordinate dissociation fixed. Don't reach for the pivot again without the owner.
- **Paradigm-level changes HALT for the owner in chat** before any issue endorsement. Converging with a
  sibling agent and posting a direction to an issue LOOKS like a settled grammar ruling; a paradigm is
  the owner's call. (Learned the hard way on #563.)

#### Strict docs, permissive grammar

`plurnk.md` PRESCRIBES the one canonical form; the grammar ACCEPTS any deterministic input. The
canon is the narrow taught path; ANTLR is the wide forgiving net; GBNF is the strict rail that keeps a
weak model near canon. These three intentionally have different widths.

#### Canon craft — `plurnk.md` is model-facing, and the model is the primary consumer

- **Raw form is authoritative**, not the GitHub render. Inline examples stay un-backticked on purpose.
  Only fix rendering that CORRUPTS meaning; never propose a cosmetic "github-friendliness sweep."
- **Voice is calibrated to the FLOOR's minimum-audible threshold, not any tier's max compliance.**
  Loud footers over-drive strong models (Grok fanatically FOLDs); soft is safe because #54 makes
  floor-misses recoverable. Don't reflexively "make canon louder." The footer is pluggable;
  reap/await-before-200 is the one recency-sensitive line.
- **Atomic sentences (#453):** floor-facing canon is short, single-idea. No run-ons (the gate: ≥180
  chars, or ≥120 welded with `;`). Split, don't weld. Run a longsent audit after prose edits.
- **Examples are load-bearing Arecibo teaching**, not decoration. Concrete over placeholder. CLUSTERED
  examples teach false op×dialect / scheme×dialect couplings — rebalance coverage, don't pile onto a
  dense cluster. The Features/survey header is a data-backed advance organizer, not marketing.
- **Visually verify the rendered result** for any `plurnk.md` edit — tests-pass is necessary, not
  sufficient.
- **Wording review is analytical argument** (indexing, coverage, entailment, calibration, risk
  symmetry) — NOT a pre-commit run. Run-level verification is meta's job, never my coin flip.
- **Owner style:** Oxford comma required; plain hyphen `-` only, never em-dash.

#### The jsonplurnk Log format (#437 — mine)

The `## Log` render is a fenced ```` ```jsonplurnk ```` block: a JSON array of log entries, plus ONE
carve-out — heredoc `body` values (`<<:::TAG …:::TAG`, where TAG echoes the entry's own path). I own
the format; core renders it. Strip-parser lives at `src/Jsonplurnk.ts`; the magnum-opus corpus test
guards round-trip. NO GBNF for it (code-rendered).

#### DON'T prematurely migrate canon — coordinated waves (CRITICAL gotcha)

Canon deliberately still uses the OLD lexicon and OLD addressing, pending single, drill-gated,
family-wide waves that have NOT landed in this lane yet:
- **workspace/worker lexicon (#486):** `session/run → workspace/worker`, `run:// → worker://`. Retired
  words retire EMPTY. lane/grammar keeps the OLD lexicon until the epic's ONE push.
- **actor addressing (#527):** `known://`/`unknown://`/`plurnk://`/`exec://` retired for uniform
  `scheme://authority/path`. Canon migration WAITS for the wave.

A "helpful" premature migration of canon breaks the family's coordination. **Verify the wave has
landed before touching addressing or lexicon in `plurnk.md`.**

#### Parse tiers & contract pointers (SPEC.md is the record)

- **Tiers:** `parse()` = a PLAN-anchored turn (the engine's entry, `Engine.ts`) · `parseStatements` =
  strict bare statement seq · `parseLog` = `<<TURN:…:TURN`-wrapped multi-turn log · `parseClient` =
  protocol + client-only `LOOK`/`BUFF` (ClientStatement schema, rejected by the others).
- **Terminal contract:** waitpid, SPEC §9. Dispositions `{102,200,202,300,499}`; park `<T>`/`<T,P>`/`<-1>`
  rides `202` at the rail (ANTLR tolerates a `102` marker). Canon teaches `202` BARE. No-idle rule
  (#464): zero-op `[102]` is unemittable at the rail.
- **Matchers:** the leading symbol CLAIMS the dialect (#59); a malformed claim is a visitor error, not
  a silent glob downgrade. The `#…#` fence takes any regex verbatim (only literal `#` escapes). Matching
  returns whole lines. Mid-batch channel: one optional harmony channel per tail step (#497). PLAN body
  excludes `<<` (#502).
- **Vocabulary divergence (deliberate):** canon `<scope>` = AST/wire `lineMarker`; `[tags]` are the
  signal cells; "filter" means patterns only.
- **Delegation:** `WORK`/`FORK` are dedicated verbs; `EXEC→WORK→FORK→KILL` order is load-bearing; `COPY`
  is plain resource-copy — never re-overload it.

#### Plurnk Script v2 (UNBUILT — re-derive details before building; original design lost to the wipe)

Shipped: `parseLog()` requires `<<TURN:…sandwich…:TURN` per turn; the lexer has `OPEN_TURN`/`CLOSE_TURN`,
internal-Plurnk body handling, the suffix stack, and the maximal-munch fix. `parse()` rejects wrapping.
Unbuilt: a first-class `TurnStatement` AST/schema node; TURN modifier semantics (what rides the open
tag); nesting rules (turns-in-turns, suffix discipline); a distinct `parseScript()` (a script is
authored, a log is a record — `parseLog` serves both by convention today).

#### Workflow & shared-checkout hazards

- **Commits:** one line `type(scope): summary` ≤80 chars (`wc -m`), lowercase after the colon, NO body,
  NO trailers, `--author="Claude <noreply@anthropic.com>"`, a `#N`/`#0` reference required. Rationale
  lives in SPEC `{§anchors}` or GitHub issues — never in commit prose. Hook-enforced.
- **Push:** `git push origin lane/grammar:main` from this worktree, after `git fetch origin main &&
  git rebase origin/main`. The pre-push drill gates `main`. A red is a full STOP — never `--no-verify`
  a red (that's only for a malfunctioning hook).
- **Cadence:** commit + push through the local gates is the unit of work. It is NOT a request for a
  full demo → live → publish → bench iteration — that heavy loop is batched and owner-triggered.
- **Versioning is lockstep;** no per-change bumps. `release:version`/`release:publish` are the machine;
  META is the only publish lane; OTP is the owner's. Never claim publication state without `npm view`.
- **EIGHT AGENTS, ONE TREE:** the pre-push gate tests the WORKING TREE, so uncommitted state (mine or a
  formatter's repad) can fail a push. A bare "failed to push some refs" — read the gate output above it.
- **NEVER `git checkout <file>` to restore mid-work** — it restores from the index (= HEAD if unstaged)
  and silently wipes unstaged work. Use scripts (Node) for dollar-dense / tab-bearing canon edits;
  `String.replace` with a replacement string expands `$`-patterns and corrupts canon.
- **Commitlint (operator's chained hook)** enforces subject-case: lowercase after `type(scope): `.

#### Probe rig

Local llama.cpp (`127.0.0.1:11435`), the gemma floor (PRIMARY target — the rosetta-stone gradient is
root doctrine; Gemini/Opus are the victory lap). Reconstruct packets as system = persona + `plurnk.md`,
user = log + requirements footer. **TRUST NO EMISSION** until `finish_reason` and constrained-vs-
unconstrained are verified: `PLURNK_GBNF_DEBUG` validates locally but does NOT transport the grammar
(the request runs unconstrained). Complaints ≠ errors — check the DB, not just the requiem testimony.

#### Standing watch

- Requiem re-probe owed against the current release (the #62 acceptance gate).
- Residual carried to core (not mine): the daemon still emits `N:\t` line prefixes and the model
  sometimes reproduces the tab into edited content (requiem #4); durable fix = drop the tab from the
  render (`grep -n` `N:content`). Canon no longer names the tab.
