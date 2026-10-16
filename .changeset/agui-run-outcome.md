---
"@plurnk/plurnk-agui": major
---

A Run ends with AG-UI's standard outcome ({§agui-run-outcome}). A loop that
completed finishes `RUN_FINISHED` with `outcome: success` and its exact
terminal result as `result`. One stopped without failing (499) now finishes
`RUN_FINISHED` with `outcome: cancelled` instead of `RUN_ERROR`; every other
failure is still `RUN_ERROR` from its exact Problem. A finished Run carries
its loop's token `usage`, by AG-UI's own AI SDK mapping and per-model
aggregation of what each physical request reported. `plurnk.terminated` still
carries the complete accounting, cost included.
