# members

Membership is the only door to the project's files. What you can `EDIT` is `(tracked ∪ include ∪ created) − exclude`. When `PLURNK_MEMBERS_AUTO_ADD=1` (default), `FIND` lists unignored, unexcluded untracked files inside the project root as `untracked`, and reading or matching inside one proposes its admission as a member (`member_added` notice on acceptance).

## What makes a file visible

| A file is a member because | How it got there |
| --- | --- |
| git tracks it | Committed or staged (`git ls-files`), refreshed every turn |
| a definition includes it | An enabled `members` glob definition (e.g. `docs/**`); `!glob` exclusions win over all inclusions |
| plurnk created it | An accepted `EDIT`, `COPY`, or `MOVE` created it (`PLURNK_SERVICE_FILE_CREATE_SCOPE`); `KILL` retires the creation record |

## What you may change here

Model additions are bounded by `PLURNK_SERVICE_MEMBERS_MODEL_SCOPE` (narrowed by workspace policy):

| Scope | A model definition may include |
| --- | --- |
| `none` | Nothing (`403 model-scope`) |
| `root` | Unignored paths inside the project root |
| `namespace` | Unignored paths inside or beyond the project root (spelled absolute, e.g. `/srv/shared/notes.md`) |

Client `/members add` and `PLURNK_MEMBERS_<alias>=<glob>` definitions are not bound by the model scope or `.gitignore`.

## When a file you need is not a member

`await plurnk.members({ discover: "build/report.json" })` inspects why a path is or is not visible (or previews what a glob would include/exclude) without adding anything:

| `provenance.kind` | `summary` |
| --- | --- |
| `member` | `` member — tracked by git ``, `` member — included by `docs/**` ``, or `` member — a creation record: plurnk wrote it `` |
| `candidate` | `` not a member — untracked; add this definition to include it `` |
| `excluded` | `` not a member — excluded by `!glob`; only the user can lift it `` |
| `ignored` | `` not a member — git ignores it (`.gitignore` line 4); a client or operator definition can include it, a model definition cannot `` |
| `absent` | `` absent — no such file under the project root `` |

| Call | Effect |
| --- | --- |
| `await plurnk.members({})` | List definitions with origin (`service` or `workspace`), enabledness, and matched file count. |
| `await plurnk.members({ discover: "<path-or-glob>" })` | Explain a path's membership status or preview a glob. |
| `await plurnk.members({ path: "build/*.json" })` | Admit one glob or an array of globs within `PLURNK_SERVICE_MEMBERS_MODEL_SCOPE`. |
| `await plurnk.members({ path: "build/*.json", enabled: false })` | Disable (`false`) or re-enable (`true`) a definition. |
| `await plurnk.members({ path: "build/*.json", remove: true })` | Remove a workspace definition and restore inheritance. |

await plurnk.members({ path: "build/*.json" }) // include the generated reports; a string or array of globs

await plurnk.members({ path: "build/*.json", enabled: false })

## Concurrent edits

File mutations verify their selected revision at acceptance and return `409 edit-collision` if the file changed on disk.
