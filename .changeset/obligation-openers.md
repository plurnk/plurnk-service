---
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-agui": major
---

Every obligation records the operation that opened it, and a client answers a
call with whatever discharged its obligation ({§worker-obligations},
{§methods-invocation}, {§agui-call-result}):

- A message a worker's own SEND, WORK or FORK sends records that operation
  (migration 31). It holds that worker, and its reply reaches that worker, by
  identity rather than by a match on the sender's name. A message sent before
  the record, or by a person, a client or the daemon, holds no worker.
- The opening row names what it opened, as `attrs.message` for a message, the
  way an execution names its `attrs.stream`. Packets don't render it.
- `invocation` now also rides a child's conclusion, naming the WORK or FORK
  whose message opened its loop, and a completion reply, naming the SEND it
  completes. A FORK's copy of a stream observation keeps the publication it
  records, so it names its execution too.
- AG-UI answers WORK, FORK and a SEND to a worker the way it answers a command.
  The receipt is no longer the call's `TOOL_CALL_RESULT`; the child's
  conclusion or the completion reply's words are.
