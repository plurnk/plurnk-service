---
"@plurnk/plurnk-digest": major
"@plurnk/plurnk-service": patch
---

The worker summary gains a `Room:` line: the budget the model was shown, in
provider tokens, against the capacity, and the wall's estimate against the
provider's count, marking requests the estimate admitted over the wall.
`EvidencePacket` carries `weight` and `budget`; an evidence implementation must
provide them.
