# isogit

Optional, in-process version control for deployments without native Git. This
is a limited `isomorphic-git` capability, not Git CLI emulation.

Supported forms:

```plurnk
## EXEC1 [isogit]
init

## EXEC1 [isogit]
status

## EXEC1 [isogit]
add path

## EXEC1 [isogit]
commit -m "message"

## EXEC1 [isogit]
log -n 5

## EXEC1 [isogit]
branch

## EXEC1 [isogit]
branch feature/example

## EXEC1 [isogit]
checkout feature/example
```

`branch <name>` creates a branch without switching; `checkout <name>` switches
to an existing ref. Results are JSON on `#results`. `(target)` names the repo
directory.

Native Git syntax and operations outside this list belong to `## EXEC1 [git]`.
