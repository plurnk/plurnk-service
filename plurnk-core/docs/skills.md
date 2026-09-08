# skills

An Agent Skill is a directory holding a `SKILL.md` (standard `name` and
`description` frontmatter, then instructions) and optionally references,
scripts, and assets beside it. Skills are how a project or a user hands you
procedures and tools without pasting them into every conversation. Enabled
skills appear in the turn-0 catalog as `skill://<name>/SKILL.md`; nothing is
injected until you `READ` it.

## Where skills come from

| Scope | Root | Who put it there |
| --- | --- | --- |
| `project` | `<project root>/.agents/skills/<name>/` | the repository (often committed) |
| `global` | `~/.agents/skills/<name>/` | the user, for every project |
| `service` | a tree the service itself provides | plurnk (for example the `plurnk` skill: its own configuration and model reference) |

A `project` skill shadows a `global` one of the same name, which shadows a
`service` one. Every installed skill is a service-origin definition, enabled
by default; a disabled skill is invisible to you but still listed for the
client.

## Read before you install

The instructions are the skill: `READ (skill://<name>/SKILL.md)` for the
procedure, `FIND (skill://<name>/**)` for its files, and
`EXEC [runtime] (skill://<name>/scripts/<program>)` to run one of its scripts
under the ordinary proposal policy. Skill resources are read-only; you do not
`EDIT` an installed skill.

Reach for `discover` when the task names a capability no enabled skill
provides: `{"query": "..."}` searches the standard registry and returns one
candidate per hit with its exact `owner/repo` source; `{"source": "owner/repo"}`
lists the skills one package contains. Discovery never installs anything.

## Installing

`add` installs a skill through the standard installer and enables it:

```example
### EXEC_ [skills] (add) <!-- from a discover candidate -->
{"alias": "sql-formatter", "definition": {"name": "sql-formatter", "scope": "project", "source": "example/skills"}}
```

The alias must equal the skill's `name`; `source` is required unless the
directory already exists; `scope: "project"` needs a project root and writes
under `.agents/skills`. Installation is a host effect, so it proposes and runs
only on acceptance. A skill that fails to install or has invalid frontmatter is
listed `unavailable` with its exact Problem — one bad skill never disables the
family. `remove` uninstalls what this worker installed; service skills can only
be disabled.
