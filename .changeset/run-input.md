---
"@plurnk/plurnk-agui": major
---

A Run's `messages` are the client's copy of the conversation its thread names
({§agui-run-input}). A Run submits its last message only when that is a user
message whose id the conversation doesn't hold, so an official `HttpAgent` that
runs again with its history reattaches instead of re-sending an earlier message,
and never sends another actor's message as its own. A Run with nothing new
synchronizes ({§agui-sync}), and `forwardedProps.plurnk.mode` is gone with
`unsupported-run-mode`. A connection accepts the client's copy and refuses a new
message, an action or a resume (`invalid-connect-input`, replacing
`invalid-sync-input`). A Run that carries more than one of a new message, an
action and a resume is refused (`ambiguous-run-input`), as is a new message
that is not non-empty text (`user-message-text-required`, replacing
`user-message-required`). Whether a message is new takes two keyed reads, a
coordinate the worker's log holds and core's accepted address
({§message-idempotency}), whatever the log's length.
