# plurnk-docs

The plurnk teaching corpus. Markdown consumed by [plurnk-service](https://github.com/plurnk/plurnk-service) at runtime — no code, no build.

## Contents

- `docs/<scheme>.md` — per-scheme long-form teaching, materialized as `plurnk://docs/<scheme>.md` entries the model READs (known, unknown, run, log).
- `PLURNK_PERSONALITY.md` — the default operating policy, seeded once to `~/.plurnk/AGENTS.md` and foisted as `## Plurnk Service Policy`.
- `requirements.md` — the static contract appended to every user packet (`system_requirements` default).

## The teaching split

**Grammar teaches the language; docs teaches the world.** [plurnk-grammar](https://github.com/plurnk/plurnk-grammar)'s `plurnk.md` owns op syntax and the DSL (GBNF-coupled, moves with the grammar). This package owns scheme behavior, delegation workflow, disposition, and standing rules — the corpus tuned against live model behavior (steer wording, weak-model teaching, pressure habits).

## Contract

plurnk-service resolves these files from this package (`Paths`), pins the version, and validates teaching changes with its live/demo tiers. A teaching change ships as a bump here; the service adopts it like any daughter. File teaching asks and steer-wording issues HERE, not on the daemon.
