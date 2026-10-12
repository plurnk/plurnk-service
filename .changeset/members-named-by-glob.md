---
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-modules": minor
"@plurnk/plurnk-schedule": patch
---

A members definition is its glob. `members (add)` takes `{"files": ["<glob>",
"!<glob>"]}` and admits each glob as one definition, all or none, with a receipt
listing them; `enable`, `disable` and `remove` take `{"file": "<glob>"}`; the
family serves no `replace`. The operator's `PLURNK_MEMBERS_<alias>=<glob>` key
is the definition's provenance, shown by `list`. Migration 27 re-keys workspace
definitions by their glob and drops alias-keyed overrides of service
definitions. The coordinator gains one seam, `addressing`: a family may name
definitions by their content, `admit` may return one admission per definition,
`FunctionalityPreparation.admissions` carries them, and
`FunctionalityMutationResult` lists `definitions` for such an add. Every file
miss recovery names the `members (add)` body the family accepts.
