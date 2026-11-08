# personas

A Persona is a reusable operating identity (`name` and `description` frontmatter, optional `model` and `effort` selectors, then Markdown instructions). Enabled personas appear at turn 0 as `persona://<name>/PERSONA.md`; nothing is injected until read or copied into `session://<session>/AGENTS.md`.

## Where personas come from

| Source | Root | Precedence |
| --- | --- | --- |
| `project` | `<project root>/.agents/personas/<name>.md` or `<name>/PERSONA.md` | 1 (highest standalone) |
| `plurnk` | `$XDG_CONFIG_HOME/plurnk/personas/<name>.md` or `<name>/PERSONA.md` | 2 |
| `xdg-global` | `$XDG_CONFIG_HOME/agents/personas/<name>.md` or `<name>/PERSONA.md` | 3 |
| `global` | `~/.agents/personas/<name>.md` or `<name>/PERSONA.md` | 4 |
| plugin | `personas/<name>.md` or `personas/<name>/PERSONA.md` in an Agent Plugin | Joins its installation scope after standalone personas |

Environment definitions (`PLURNK_PERSONAS_<alias>`) override filesystem roots, and `plurnk.personas` or `plurnk.edit` on `persona://` creates a workspace override above that:

```sh
PLURNK_PERSONAS_reviewer='{"source":"/srv/personas/reviewer"}'
PLURNK_PERSONAS_professor='{"description":"Rigorous first-principles teacher.","body":"Explain from invariants before examples.","effort":"high"}'
PLURNK_PERSONAS_ENABLED=1
PLURNK_PERSONAS_reviewer_ENABLED=0
```

## Reading, applying, and editing

- Read at `await plurnk.read({ path: "persona://<name>/PERSONA.md" });` (or `persona://<name>.md`).
- Apply to a session by copying to its instruction sheet:

await plurnk.copy({ from: "persona://reviewer/PERSONA.md", to: "session://child/AGENTS.md" });

- Create or replace a workspace persona with `plurnk.edit` (Markdown with frontmatter or JSON definition), and remove or disable with `plurnk.kill`:

await plurnk.edit({ path: "persona://professor/PERSONA.md", text: "---\ndescription: Rigorous first-principles teacher.\neffort: high\n---\nExplain from invariants before examples." });

## Adding and managing

| Call | Effect |
| --- | --- |
| `await plurnk.personas({});` | List personas with origin, model/effort selectors, and status. |
| `await plurnk.personas({ discover: true });` | List candidate personas from active roots/plugins (`discover: "<query>"` filters; `discover: { source: "<path>" }` inspects a file or directory). |
| `await plurnk.personas({ name, description, body, model?, effort? });` | Bind and enable an inline workspace persona (or `{ name, source, model?, effort? }` from a path). |
| `await plurnk.personas({ name, enabled: false });` | Disable (`false`) or re-enable (`true`) a persona. |
| `await plurnk.personas({ name, remove: true });` | Remove a workspace override and restore any inherited definition. |

await plurnk.personas({ name: "professor", description: "Rigorous first-principles teacher.", body: "Explain from invariants before examples.", effort: "high" });
