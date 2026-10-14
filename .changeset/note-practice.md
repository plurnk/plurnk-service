---
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-contracts": patch
---

The per-turn NOTE rule is retired. The card asks for NOTEs as practice rather
than as a requirement of every turn, a NOTE for EVERY summary, finding,
decision and next, with its reason, and says why: reasoning is not preserved
across turns, so a model's NOTEs are its only orientation. The daemon no
longer answers a continuing turn that carried no NOTE, or a turn of
NOTEs alone, with a notice: `continued_without_note` and
`noted_without_operation` are gone. A model worker's initialization program
closes its surveys with a second NOTE, labelled `<!-- next -->` as the card's
last NOTE example is and reading `Read and resolve the Open Message.`
({§worker-initialization-entry}).
