# skills

An Agent Skill is a directory holding a `SKILL.md` (standard `name` and
`description` frontmatter, then instructions) and optionally references,
scripts, and assets beside it. Enabled skills appear in the turn-0 catalog as
`skill://<name>/SKILL.md`; nothing is injected until it is READ.

## Where skills come from

| Source | Root | Who put it there |
| --- | --- | --- |
| `project` | `<project root>/.agents/skills/<name>/` | the repository (often committed) |
| `plurnk` | `$XDG_CONFIG_HOME/plurnk/skills/<name>/` | the user, for plurnk alone |
| `global` | `~/.agents/skills/<name>/` | the user, for every agent and project |
| `service` | a tree the service itself provides | plurnk (for example the `plurnk` skill: its own configuration and model reference) |

A `project` skill shadows a `plurnk` one of the same name, which shadows a
`global` one, which shadows a `service` one. These roots are read-only inputs.
The cascading environment can replace a whole definition above them;
`skills (add)` creates a workspace override above that. Declared skills are
enabled by default. A disabled skill remains listed but has no resource tree.

```sh
PLURNK_SKILLS_code_review='{"name":"code-review","source":"/srv/skills/code-review"}'
PLURNK_SKILLS_ENABLED=1
PLURNK_SKILLS_code_review_ENABLED=0
```

The environment key preserves the standard skill name, replacing hyphens with
underscores. Digit-leading and Unicode names are supported; use a `.env` file
for keys outside shell assignment syntax. Behavior controls override
independently of the definition; an empty definition is invalid.

## Reading a skill

The instructions are the skill: `READ (skill://<name>/SKILL.md)` for the
procedure and `FIND (skill://<name>/**)` for its files. Scripts run with their
registered executor, for example `node (skill://<name>/scripts/program.js)`,
under the ordinary loop policy. Skill resources are read-only through `skill://`.

## discover

`discover` lists the skills one source carries: `{"source": "..."}` returns one
candidate per skill with the exact definition to add. A source is a git remote
as a full https or ssh URL, a folder, a lone `SKILL.md`, or a zip or tar
archive. There is no registry to search. Discovery never installs anything.

## Adding

`add` binds one skill from its source to this workspace and enables it:

```skills (add) <!-- from a discover candidate -->
{"alias": "sql-formatter", "definition": {"name": "sql-formatter", "source": "https://git.example/acme/skills.git"}}
```

The alias must equal the skill's standard `name`, which selects it from a source
carrying several. Local folders and their `SKILL.md` files stay live references:
edits remain visible, with supporting files in place. Relative sources resolve
from the project root; absolute sources also work in headless workspaces.
Git/archive sources are materialized into workspace-owned storage, never a
project or global configuration root. They remain stable across enable and
restart until their source definition changes. A git addition may name a branch or tag
as `ref`; the service records its commit and refuses to refetch a moved ref
silently. Additions follow the loop's ordinary proposal policy.

An unavailable skill retains its exact Problem in `list`; other skills remain
usable. `disable` suppresses a skill without forgetting its definition. `remove`
forgets a workspace override and restores any inherited definition and enabled
state. It never deletes a local source; fetched copies remain workspace state,
but confer no availability without a definition. Service definitions are
disable-only.
