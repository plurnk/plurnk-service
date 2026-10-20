---
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-service": patch
"@plurnk/plurnk-agui": patch
---

`loop/packet` carries the loop's client gauge after each model turn, and
`ApplicationPort.workerGauge` returns the gauge the Worker's latest packet
reported ({§notifications-loop-packet}, {§methods-worker-gauge}). AG-UI moves
the budget with every packet and its snapshots carry the latest, so a live and
a reattached observer agree ({§agui-state-patches}).
