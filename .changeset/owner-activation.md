---
"@plurnk/plurnk-agui": minor
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-service": minor
---

An owner's arrival activates its workspace ({§agui-owner-activation}): a
control attachment, such as a terminal client opening a workspace, starts the
workspace's Functionality activation through the new
`activateWorkspace({ workspaceId })` ({§methods-workspace-activate}) without
waiting for it, so a first prompt waits only for what remains. Observation
activates nothing.
