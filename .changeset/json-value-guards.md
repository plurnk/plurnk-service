---
"@plurnk/plurnk-contracts": minor
---

The package root exports the value guards `isRecord`, `isSafeInteger` and
`errnoCode`
({§wire-entrypoint}); `Validator`'s asserts take `unknown` and return the wire
type their schema proves; `Validator.assertPlurnkStatement` joins them.
`isPlurnkOp` tests membership in the operation alphabet beside `PLURNK_OPS`.
