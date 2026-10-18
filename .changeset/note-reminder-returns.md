---
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-contracts": patch
---

The card states its NOTE rule as one command, `YOU MUST persist all new facts,
ideas, and plans in NOTEs on every turn.`, and the reminder returns: a model
turn that continues or parks without a NOTE in its program or from its
reasoning is told so in the next packet by the `engine:turn` notice
`continued_without_note` (`level: warn`, that command as its directive). A
notice, never a failure ({§continued-without-note}).
