---
"@plurnk/plurnk-agui": major
---

A subagent's `SUBAGENT_STARTED` carries its worker's identity and generation
as `metadata.plurnk`, `{ workerId, name, parentWorkerId, depth }`
({§agui-delegation-observation}). `CUSTOM plurnk.descendant` now introduces
only a descendant whose first event belongs to no subagent.
