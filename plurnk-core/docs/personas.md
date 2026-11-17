# personas

A Persona is a reusable operating identity (`name` and `description` frontmatter, optional `model` and `effort` selectors, then Markdown instructions). Enabled personas appear at turn 0 as `persona://<name>/PERSONA.md`; binding a persona to a session (`work`/`fork` `persona`, `schedule` `persona`, or client session options) injects its instructions dynamically into `system-policy` alongside `session://<session>/AGENTS.md`.

## Where personas come from

| Source | Root | Precedence |
| --- | --- | --- |
| `project` | `<project root>/.agents/personas/<name>.md` or `<name>/PERSONA.md` | 1 (highest) |
| `plurnk` | `$XDG_CONFIG_HOME/plurnk/personas/<name>.md` or `<name>/PERSONA.md` | 2 |
| `xdg-global` | `$XDG_CONFIG_HOME/agents/personas/<name>.md` or `<name>/PERSONA.md` | 3 |
| `global` | `~/.agents/personas/<name>.md` or `<name>/PERSONA.md` | 4 |

Environment definitions (`PLURNK_PERSONAS_<alias>`) override filesystem roots, and the `personas` tool or `edit` on `persona://` creates a workspace override above that:

```sh
PLURNK_PERSONAS_reviewer='{"source":"/srv/personas/reviewer"}'
PLURNK_PERSONAS_professor='{"description":"Rigorous first-principles teacher.","body":"Explain from invariants before examples.","effort":"high"}'
PLURNK_PERSONAS_ENABLED=1
PLURNK_PERSONAS_reviewer_ENABLED=0
```

## Reading, applying, and editing

- Read at `persona://<name>/PERSONA.md` (or `persona://<name>.md`) via `read`.
- Bind to a delegated child session via `work` or `fork` (`{"target": "session://child", "persona": "<name>", "text": "..."}`), or copy `persona://<name>/PERSONA.md` into `session://<session>/AGENTS.md` when customizing per-session instructions.
- Create or replace a workspace persona via `edit` on `persona://<name>/PERSONA.md` (Markdown with frontmatter or JSON definition), and remove or disable via `kill`.

## Adding and managing

| `personas` arguments | Effect |
| --- | --- |
| `{}` | List personas with origin, model/effort selectors, and status. |
| `{"discover": true}` | List candidate personas from active configuration roots (`"discover": "<query>"` filters; `"discover": {"source": "<path>"}` inspects a file or directory). |
| `{"name": "professor", "description": "...", "body": "...", "model"?: "...", "effort"?: "high"}` | Bind and enable an inline workspace persona (or `{"name": "...", "source": "<path>", ...}` from a path). |
| `{"name": "professor", "enabled": false}` | Disable (`false`) or re-enable (`true`) a persona. |
| `{"name": "professor", "remove": true}` | Remove a workspace override and restore any inherited definition. |
