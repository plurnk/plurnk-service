---
"@plurnk/plurnk-agui": minor
"@plurnk/plurnk-service": minor
---

A synchronization or reattachment `MESSAGES_SNAPSHOT` replays the messages
the live projection built ({§agui-snapshot}): each model operation replays as
its tool call and result, a WAIT that carries a body as speech, and every
turn's reasoning once, all under their live identities. The official client
keeps only what a snapshot names, so a reloaded or reconnecting client no
longer loses its operations. A turn's readable reasoning now rides its first
model operation row, live and in `readLog`, instead of its SEND, KILL, NOTE
and WAIT rows ({§methods-readable-reasoning}).
