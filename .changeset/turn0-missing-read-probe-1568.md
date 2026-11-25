---
"@plurnk/plurnk-service": patch
---

Treat exact-target `404` probes as selecting zero items in `Dispatcher.selects`
so Turn 0 omits missing `READ` targets (such as `skill://plurnk/pattern.md`
when `skills` fails startup configuration) instead of crashing initialization.
