---
"@plurnk/plurnk-service": patch
---

Omit routine status 200 from every model-facing receipt, including SEND, WAIT,
and KILL. Preserve other statuses, retained invocation metadata, durable results,
and protocol responses so delivery success is not confused with message completion.
