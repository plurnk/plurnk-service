---
"@plurnk/plurnk-service": patch
---

Settle restart owner loss atomically, preserve waits on unanswered inter-worker
messages, and recover orphaned messages directly from their durable data.
