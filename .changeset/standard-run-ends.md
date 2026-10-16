---
"@plurnk/plurnk-agui": minor
"@plurnk/plurnk-contracts": minor
---

A Run's end carries plurnk's facts in standard AG-UI fields
({§agui-plurnk-metadata}):

- The end the bound loop's terminal produces carries the loop's complete
  terminal record as `metadata.plurnk.terminal`, the record
  `plurnk.terminated` carries. A failed loop's `RUN_ERROR` now carries its
  token `usage` too.
- A Run that fails without its loop's terminal carries the exact Problem as
  `RUN_ERROR.metadata.plurnk.problem`.
- An action Run's `RUN_FINISHED.result` is the action's whole outcome,
  `{ kind, ok, result | problem }`, so a standard client reads it from
  `runAgent()`.
- The AG-UI conformance kit's Run ends match what the daemon sends: a
  completed loop's `result`, a cancelled loop's `outcome: cancelled`, and the
  metadata above.
