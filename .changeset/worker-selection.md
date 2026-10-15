---
"@plurnk/plurnk-agui": major
"@plurnk/plurnk-contracts": major
"@plurnk/plurnk-service": major
---

A Run's `threadId` names its worker in every Run and is never compared with the
workspace's name ({§agui-thread-binding}): renaming a workspace never changes
which worker a thread means, and the daemon keeps no workspace default
(`ApplicationPort.ensureModelWorker` is removed). Observation binds the worker
the `threadId` names; `forwardedProps.plurnk.worker` and `worker-invalid` are
gone ({§agui-sync}). A worker comes into being with a message Run, a setting of
its model, child model or effort, or its owner's session attaching (a control
observation). Passive observation and the other worker actions require it
(404 `worker-not-found`); an interrupt resume binds
the worker its interrupted Run bound; workspace-level actions bind none; and an
action the module does not register, or whose input it refuses, is answered on
the control path with nothing bound or created ({§agui-action-binding}).

`plurnk.status` and `budget` are the bound worker's gauge and ride only a Run
that binds one. Workspace capability preparation and derivation activity move
from `plurnk.status` to `plurnk.workspace` (`STATE /plurnk/workspace/preparation`
and `/plurnk/workspace/activity`), carried by every Run bound to the workspace;
a worker's terminal no longer clears derivation activity ({§agui-workspace-state}).
