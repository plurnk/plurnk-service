---
"@plurnk/plurnk-service": patch
---

Replace monolithic `DrainSupervisor` session maps with per-workspace
`WorkspaceAdmission` serializers and self-reaping per-session `SessionProcess`
state-machine actors owning rotated cancellation epochs, session-local poll
timers, non-sliding completion wake coalescing, and session-scoped stream
announcement barriers (#1469).
