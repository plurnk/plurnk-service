---
"@plurnk/plurnk-service": patch
---

Project the daemon's resolved `HostPaths` (`HOME` and `XDG_*` roots) into
`ExecEnv.scoped`, `ExecEnv.withoutOwnSecrets`, `EnvFunctionality`, and
`ExecScratch` so subprocesses and module-launched processes inherit the
daemon's isolated home and state root rather than ambient host paths (#1224).
