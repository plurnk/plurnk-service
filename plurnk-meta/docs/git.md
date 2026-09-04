# git — advanced repository usage

## Summary

Advanced git usage: commits, branches, worktrees, and delegation in the Plurnk environment.

Your workspace is a git working tree. Tracked files are the membership you READ, FIND, and
EDIT; the packet's `## Git Status` names the branch and counts staged, unstaged, and untracked
paths every turn. Routine work needs none of this document: edit, run the tests, commit. Read
on when the task spans branches, parallel workers, or history you did not write.

**Commits are the only shareable state.** Every worker sees the same working tree, so an
uncommitted change is visible to all of them and belongs to none of them. "Dirt" means
uncommitted changes to tracked content; an untracked file belongs to no branch at all. Commit
before you delegate, commit before you switch, and commit small: one intention per commit,
the subject a sentence that says what changed, never why the model felt like it.

**One branch per child, one child per checkout.** A branch-shaped subtask is an ordinary
WORK whose brief begins with the branch it owns:

```example
### EXEC0 <!-- park my own work before anyone switches -->
git add -A && git commit -q -m "wip: parser rewrite before delegating the lexer"

### WORK0 (worker://lexer)
On a new branch `feat/lexer` from the current HEAD: replace src/lexer.js with the
table-driven lexer described in docs/lexer.md, run `npm test`, commit on that branch,
then `git switch -` back to the branch you started on and report the commit hash.

### SEND0 (WAIT)
Awaiting lexer.
```

Never let two children drive `git switch` in the same checkout at the same time: the second
switch strands the first child's edits on the wrong branch. Spawn branch-shaped children one at
a time, or give each its own worktree.

**Worktrees give parallel children their own checkout.** `git worktree add ../lexer-wt
feat/lexer` creates a second working tree on its own branch; a child told to work inside it can
switch, commit, and run tests without touching yours. Membership follows the worktree's tracked
files. Remove it with `git worktree remove ../lexer-wt` after the merge; a forced removal
discards uncommitted work there.

**The parent collects and merges deliberately.** When a child reports, READ its commit
(`git show --stat <hash>`) before merging. Merge with `git merge --no-ff feat/lexer` or
fast-forward when the history is linear; resolve conflicts yourself rather than asking the child
to redo the work blind. Delete the branch once merged.

**History you did not write is not yours to rewrite.** Never `git push --force`, rebase, or
amend commits that exist on a remote or in another worker's branch. Amend only your own
unpushed tip. Prefer a new commit that fixes over a rewrite that hides.

**Inspect before you act.** `git status --short`, `git diff --stat`, `git log --oneline -20`,
and `git blame -L <start>,<end> <path>` answer most questions about a tree in one EXEC each.
Read a file at another revision with `git show <ref>:<path>` rather than switching branches to
look at it.

**Stash is a last resort.** A stash is invisible to every other worker and to the packet's
git status. If work must be set aside, commit it as `wip:` on its branch and reset or revert
later; a commit can be seen, a stash is easily lost.
