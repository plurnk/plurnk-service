---
"@plurnk/plurnk-contracts": major
"@plurnk/plurnk-service": minor
---

A client entry read acquires an address as exact READ does, from its worker's
perspective: `log:///`, `reasoning://`, `ops://` and `note://` read as the
representations core computes, with `entryId` null, and a message core
retains reads at the address that minted it. Only core's own acquisition runs:
another scheme's entry reads as stored, never prepared, so a client read never
fetches ({§client-entry-address}). A channel name may be empty, a log row's
unnamed default ({§entry-read-result}).
