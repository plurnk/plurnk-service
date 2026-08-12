# plurnk teaching corpus

Authored defaults published by `@plurnk/plurnk-meta` and consumed by
`@plurnk/plurnk-service`. The membership and ownership boundary is specified at
{§teaching-corpus}; core owns runtime projection.

## Contents

| Source                          | Consumer admission                                                           |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `PLURNK_PERSONALITY.md`         | Read before the first-run seed of user-owned `~/.plurnk/AGENTS.md`.          |
| `requirements.md`               | Read for the compact Recap rendered last in every model packet.              |
| `docs/log.md`, `docs/worker.md` | Read when registered built-in pull docs are materialized.                    |
| `docs/questions.md`             | Read only when operator questions are enabled, then materialized as a doc.   |

Core materializes eligible pull docs at `worker://plurnk/docs/<name>.md` and
exposes them through the turn-0 `## FIND1 (worker://plurnk/docs/**)` catalog. Merely
placing a file in `docs/` does not register a scheme or make speculative
teaching current. Every listed source is a required package member; a missing
or failed read surfaces at the admission boundary rather than silently reducing
the corpus.

## The teaching split

**Contracts teach the language; docs teach the world.** The contracts parser and
`plurnk.md` own operation syntax and model-facing language. Core and capability
specifications own runtime semantics; this package owns their authored teaching
projections. Live model evidence tests whether that teaching is legible without
turning telemetry into unsolicited workflow direction.

## Contract

plurnk-service resolves these files from the installed package through `Paths`
rather than carrying copies in core. Model-facing teaching changes are verified
through the composed product gates and tracked against the meta owner in the
monorepo forge.

## Teaching doctrine

**Canon-voice calibration (2026-07-06, probe-backed).** Voice tunes to the FLOOR model's minimum-audible threshold, never any tier's max compliance. A footer loud enough to fix the floor OVER-DRIVES strong models (live evidence: Grok Build fanatically FOLDs under a loud budget footer). Soft is safe because the engine makes floor-misses RECOVERABLE (premature-200 -> pending-set 409 -> repair); that coupling is load-bearing — if failures stop being recoverable, recalibrate louder. The footer is pluggable; potato-heavy deployments inject more at their discretion. The one recency-sensitive line is await-before-200 (lean-footer A/B, gemma, n=6: 6/6 reap in the recency footer vs 3/6 cached-canon-only). Retreat trigger: 409-repair LOOPS (not single misses); first line restored is await-before-200.

**The requiem acceptance gate.** Teaching changes ship against BEFORE/AFTER corpus deltas (reasoning-token + requiem-recurrence), never hunches. Triage separates legibility debt from genuine protocol friction. Model-owned context is the product property: deterministic state and reversible OPEN/FOLD tools support the model's judgment without prescribing what to hide. A re-probe against >=0.76.5 is owed (grammar lane).

**Example doctrine (Arecibo teaching).** Concrete over placeholder — a live model spawned a worker literally named 'name' from a (worker://name) table cell within a day of shipping; placeholders in reserved-bracket forms are doubly banned. Bare-gesture register per section — op-teaching lines carry the gesture, the mechanism stays the engine's; match the surrounding register. Distribution is load-bearing — clustered examples teach false couplings; rebalance coverage, never add runtime prose. TIME is a distribution axis — dynamics teach as protocol-accurate worked multi-turn traces (the Delegation breath), never prose essays; an inaccurate trace (same-turn READ+200) models the wrong protocol.
