# skills

An Agent Skill is a directory holding a `SKILL.md` (standard `name` and
`description` frontmatter, then instructions) and optionally references,
scripts, and assets beside it. Enabled skills appear in the turn-0 catalog as
`skill://<name>/SKILL.md`; nothing is injected until it is READ.

## Where skills come from

| Scope | Root | Who put it there |
| --- | --- | --- |
| `project` | `<project root>/.agents/skills/<name>/` | the repository (often committed) |
| `global` | `~/.agents/skills/<name>/` | the user, for every project |
| `service` | a tree the service itself provides | plurnk (for example the `plurnk` skill: its own configuration and model reference) |

A `project` skill shadows a `global` one of the same name, which shadows a
`service` one. Skills found at boot are service definitions, enabled by
default and disable-only; an `add` is a workspace definition. A disabled skill
is invisible to the model but still listed for the client.

## Reading a skill

The instructions are the skill: `READ (skill://<name>/SKILL.md)` for the
procedure and `FIND (skill://<name>/**)` for its files. Scripts run with their
registered executor, for example `node (skill://<name>/scripts/program.js)`,
under the ordinary loop policy. Skill resources are read-only; an installed
skill is never `EDIT`ed.

## discover

`discover` searches the standard registry: `{"query": "..."}` returns one
candidate per hit with its exact `owner/repo` source, and
`{"source": "owner/repo"}` lists the skills one package contains. Discovery
never installs anything.

## Installing

`add` installs a skill through the standard installer and enables it:

```skills (add) <!-- from a discover candidate -->
{"alias": "sql-formatter", "definition": {"name": "sql-formatter", "scope": "project", "source": "example/skills"}}
```

The alias must equal the skill's `name`; `source` is required unless the
directory already exists; `scope: "project"` needs a project root and writes
under `.agents/skills`. Installation is a host effect, admitted under the
loop's policy. A skill that fails to install or has invalid frontmatter is
listed `unavailable` with its exact Problem; one bad skill never disables the
family. `remove` uninstalls the workspace-added skill; service skills are
disable-only.
