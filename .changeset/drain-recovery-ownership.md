---
"@plurnk/plurnk-service": patch
---

Keep orphan-message recovery with the worker drain that owns its admission and
cancellation ordering. Preserve the existing durable recovery and restart behavior.
