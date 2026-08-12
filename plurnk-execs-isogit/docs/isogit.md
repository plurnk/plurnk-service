# isogit

Optional, in-process version control for deployments without native Git. This
is a limited `isomorphic-git` capability, not Git CLI emulation.

Supported forms:

```plurnk
<|EXEC[isogit]>init<EXEC|>
<|EXEC[isogit]>status<EXEC|>
<|EXEC[isogit]>add path<EXEC|>
<|EXEC[isogit]>commit -m "message"<EXEC|>
<|EXEC[isogit]>log -n 5<EXEC|>
<|EXEC[isogit]>branch<EXEC|>
<|EXEC[isogit]>branch feature/example<EXEC|>
<|EXEC[isogit]>checkout feature/example<EXEC|>
```

`branch <name>` creates a branch without switching; `checkout <name>` switches
to an existing ref. Results are JSON on `#results`. `(target)` names the repo
directory.

Native Git syntax and operations outside this list belong to `EXEC[git]`.
