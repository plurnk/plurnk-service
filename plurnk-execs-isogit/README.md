# @plurnk/plurnk-execs-isogit

An optional, in-process Git subset for Plurnk deployments that deliberately
cannot execute native Git. It uses `isomorphic-git`, performs no subprocess
execution, and is disabled by default.

## Install and enable

This package is deliberately outside the batteries-included executor inventory.
It implements a limited, overlapping Git dialect for deployments without a
native Git executable; the default inventory carries the complete native
`EXEC[git]` capability instead of presenting most deployments with two choices
that are not interchangeable.

Install the package into the same Node module graph as the service. A setting
cannot enable a package that discovery cannot see.

| Service installation | Package installation                                       |
| -------------------- | ---------------------------------------------------------- |
| Project dependency   | `npm install @plurnk/plurnk-execs-isogit` in that project. |
| Global installation  | Install globally with the same npm prefix as the service.  |

Then override the package-owned disabled default:

```dotenv
PLURNK_EXECS_ISOGIT=1
```

Restart the service so boot discovery can register and advertise the runtime.
See {§executor-installation}.

`isogit` is not Git CLI emulation and never replaces or falls back from
`EXEC[git]`.

Supported operations are `init`, `status`, `add`, `commit -m`, `log -n`,
`branch`, and `checkout`. Results are JSON on `#results`. `(target)` names the
repo directory.

```plurnk
<|EXEC[isogit]>status<EXEC|>
<|EXEC[isogit]>branch feature/example<EXEC|>
<|EXEC[isogit]>checkout feature/example<EXEC|>
```

Use `EXEC[git]` when native Git semantics are required.
