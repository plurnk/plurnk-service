# git

Native Git with ordinary Git CLI syntax. Arguments execute directly without
shell interpretation. Native stdout and stderr stream as `#stdout` and
`#stderr` under the emitted `git:///<loop>/<turn>/<sequence>` address.

Examples:

```plurnk
## EXEC0 [git]
status --short

## EXEC0 [git]
checkout -b feature/example

## EXEC0 [git]
add .

## EXEC0 [git]
commit -m "why"

## EXEC0 [git]
log --oneline -5
```

## Target

`(target)` is the repo directory and maps to `git -C`; for example,
`## EXEC0 [git] (./subrepo)` with body `status`. Without a target, Git runs in the
workspace. Repository-local `GIT_*` variables inherited from a launcher cannot
redirect the command away from that selected repository.

## Availability and authority

The runtime is available only when native Git is on `PATH`. It never falls back
to another implementation. Git can invoke hooks, aliases, credential helpers,
and network operations, so every call is host-effecting and follows the
deployment's proposal policy.
