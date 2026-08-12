# git

Native Git with ordinary Git CLI syntax. Arguments execute directly without
shell interpretation. Native stdout and stderr stream as `#stdout` and
`#stderr` under the emitted `git:///<loop>/<turn>/<sequence>` address.

Examples:

```plurnk
<|EXEC[git]>status --short<EXEC|>
<|EXEC[git]>checkout -b feature/example<EXEC|>
<|EXEC[git]>add .<EXEC|>
<|EXEC[git]>commit -m "why"<EXEC|>
<|EXEC[git]>log --oneline -5<EXEC|>
```

## Target

`(target)` is the repo directory and maps to `git -C`:
`<|EXEC[git](./subrepo)>status<EXEC|>`. Without a target, Git runs in the
workspace. Repository-local `GIT_*` variables inherited from a launcher cannot
redirect the command away from that selected repository.

## Availability and authority

The runtime is available only when native Git is on `PATH`. It never falls back
to another implementation. Git can invoke hooks, aliases, credential helpers,
and network operations, so every call is host-effecting and follows the
deployment's proposal policy.
