# plurnk-docs

The plurnk teaching corpus. Markdown consumed by [plurnk-service](https://github.com/plurnk/plurnk-service) at runtime — no code, no build.

## Contents

- `docs/<scheme>.md` — per-scheme long-form teaching, materialized as `plurnk://docs/<scheme>.md` entries the model READs (known, unknown, worker, log).
- `PLURNK_PERSONALITY.md` — the default operating policy, seeded once to `~/.plurnk/AGENTS.md` and foisted as `## Plurnk Service Policy`.
- `requirements.md` — the static contract appended to every user packet (`system_requirements` default).

## The teaching split

**Contracts teach the language; docs teach the world.** [plurnk-contracts](https://github.com/plurnk/plurnk-service/tree/main/plurnk-contracts)'s ANTLR grammar and `plurnk.md` own op syntax and the model-facing language. This package owns scheme behavior, delegation workflow, disposition, and standing rules. Live model evidence tests whether that teaching is legible without turning telemetry into unsolicited workflow direction.

## Contract

plurnk-service resolves these files from this package (`Paths`), pins the version, and validates teaching changes with its live/demo tiers. A teaching change ships as a bump here; the service adopts it like any plugin. File teaching asks and steer-wording issues HERE, not on the daemon.

## Teaching doctrine (adopted from the grammar lane, #392 — data-backed, evidence cited)

**Canon-voice calibration (owner-ruled 2026-07-06, probe-backed).** Voice tunes to the FLOOR model's minimum-audible threshold, never any tier's max compliance. A footer loud enough to fix the floor OVER-DRIVES strong models (live evidence: Grok Build fanatically FOLDs under a loud budget footer). Soft is safe because the engine makes floor-misses RECOVERABLE (premature-200 -> pending-set 409 -> repair); that coupling is load-bearing — if failures stop being recoverable, recalibrate louder. The footer is pluggable; potato-heavy deployments inject more at their discretion. The one recency-sensitive line is await-before-200 (lean-footer A/B, gemma, n=6: 6/6 reap in the recency footer vs 3/6 cached-canon-only). Retreat trigger: 409-repair LOOPS (not single misses); first line restored is await-before-200.

**The requiem acceptance gate.** Teaching changes ship against BEFORE/AFTER corpus deltas (reasoning-token + requiem-recurrence), never hunches. Triage separates legibility debt from genuine protocol friction. Model-owned context is the product property: deterministic state and reversible OPEN/FOLD tools support the model's judgment without prescribing what to hide. A re-probe against >=0.76.5 is owed (grammar lane).

**Example doctrine (Arecibo teaching).** Concrete over placeholder — a live model spawned a worker literally named 'name' from a (worker://name) table cell within a day of shipping; placeholders in reserved-bracket forms are doubly banned. Bare-gesture register per section — op-teaching lines carry the gesture, the mechanism stays the engine's; match the surrounding register. Distribution is load-bearing — clustered examples teach false couplings; rebalance coverage, never add runtime prose. TIME is a distribution axis — dynamics teach as protocol-accurate worked multi-turn traces (the Delegation breath), never prose essays; an inaccurate trace (same-turn READ+200) models the wrong protocol.
