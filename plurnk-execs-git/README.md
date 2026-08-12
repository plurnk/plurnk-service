# @plurnk/plurnk-execs-git

Native Git for [Plurnk Service](https://github.com/plurnk/plurnk-service)'s
EXEC scheme. `EXEC[git]` invokes the installed `git` binary with ordinary Git
arguments. Arguments are tokenized into argv and executed directly, never
interpreted by a shell.

## Contract

- `git` means native Git. Plurnk does not replace or reinterpret its commands.
- Native stdout and stderr are preserved as `#stdout` and `#stderr` under the
  emitted `git:///<loop>/<turn>/<sequence>` address
  ({§executor-output-address}).
- `(target)` names the repo directory and maps to Git's `-C` option.
- Repository-local `GIT_*` variables inherited from a launcher cannot override
  the selected workspace or `(target)`; normal Git configuration still applies.
- An unavailable Git binary makes the runtime unavailable; there is no fallback.
- Every invocation is `host` and therefore proposal-gated
  ({§executor-effect}).

Git may invoke repository hooks, aliases, credential helpers, and network
operations. Deployments that do not grant those capabilities should disable the
runtime with `PLURNK_EXECS_GIT=0`.

## Usage

```plurnk
<|EXEC[git]>status --short<EXEC|>
<|EXEC[git]>checkout -b feature/example<EXEC|>
<|EXEC[git]>add .<EXEC|>
<|EXEC[git]>commit -m "save work"<EXEC|>
<|EXEC[git](./subrepo)>log --oneline -5<EXEC|>
```

The repo's normal Git configuration determines author identity and other native
behavior.
