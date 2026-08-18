# @plurnk/plurnk-execs-skills

Agent Skills management runtime for plurnk-service's exec scheme.

```plurnk
## EXEC0 [skills] (list)
## EXEC0 [skills] (add)
---
name: review
description: Review diffs before committing.
---
Check diffs before committing.
## EXEC0 [skills] (remove)
review
```

`add` and `remove` mutate the workspace `skills/` directory and are
host-effecting; `list` is read. The daemon re-publishes the
`worker://plurnk/skills/` entries on the next workspace refresh.
