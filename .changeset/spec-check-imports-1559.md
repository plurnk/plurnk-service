---
"@plurnk/plurnk-spec-check": patch
"@plurnk/plurnk-contracts": patch
"@plurnk/plurnk-parser": patch
---

Add `--import <pkg-or-path>` and `--witness <prefix-or-tag>` to
`@plurnk/plurnk-spec-check` for cross-package specification citation and witness
enforcement, and move parser-internal lowering and RENO tolerance specifications
from `@plurnk/plurnk-contracts/SPEC.md` into `@plurnk/plurnk-parser/SPEC.md`
(#1559).
