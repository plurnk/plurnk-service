# Plurnk personas specification

## §persona-discovery 1. Module, Workspace Family, and Discovery Cascade

`@plurnk/plurnk-personas` exports its daemon module at `./module` ({§module-lifecycle}), registering the `personas` Functionality family ({§functionality-coordinator}), the writable `persona://` resource tree ({§resource-tree-scheme}), and the workspace persona projection reader (`PersonaRegistrySeam`, {§module-seam-slices}) during `setup`.

| Layer (low to high) | Definition source & contract |
| --- | --- |
| Standard locations | `PLURNK_SERVICE_ROOTS`-filtered configuration roots (`<project>/.agents/personas`, `$XDG_CONFIG_HOME/plurnk/personas`, `$XDG_CONFIG_HOME/agents/personas`, `~/.agents/personas`, {§functionality-inspection}). Within each root, `<name>/PERSONA.md` directories scan before `<name>.md` single files (`name` matching `SKILL_NAME`); nearer roots shadow farther ones. Project-scoped `<project>/.agents/personas/` entries (directories, `PERSONA.md`, and single `.md` files) must physically resolve inside `projectRoot` via `realpath`; symlink escapes outside `projectRoot` are silently omitted. |
| Cascading environment | `PLURNK_PERSONAS_<alias>` JSON definitions (`{"source":"…","model"?:"…","effort"?:"…"}` or `{"description":"…","body":"…","model"?:"…","effort"?:"…"}`), gated by `PLURNK_PERSONAS_ENABLED` and `PLURNK_PERSONAS_<alias>_ENABLED` ({§env-knob}), plus workspace local-source confinement control `PLURNK_PERSONAS_ALLOW_LOCAL_SOURCES` (default `1`). Invalid environment JSON, schema, or control values record a contained module configuration diagnostic ({§module-contract}) without failing healthy siblings. |
| Live workspace | `personas` (`workspace.personas.*`, `plurnk.personas`, `mcp:///plurnk/personas.json`) persists overrides under `@plurnk/plurnk-personas` in `workspace_module_state` ({§functionality-replacement}). `discover` supports empty/substring query over active roots or `source` inspection of a file/directory. When `PLURNK_PERSONAS_ALLOW_LOCAL_SOURCES=0`, workspace `discover({ source })`, `admit({ source })` (including `persona://` JSON `{ source }` edits), and persisted non-operator `{ source }` definitions refuse with `403 persona-source-forbidden` before touching the filesystem (no path-existence oracle), while inline `{ description, body }` personas, exact operator `PLURNK_PERSONAS_<alias>` definitions, and configured roots remain available. Malformed `PLURNK_PERSONAS_ALLOW_LOCAL_SOURCES` fails closed (`503 configuration-invalid`; `policy()` advertises `{ allowLocalSources: false }`). |

- **Frontmatter & body**: Every persona document requires YAML frontmatter (`name` matching `<name>`, non-empty `description` $\le 1024$ chars, optional non-empty `model` selector, optional `effort` in `EFFORTS`) and a non-empty trimmed Markdown instruction `body`. Malformed discovered files emit `personas` `configuration_invalid` warnings without blocking valid siblings.
- **Hotload & cold projection**: Resident workspaces recompute a SHA-256 signature over discovered roots, environment definitions, and enabled sources under the turn gate (`refreshIfChanged`, {§functionality-inspection}); cold workspaces resolve `readWorkspaceModuleState` over `available` definitions directly so `listPersonas` and session creation need no workspace residency.

## §persona-scheme 2. Persona Resource Tree and Mutations

Validated personas publish `ContainedDirectoryTree`, `SingleFileResourceTree`, or `InlineResourceTree` instances ({§provided-skills-module-slice}) onto `persona://` via `ResourceTreeRegistrationSeam` ({§resource-tree-scheme}):

| Operation / Address | Contract |
| --- | --- |
| Canonical & shorthand coordinates | `PersonaScheme.normalizeAddress` resolves `persona://<name>/PERSONA.md`, `persona://<name>.md`, `persona://<name>`, and `persona:///<name>[.md]` to `{ authority: "<name>", pathname: "/PERSONA.md" }` (preserving `persona://<name>/<subpath>` for contained supporting files and glob authorities for `FIND`). |
| `READ` & `FIND` | Demand-loads `PERSONA.md` and contained directory files (`404 entry-not-found` when absent, `403 resource-outside-root` on lexical or symlink escape, `400 resource-invalid` on non-file/cycle). Turn 0 surveys `persona://*/PERSONA.md` (`1,-1`, {§session-initialization-entry}) when personas exist. |
| `EDIT` (`editBatch`) | Whole-resource `plurnk.edit({ path: "persona://<name>/PERSONA.md", text })` accepts Markdown with YAML frontmatter (injecting `name: <name>` when omitted) or a JSON definition object and invokes `replace` (`400 value-whole` on line/pattern scopes, `400 target-invalid` on non-`PERSONA.md` or invalid names, `400 persona-invalid` on malformed bodies). |
| `KILL` (`kill`) | Whole-resource `plurnk.kill({ path: "persona://<name>/PERSONA.md" })` invokes `remove` on workspace overrides and `disable` on active service-origin personas (`404 entry-not-found` when absent or already disabled; `400 value-whole` on line/pattern scopes). |
