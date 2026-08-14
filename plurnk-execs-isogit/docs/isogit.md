# isogit

Optional, in-process version control for deployments without native Git. This
is a limited `isomorphic-git` capability, not Git CLI emulation.

Supported forms:

```plurnk
## EXEC0 [isogit]
init

## EXEC0 [isogit]
status

## EXEC0 [isogit]
add path

## EXEC0 [isogit]
commit -m "message"

## EXEC0 [isogit]
log -n 5

## EXEC0 [isogit]
branch

## EXEC0 [isogit]
branch feature/example

## EXEC0 [isogit]
checkout feature/example
```

`branch <name>` creates a branch without switching; `checkout <name>` switches
to an existing ref. Results are JSON on `#results`. `(target)` names the repo
directory.

Native Git syntax and operations outside this list belong to `## EXEC0 [git]`.
