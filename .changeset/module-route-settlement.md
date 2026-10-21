---
"@plurnk/plurnk-modules": patch
---

A module's `close` returns once the work its routes admitted has settled: the host
releases what that work reaches once every `close` has returned, so nothing a module
admitted reaches it afterward ({§module-route-settlement}).
