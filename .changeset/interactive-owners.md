---
"@plurnk/plurnk-contracts": patch
"@plurnk/plurnk-service": patch
"@plurnk/plurnk-agui": patch
---

An owner declares whether a person attends it (`interactive`), beside the
client tools it implements. A provider-recovery park and a clarification need
an interactive owner; approval does not, so an automatically approving client
that nobody attends concludes on a provider failure instead of parking. AG-UI
reads `forwardedProps.plurnk.interactive`; unstated, nobody attends.
