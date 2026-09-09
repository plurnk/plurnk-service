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
| `none` (shipped default) | nothing — every `add` from the model is refused `403 model-scope` |
| `root` | paths inside the project root |
| `namespace` | those plus canonical `../` paths outside the root |

The scope refuses an `add` you author from a turn; a client's `/members add`
and the operator's `PLURNK_MEMBERS_<ALIAS>=<glob>` definitions are not bound
by it. `discover` always works: a path answers why it is or is not visible; a
glob previews what `add` would resolve to.

## When a file you need is not a member

Ask first: ````` ````members (discover) ````` with `{"query": "build/report.json"}`
says `tracked`, `included by …`, `a creation record`, `excluded by …`,
`ignored`, `untracked`, or `absent`.

- **Untracked and you are allowed to add** (`root` or `namespace`): add a
  definition and it is a member from the next turn.

  ````members (add) <!-- include the generated reports -->
  {"alias": "reports", "definition": {"glob": "build/*.json"}}
  ````

- **Untracked and the scope is `none`** (the shipped default): the refusal
  names the recovery, and it is not a trick — make git track the file. Staging
  is enough; no commit is needed, and membership refreshes at your next turn.

  ````sh <!-- git tracks it, so it becomes a member -->
  git add build/report.json
  ````

  Or ask the user to add it (`/members add`) or to raise the scope. Do not
  loop on `add`; the scope will not change mid-turn.

- **Ignored by the repository**: no model definition can include it, and
  `git add` refuses it too. Only a client or operator definition covers an
  ignored path; say so and ask.

- **Excluded by `!glob`**: an exclusion is deliberate; ask the user before
  working around it.

## Files you create

An `EDIT` to a path that does not exist creates it when the file-creation
scope admits it (`PLURNK_SERVICE_FILE_CREATE_SCOPE`, shipped `root`: inside
the project root only). The new file is a member immediately through its
creation record — you never need `git add` for your own creations. Deleting
it (`KILL`) retires the record.

## Definitions are per worker, resolved per workspace

`list` shows every definition with its origin (`service` from the operator's
environment, `worker` from an `add`) and whether it is enabled. `enable` and
`disable` flip one alias; `remove` deletes a definition this worker added
(service definitions can only be disabled). Every worker's enabled definitions
union into one workspace overlay, so a definition you add is visible to every
worker, and each enabled definition is projected as
`worker://~/_plurnk/members/<alias>.md` showing what its glob resolved to.
