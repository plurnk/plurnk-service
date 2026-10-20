---
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-service": patch
"@plurnk/plurnk-agui": patch
---

`ApplicationPort.workerGauge` returns the client gauge the Worker's latest
concluded loop reported ({§methods-worker-gauge}). AG-UI snapshots and
whole-gauge replacements carry it as `budget`, so a reattached observer holds
the gauge a live one received ({§agui-state-patches}).
