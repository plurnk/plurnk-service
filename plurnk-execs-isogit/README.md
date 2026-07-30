# @plurnk/plurnk-execs-isogit

An optional, in-process Git subset for Plurnk deployments that deliberately
cannot execute native Git. It uses `isomorphic-git`, performs no subprocess
execution, and is disabled by default.

`isogit` is not Git CLI emulation and never replaces `EXEC[git]`. Enable it
explicitly with:

```dotenv
PLURNK_EXECS_ISOGIT=1
```

Supported operations are `init`, `status`, `add`, `commit -m`, `log -n`,
`branch`, and `checkout`. Results are JSON on `#results`. `(target)` names the
repo directory.

```plurnk
<<EXEC[isogit]:status:EXEC
<<EXEC[isogit]:branch feature/example:EXEC
<<EXEC[isogit]:checkout feature/example:EXEC
```

Use `EXEC[git]` when native Git semantics are required.
