# skills

An Agent Skill is a directory holding `SKILL.md` (`name` and `description` frontmatter, then instructions) and optional sibling references, scripts, and assets. Enabled skills appear at turn 0 as `skill://<name>/SKILL.md`; nothing is injected until read.

## Where skills come from

| Source | Root |Precedence |
| --- | --- | --- |
| `project` | `<project root>/.agents/skills/<name>/` | 1 (highest standalone) |
| `plurnk` | `$XDG_CONFIG_HOME/plurnk/skills/<name>/` | 2 |
| `xdg-global` | `$XDG_CONFIG_HOME/agents/skills/<name>/` | 3 |
| `global` | `~/.agents/skills/<name>/` | 4 |
| `service` | Built-in service tree (`skill://plurnk/`) | 5 |
| plugin | `skills/<name>/` inside an installed Agent Plugin | Joins its installation scope after standalone skills |

Environment definitions (`PLURNK_SKILLS_<alias>`) override filesystem roots, and `plurnk.skills` creates a workspace override above that:

```sh
PLURNK_SKILLS_code_review='{"source":"/srv/skills/code-review"}'
PLURNK_SKILLS_ENABLED=1
PLURNK_SKILLS_code_review_ENABLED=0
```

## Reading and authoring a skill

- Read instructions with `await plurnk.read({ path: "skill://<name>/SKILL.md" });` and list companion files with `await plurnk.find({ path: "skill://<name>/**" });`.
- Run skill scripts with their executor (e.g. `await plurnk.js({ script: "skill://<name>/scripts/program.js", args: ["..."] });`). `skill://` is read-only.
- Author or edit project skills in the filesystem with `plurnk.edit` (and remove with `plurnk.kill`); standard roots are rescanned before every turn and hot-loaded into `skill://<name>/`:

await plurnk.edit({ path: ".agents/skills/code-review/SKILL.md", text: "---\nname: code-review\ndescription: Check diffs for contract, test, and migration regressions.\n---\n\nInspect changed files against the owning `SPEC.md` before approving." });

## Adding

| Call | Effect |
| --- | --- |
| `await plurnk.skills({});` | List skills with status, provenance, and any Problem. |
| `await plurnk.skills({ discover: "<source>" });` | Inspect a source (git `https`/`ssh` URL, `<server>:///skills`, folder, `SKILL.md`, or `.zip`/`.tar` archive) and return addable candidates without installing. |
| `await plurnk.skills({ name, source, ref? });` | Bind and enable skill `name` from `source` (optional git branch/tag `ref`). |
| `await plurnk.skills({ name, enabled: false });` | Disable (`false`) or re-enable (`true`) a skill without removing its definition. |
| `await plurnk.skills({ name, remove: true });` | Remove a workspace override and restore any inherited definition. |

`await plurnk.skills({ name: "sql-formatter", source: "https://git.example/acme/skills.git" }); // from a discover candidate`

- Local folders and `SKILL.md` paths stay live references; git, MCP, and archive sources materialize into workspace storage pinned to their commit or manifest digest.
