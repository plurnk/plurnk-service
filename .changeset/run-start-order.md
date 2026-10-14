---
"@plurnk/plurnk-agui": patch
---

A Run's events begin with `RUN_STARTED` and its `STATE_SNAPSHOT`
({§agui-run-start}). Rows, notices and deltas that reach a Run while its
snapshot is read now follow them in arrival order instead of preceding them,
which the official client refused. A status delta patches only what the Run's
client holds and never arrives before its snapshot ({§agui-status-children}).
