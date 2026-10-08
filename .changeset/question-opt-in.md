---
"@plurnk/plurnk-execs": patch
"@plurnk/plurnk-contracts": patch
"@plurnk/plurnk-service": patch
---

Disable the native question tool by default through the existing executor switch;
explicit opt-in preserves its implementation and client-interaction lifecycle.
Clarify that SEND carries progress updates and WAIT yields to children and streams,
without changing either operation's behavior.
