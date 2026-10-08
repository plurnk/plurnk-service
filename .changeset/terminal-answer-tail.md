---
"@plurnk/plurnk-parser": major
"@plurnk/plurnk-contracts": major
"@plurnk/plurnk-service": patch
---

Make parameterless KILL start the literal final-answer region. Everything after
its heading belongs to the answer; an early closing fence can no longer discard
the remainder or expose executable operations. Place operations before KILL.
Targeted KILL and completion checks retain their existing behavior.
