---
"@plurnk/plurnk-agui": minor
---

A passive observation, a synchronization Run or `/agui/connect` that does not
claim the conversation, binds an existing workspace and conversation and
creates neither ({§agui-conversation-sync}); an owner's control connection
binds as a message Run does. For a passive observation a
missing workspace is 404 `workspace-not-found`, and a worker that does not
exist or is not a conversation is 404 `conversation-not-found`. A new
`forwardedProps.plurnk.worker` names the observed conversation exactly,
independent of the `threadId`, read fresh on every Run; it belongs to
observation alone, and elsewhere it is 400 `worker-invalid`. The workspace's
default conversation, the `threadId` equal to its name, stays its own.
