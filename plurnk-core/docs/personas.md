# personas

A Persona is a reusable operating identity (`name` and `description`
frontmatter, optional `model` and `effort` selectors, then Markdown
instructions). Enabled personas appear in the turn-0 catalog as
`persona://<name>/PERSONA.md`; nothing is injected until it is READ or copied
into a session's `AGENTS.md`.

## Where personas come from

| Source | Root | Who put it there |
| --- | --- | --- |
| `project` | `<project root>/.agents/personas/<name>.md` or `<name>/PERSONA.md` | the repository (often committed) |
| `plurnk` | `$XDG_CONFIG_HOME/plurnk/personas/<name>.md` or `<name>/PERSONA.md` | the user, for plurnk alone |
| `xdg-global` | `$XDG_CONFIG_HOME/agents/personas/<name>.md` or `<name>/PERSONA.md` | the user, for XDG-aware agents and projects |
| `global` | `~/.agents/personas/<name>.md` or `<name>/PERSONA.md` | the user, for every agent and project |
| plugin | `personas/<name>.md` or `personas/<name>/PERSONA.md` inside an installed Agent Plugin | a project, user or npm installation |

A `project` persona shadows a `plurnk` one of the same name, which shadows an
`xdg-global` one, which shadows a `global` one. Plugin personas join their
installation's scope after standalone personas; npm bundles follow global roots.
The cascading environment can define or replace a persona above them;
`plurnk (personas)` or `EDIT (persona://<name>/PERSONA.md)` creates a
workspace override above that. Declared personas are enabled by default. A
disabled persona remains listed but has no resource tree.

```sh
PLURNK_PERSONAS_reviewer='{"source":"/srv/personas/reviewer"}'
PLURNK_PERSONAS_professor='{"description":"Rigorous first-principles teacher.","body":"Explain from invariants before examples.","effort":"high"}'
PLURNK_PERSONAS_ENABLED=1
PLURNK_PERSONAS_reviewer_ENABLED=0
```

The environment key preserves the persona name, replacing hyphens with
underscores. Behavior controls override independently of the definition; an
empty definition is invalid.

## Reading, applying, and editing a persona

Read a persona at `READ (persona://<name>/PERSONA.md)` (or the shorthand
`persona://<name>.md`). Apply a persona to a session by copying it to that
session's instruction sheet:

```plurnk
COPY (persona://reviewer/PERSONA.md) (session://child/AGENTS.md)
```

Create or replace a workspace persona directly with `EDIT`, writing either a
Markdown document with frontmatter (`name` defaults to the target authority when
omitted) or a JSON definition object:

```plurnk
EDIT (persona://professor/PERSONA.md)
---
description: Rigorous first-principles teacher.
effort: high
---
Explain from invariants before examples.
```

`KILL (persona://professor/PERSONA.md)` removes a workspace override (restoring
any inherited definition) or disables an inherited service persona.

## discover

`discover` lists candidate personas from active roots and plugins when called
with `{"discover": true}` or `{"discover": "..."}`, or inspects a specific file or directory when
called with `{"discover": {"source": "..."}}`, returning one candidate per persona with the
exact definition to add.

## Adding and managing

`add` and `replace` bind one persona to this workspace and enable it, either
inline (`description` + `body`, plus optional `model` and `effort`) or from a
local `source` path (`.md` file or `<name>/PERSONA.md` directory, relative to
the project root or absolute):

```plurnk (personas)
{"alias": "professor", "description": "Rigorous first-principles teacher.", "body": "Explain from invariants before examples.", "effort": "high"}
```

`disable` suppresses a persona without forgetting its definition; `enable`
restores it. `remove` forgets a workspace override and restores any inherited
definition and enabled state. Inherited personas can be enabled or disabled
here; their definitions cannot be removed from this workspace.
