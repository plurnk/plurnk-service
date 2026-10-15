---
"@plurnk/plurnk-contracts": major
"@plurnk/plurnk-agui": major
"@plurnk/plurnk-service": major
"@plurnk/plurnk-a2a": patch
"@plurnk/plurnk-providers": patch
---

"Conversation" was never a PLURNK or AG-UI term and is gone: a thread names a
worker. `ApplicationPort.createConversationWorker` is `createWorker`; a worker
with no parent reports `kind: "root"` instead of `"conversation"`; an AG-UI
observation of a name that holds no model worker is 404 `worker-not-found`
instead of `conversation-not-found` ({§agui-sync}). The
`workers.default_conversation` column is `default_worker` (migration 29), and
each workspace keeps its default worker.
