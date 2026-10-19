---
"@plurnk/plurnk-service": patch
---

A loop's `loop/terminated` is announced once. A gate its running turn holds
settles first, and a cancellation announces the loops it retired after the
worker's drain settles and the streams it reaped close
({§notifications-loop-terminated}).
