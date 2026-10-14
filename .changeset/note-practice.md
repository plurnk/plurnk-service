---
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-contracts": patch
---

The card states its NOTE rule as one command,
`YOU MUST emit at least one NOTE, a summary, in every turn.`, describes NOTE as
the register of summary, finding, decision and next actions, and shows each
of the four as a labelled example. A continuing turn that carried no NOTE is
told so in the next packet by the `continued_without_note` notice, whose
directive repeats that command word for word ({§continued-without-note}); a
turn of NOTEs alone draws no notice, and `noted_without_operation` is gone. A
model worker's initialization program closes its surveys with a second NOTE,
labelled `<!-- next -->` as the card's last NOTE example is and reading
`Read and resolve the Open Message.` ({§worker-initialization-entry}).
