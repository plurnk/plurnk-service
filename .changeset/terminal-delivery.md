---
"@plurnk/plurnk-service": patch
---

A loop's `loop/terminated` follows its worker's pending `stream/concluded`,
including a stream whose durable close already released its live handle
({§notifications-loop-terminated}).
