# plurnk teaching corpus

Authored defaults published by `@plurnk/plurnk-meta` and consumed by
`@plurnk/plurnk-service`. The membership and ownership boundary is specified at
{§teaching-corpus}; core owns runtime projection.

## Contents

| Source                          | Consumer admission                                                           |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `POLICY.md`                     | Read before the first-run seed of the user-owned XDG config `AGENTS.md`.     |
| `recap.md`                       | Read for an optional Recap rendered last when its content is nonempty.       |
| `docs/worker.md`                | Read when registered built-in pull docs are materialized.                    |
| `skills/plurnk/SKILL.md`         | Standard skill entry; Core composes its package-owned and generated resources. |

Core materializes eligible scheme and runtime pull docs at
`worker:///_plurnk/plurnk/<name>.md` and exposes them through turn-0 FIND surveys. Merely
placing a file in `docs/` does not register a scheme or make speculative
teaching current. Every listed source is a required package member; a missing
or failed read surfaces at the admission boundary rather than silently reducing
the corpus. The intentionally empty `recap.md` is a dormant source, not a missing
one.

Plurnk's own reference is catalogued at `skill://plurnk/SKILL.md` alongside
installed skills. Chapters and the complete generated defaults catalog are
ordinary pull resources, not additional startup packet sections ({§plurnk-skill}).

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

## Teaching review

- Keep startup orientation lean; put subsystem mechanics in pull references.
  A recovery warning belongs at the state that makes it relevant, not in every packet.
- Use concrete, executable examples. Distribute them across useful operations
  rather than accidentally teaching one pattern as the only workflow.
- Show temporal behavior with legal turns under {§op-execution-order} and
  {§send}; describe the contract, not a model's historical workaround.
- Evaluate packet bytes, reasoning, operation results, and self-audit evidence
  together. Distinguish a teaching gap from a runtime defect before prescribing
  more teaching. Compare model behavior when the change is behavioral; do not
  promote one small probe into a universal rule.
- Preserve model-owned context management. Runtime configuration and operator
  policy can tune different workloads without broadening the default teaching.

Probe history and unresolved experiments belong in forge issues, not current
doctrine. {§teaching-corpus} owns source membership; {§recap} owns the optional
footer. Neither creates a second admission rule or release gate.
