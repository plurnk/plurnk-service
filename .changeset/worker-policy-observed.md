---
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-agui": minor
---

A change to a worker's model, effort or spawn model is announced as
`worker/policy` ({§notifications-worker-policy}), and every client attached to
the worker is sent the new route as `STATE_DELTA /plurnk/status/model`,
whichever view made the change ({§agui-status-model}). A delta an event causes
reaches the Run before any later event, its terminal included
({§agui-state-patches}).
