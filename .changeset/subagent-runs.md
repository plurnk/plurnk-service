---
"@plurnk/plurnk-agui": major
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-service": minor
---

A Run that observes its delegation presents each delegation a call in view
opened as an AG-UI subagent run of that call ({§agui-subagents}):

- `listWorkerLoops` names the operation that opened each loop, as
  `invocation`: the worker and log address of the operation that sent its first
  message, or null when a person, a client, a peer or the daemon sent it
  ({§methods-worker-loops}). `ApplicationLoopProjection` gains `invocation`
  ({§application-loop-observation}).
- A loop that a call of the bound worker, or of one of its subagents, opened is
  the subagent run `ops://<worker>/<loop>`. `SUBAGENT_STARTED` names the opening
  call as `parentToolCallId`, and `parentSubagentRunId` when a subagent made it.
  Its rows are its own worker's conversation, under `worker://<name>#L/T/S`
  identities, each event attributed by `subagentRunId`. Its conclusion is
  `SUBAGENT_FINISHED` with its exact result, or `SUBAGENT_ERROR` from its
  Problem. A Run that finishes first ends it `suspended`.
- A subagent's rows are no longer `plurnk.ambient`; other descendants' rows
  still are. A snapshot replays every subagent's messages in log order, then
  presents each subagent run.
- A workspace's events reach a Run in the order the daemon published them, even
  while a descendant's topology or loop is being read.
