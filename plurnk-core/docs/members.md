# members

Membership is the only door to the project's files. A project file is exactly
one of three things to this workspace: **tracked by git**, **added** by a
definition, or **invisible**. Nothing is a member because it exists on disk or
because git happens not to ignore it. What you can `READ`, `FIND`, and `EDIT`
is `(tracked ∪ include) − exclude`, and the catalog at turn 0 shows exactly
that set.

## What makes a file visible

| A file is a member because | How it got there |
| --- | --- |
| git tracks it | it was committed or staged (`git ls-files`), refreshed every turn |
| a definition includes it | an enabled `members` definition — a gitignore-style glob such as `docs/**` |
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
| `namespace` | those plus canonical `../` paths outside the root |

The scope refuses an `add` you author from a turn; a client's `/members add`
and the operator's `PLURNK_MEMBERS_<ALIAS>=<glob>` definitions are not bound
by it. `discover` always works: a path answers why it is or is not visible; a
glob previews what `add` would resolve to.

## When a file you need is not a member

`members (discover)` with `{"query": "build/report.json"}` answers why a path
is or is not visible: `tracked`, `included by …`, `a creation record`,
`excluded by …`, `ignored`, `untracked`, or `absent`.

- **Untracked, scope `root` or `namespace`**: a definition makes it a member
  from the next turn.

  ```members (add) <!-- include the generated reports -->
  {"alias": "reports", "definition": {"glob": "build/*.json"}}
  ```

- **Untracked, scope `none`** (an operator narrowed it): the refusal names the
  recovery, which is git tracking. Staging is enough; no commit is needed, and
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

## Files you create

An `EDIT` to a path that does not exist creates it when the file-creation
scope admits it (`PLURNK_SERVICE_FILE_CREATE_SCOPE`). The new file is a member immediately through its
creation record — you never need `git add` for your own creations. Deleting
it (`KILL`) retires the record.

## Definitions belong to the workspace

`list` shows every definition with its origin (`service` from the operator's
environment, `workspace` from an `add`) and whether it is enabled. `enable` and
`disable` flip one shared alias; `remove` deletes a workspace-added definition
(service definitions can only be disabled). Changes apply to every worker.
Each enabled definition is projected as
`worker:///_plurnk/members/<alias>.md` showing what its glob resolved to.
