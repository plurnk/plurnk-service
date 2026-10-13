---
"@plurnk/plurnk-execs": patch
"@plurnk/plurnk-execs-jq": patch
---

The jq runtime is probed and run as the account `PLURNK_EXECS_SPAWN_USER`
names, with that account's `HOME`, `USER` and `LOGNAME`, as every other
subprocess runtime already was ({§executor-spawn-account}). A named account
whose lookup did not run, failed, or answered another record is reported as
`was not resolved`, with what `getent passwd` did and the host's error as the
cause; only the database's own answer reports that a name `names no account`.
