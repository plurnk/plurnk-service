# git

In-process version control via isomorphic-git — **no subprocess, no shell**. This is the sandbox-portable git: it works (and is safe) even where `sh` is disabled. The verb set is deliberately limited; for anything beyond it, use the shell — `<<EXEC:git rebase -i …:EXEC` — where the deployment grants one.

## Verbs

```
<<EXEC[git]:status:EXEC                     branch + changed files (untracked/modified/staged/deleted)
<<EXEC[git]:add .:EXEC                      stage a path (or everything under it)
<<EXEC[git]:commit -m "why":EXEC            commit staged changes
<<EXEC[git]:log -n 5:EXEC                   recent commits ({oid, message, author, date}); no -n = full
<<EXEC[git]:branch:EXEC                     list branches (+ current)
<<EXEC[git]:branch feature:EXEC             create a branch
<<EXEC[git]:checkout feature:EXEC           switch to a ref
<<EXEC[git]:init:EXEC                       initialize a repo
```

Results land as JSON on `#results`. Anything else (push, pull, rebase, …) returns the supported set — full git is the shell's job.

## Target

`(target)` is the **repo directory**, resolved against the workspace: `<<EXEC[git](./subrepo):status:EXEC`. No target → the session workspace.

## Commit author

Taken from the repo's own config (`user.name` / `user.email`) — never invented. Unset → the commit fails with `git_no_author`; set it once via the shell (`git config user.name …`) or ship it in `.git/config`.
