# skills

An Agent Skill is a directory holding a `SKILL.md` (standard `name` and
`description` frontmatter, then instructions) and optionally references,
scripts, and assets beside it. Enabled skills appear in the turn-0 catalog as
`skill://<name>/SKILL.md`; nothing is injected until it is READ.

## Where skills come from

| Scope | Root | Who put it there |
| --- | --- | --- |
| `project` | `<project root>/.agents/skills/<name>/` | the repository (often committed) |
| `plurnk` | `$XDG_CONFIG_HOME/plurnk/skills/<name>/` | the user, for plurnk alone |
| `global` | `~/.agents/skills/<name>/` | the user, for every agent and project |
| `service` | a tree the service itself provides | plurnk (for example the `plurnk` skill: its own configuration and model reference) |

A `project` skill shadows a `plurnk` one of the same name, which shadows a
`global` one, which shadows a `service` one. Skills found at boot are service
definitions, enabled by default and disable-only; an `add` is a workspace
definition. A disabled skill is invisible to the model but still listed for
the client.

## Reading a skill

The instructions are the skill: `READ (skill://<name>/SKILL.md)` for the
procedure and `FIND (skill://<name>/**)` for its files. Scripts run with their
registered executor, for example `node (skill://<name>/scripts/program.js)`,
under the ordinary loop policy. Skill resources are read-only; an installed
skill is never `EDIT`ed.

## discover

`discover` lists the skills one source carries: `{"source": "..."}` returns one
candidate per skill with the exact definition to add. A source is a git remote
as a full https or ssh URL, a folder, a lone `SKILL.md`, or a zip or tar
archive. There is no registry to search. Discovery never installs anything.

## Installing

`add` copies one skill from its source into its scope and enables it:

```skills (add) <!-- from a discover candidate -->
{"alias": "sql-formatter", "definition": {"name": "sql-formatter", "scope": "project", "source": "https://git.example/acme/skills.git"}}
```

The alias must equal the skill's `name`, which picks that skill out of a source
carrying several. A git source may name a branch or tag as `ref`; the commit it
named is recorded, and a skill whose source later moves stays unavailable
until it is removed and added again. `scope: "project"` needs a project root and
writes under `.agents/skills`. Installation is a host effect, admitted under the
loop's policy. A skill that fails to install or has invalid frontmatter is
listed `unavailable` with its exact Problem; one bad skill never disables the
family. `remove` deletes the workspace-added skill; service skills are
disable-only.
