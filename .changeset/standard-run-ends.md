---
"@plurnk/plurnk-agui": major
"@plurnk/plurnk-contracts": major
---

A Run's end carries plurnk's facts in standard AG-UI fields, and the custom
events that carried them are gone ({§agui-plurnk-metadata}):

- The end that the bound loop's terminal produces carries the loop's complete
  terminal record, accounting and cost included, as `metadata.plurnk.terminal`.
  `CUSTOM plurnk.terminated` is gone. A failed loop's `RUN_ERROR` now carries
  its token `usage` too.
- A Run that fails without its loop's terminal carries the exact Problem as
  `RUN_ERROR.metadata.plurnk.problem`, and no longer sends a
  `CUSTOM plurnk.problem` before it. A Problem that ends no Run, such as an
  unavailable provider catalog, is still `CUSTOM plurnk.problem`.
- An action Run's `RUN_FINISHED.result` is the action's whole outcome,
  `{ kind, ok, result | problem }`, so a standard client reads it from
  `runAgent()`. `CUSTOM plurnk.action.result` is gone.
- The AG-UI conformance kit's Run ends match what the daemon sends: a
  completed loop's `result`, a cancelled loop's `outcome: cancelled`, the
  metadata above, and none of the retired events.
