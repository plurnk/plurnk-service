---
"@plurnk/plurnk-agui": patch
---

A thread's cached workspace binding serves only while its workspace still
carries the name a Run selects ({§agui-thread-binding}). After a rename, by
any client, the old name resolves afresh, so an observation of it is 404
`workspace-not-found` and the new name reaches the workspace.
A thread's worker binding belongs to its workspace too: a workspace that
later takes the old name binds its own worker, never the renamed one's.
