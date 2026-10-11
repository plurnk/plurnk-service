---
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-digest": patch
---

Apply response retention to complete provider-request payloads without deleting
identities or accounting. Record expiry explicitly, and collect native snapshots
only after retained history and in-flight publication release them.
