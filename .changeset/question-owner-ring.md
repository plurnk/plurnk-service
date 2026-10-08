---
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-execs": patch
"@plurnk/plurnk-contracts": patch
---

Offer the native `question` tool only to a worker whose owner would receive
it: an interactive owner that declares the tool. Other workers do not see it
at turn 0 or in the reserved reference set, and a call is refused with a
recovery saying nobody is present to answer. The tool is on by default;
`PLURNK_EXECS_QUESTION=0` remains the operator's switch to remove it.
Teaching now says SEND carries progress updates and WAIT yields to children
and streams, without changing either operation's behavior.
