---
"@plurnk/plurnk-agui": major
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-service": minor
---

A standard AG-UI client builds the same conversation from every vantage, live
and on snapshot ({§agui-snapshot}):

- An arrival (another client's prompt, a worker's message, a person's
  operation SEND) is a native user message live, as it is on replay, and never
  goes back to the Run that submitted it. A message a client on this thread
  sent keeps its message id and carries no name; any other is named by its
  source.
- Every message and tool-call id is the row's log coordinate `L/T/S`
  ({§methods-log-coordinate}).
- Reasoning keeps the identity of the request that streamed it on replay. The
  row carrying a turn's reasoning names that request
  (`reasoning_model_call_id`, `reasoning_request_sequence`)
  ({§methods-readable-reasoning}).
- A snapshot is the whole log. `readLog` returns rows newest first and pages
  back with `beforeId` ({§methods-log-read}).
