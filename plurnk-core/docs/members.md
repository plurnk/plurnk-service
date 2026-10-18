# members

Membership is the only door to the project's files. A project file is exactly
one of three things to this workspace: **tracked by git**, **added** by a
definition, or **invisible**. What you can `EDIT` is `(tracked ∪ include ∪ created)
− exclude`, and the catalog at turn 0 shows exactly that set. Your `READ` and
`FIND` reach one step further when the operator leaves `PLURNK_MEMBERS_AUTO_ADD=1`
(the default): an untracked file the repository does not ignore, inside the
project root and not excluded, is listed by `FIND` as `untracked`, and the
moment you `READ` it, or a `FIND` pattern matches inside it, its admission as
your own definition of that exact path is proposed — accepted by policy where
nobody reviews, by the person otherwise — a `member_added` notice says so when it
is admitted, and the read or find then runs. A rejected admission settles the
operation as `rejected` and admits nothing. Listing admits nothing; `~` full-text
and `&` graph patterns search members only.

## What makes a file visible

| A file is a member because | How it got there |
| --- | --- |
| git tracks it | it was committed or staged (`git ls-files`), refreshed every turn |
| a definition includes it | an enabled `members` definition — a shell-path glob such as `docs/**` |
| plurnk created it | a file your accepted `EDIT`, `COPY`, or `MOVE` wrote gets an exact creation record; it is a member without any `git add` |

An exclusion (`!glob`) wins over every inclusion. A model definition never
includes a path the repository ignores.

## What you may change here

Your `add` is admitted against the operator's ceiling
`PLURNK_SERVICE_MEMBERS_MODEL_SCOPE`, narrowed by the workspace:

| Scope | A model definition may include |
| --- | --- |
| `none` | nothing — every `add` from the model is refused `403 model-scope` |
| `root` | paths inside the project root |
| `namespace` | those plus paths beyond the root, which are spelled absolute |

The scope refuses an `add` you author from a turn; a client's `/members add`
and the operator's `PLURNK_MEMBERS_<alias>=<glob>` definitions are not bound
by it. `discover` always works: a path answers why it is or is not visible; a
glob previews what `add` would resolve to.

## When a file you need is not a member

`members (discover)` with `{"query": "build/report.json"}` answers with one
candidate: its `provenance.kind` is the verdict and its `summary` the reason.

| kind | summary |
| --- | --- |
| `member` | `` member — tracked by git ``, `` member — included by `docs/**` `` or `` member — a creation record: plurnk wrote it `` |
| `candidate` | `` not a member — untracked; add this definition to include it `` |
| `excluded` | `` not a member — excluded by `!glob` `` |
| `ignored` | `` not a member — the repository ignores it; a client or operator definition can include it, a model definition cannot `` |
| `absent` | `` absent — no such file under the project root `` |

- **Untracked, scope `root` or `namespace`**: `READ` it; with auto-add on the read
  proposes its admission and, accepted, admits and reads it in one operation. With
  auto-add off, an accepted `add` makes it a member before the next operation.

  ```members (add) <!-- include the generated reports; each glob is one definition -->
  {"files": ["build/*.json"]}
  ```

- **Untracked, scope `none`** (an operator narrowed it): neither auto-add nor your
  `add` admits it; the refusal names the recovery, which is git tracking. Staging is enough; no commit is needed, and
  membership refreshes at the next turn. The scope is fixed for the turn, so a
  refused `add` is refused again; a client's `/members add` or a raised scope
  is the user's to give.

  ```sh <!-- git tracks it, so it becomes a member -->
  git add build/report.json
  ```

- **Ignored by the repository**: no model definition can include it, and
  `git add` refuses it too; only a client or operator definition covers an
  ignored path.

- **Excluded by `!glob`**: an exclusion outranks every inclusion, and a model
  definition cannot lift it; only the user can.

- **Beyond the project root** (an absolute path such as `/srv/shared/notes.md`,
  which is how such a path is spelled; `../notes.md` names the same place): a
  model definition can admit it under `namespace` scope, but not `root` or
  `none`; client and operator definitions are not bound by the model's scope. Ignore rules and exclusions still apply as described above.
  File operands beginning with `~/`
  resolve from the daemon user's home; `./~/` names a literal project
  directory. Members globs remain project-relative, not home shorthand.
  A command runs on the host from the project root, and its output is a stream
  the worker reads.

## Files you create

An `EDIT` to a path that does not exist creates it when the file-creation
scope admits it (`PLURNK_SERVICE_FILE_CREATE_SCOPE`). The new file is a member immediately through its
creation record — you never need `git add` for your own creations. Deleting
it (`KILL`) retires the record.

## Changes while you work

File mutations check their selected revision again at acceptance. If the file
changed, `409 edit-collision` preserves it: inspect the current file and rebuild
the operation. A MOVE may already have written its destination before source
cleanup conflicts; its receipt identifies that completed effect.

## Definitions belong to the workspace

A definition is its glob: `list` shows every definition with its origin (`service` from the
operator's environment, `workspace` from an `add`) and whether it is enabled. `enable` and
`disable` flip one definition, and `remove` forgets a workspace definition and restores
inheritance, each named by the glob as `list` shows it:

```members (disable)
{"file": "build/*.json"}
```

Inherited definitions cannot be removed here. Changes apply to every worker. Each enabled
definition is projected as `worker:///_plurnk/members/<glob>.md`, the glob percent-encoded,
showing what it resolved to.
