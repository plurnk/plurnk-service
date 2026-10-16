---
"@plurnk/plurnk-agui": major
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-service": minor
---

A command's tool result is what its worker received: the stream's observation,
with the output's first page, terminal status and exit code, live and on
snapshot alike ({§agui-execution-result}):

- A row that observes a stream names the execution that opened it, as
  `invocation` on `readLog` and `log/entry` ({§methods-stream-invocation}).
- A started or queued receipt is no longer the command's `TOOL_CALL_RESULT`;
  the observation answers the call under its own coordinate, whenever it lands,
  and a snapshot places it after its call as the official reducer places a live
  result. The observation no longer rides `plurnk.ambient`.
- A stream's progress and conclusion ride `CUSTOM plurnk.stream` alone. The
  stream `ACTIVITY_SNAPSHOT` is gone: it added each command to the conversation
  a second time, as an activity message no snapshot could reproduce.
