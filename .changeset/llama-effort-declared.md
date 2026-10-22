---
"@plurnk/plurnk-providers": major
---

A detected llama-server route admits `off` and `adaptive`. A fixed effort needs
`PLURNK_PROVIDERS_REASONING_EFFORTS` (alias form `_<alias>`) naming the levels
its chat template distinguishes; an undeclared fixed `PLURNK_PROVIDERS_EFFORT`
is refused at construction. A compatible route without a template refuses a
fixed effort without naming a declaration (#1200).
