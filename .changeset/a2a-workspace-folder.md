---
"@plurnk/plurnk-a2a": major
---

Inbound Tasks run in the workspace a name, a folder or both select
({§a2a-lazy-workspace}). A folder alone selects the one workspace on it, the
one a client opens there, and the first Task creates it as a client would when
there is none; several workspaces on one folder refuse until
`PLURNK_A2A_WORKSPACE` names one. `PLURNK_A2A_WORKSPACE` no longer defaults to
`a2a`: an exposure sets a folder, a name or both, and one that sets neither is
refused. An operator who used the `a2a` workspace sets
`PLURNK_A2A_WORKSPACE=a2a`.
