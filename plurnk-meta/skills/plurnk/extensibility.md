# Extending Plurnk

## Summary

Extend Plurnk with Agent Skills, plugins, hooks, MCP servers, scheme/mimetype/exec/provider packages, and ACP clients.

## Choosing a surface

Surfaces run from least to most code and trust:

- **Configuration**: a setting in the cascade, or a definition in `mcp.json`, a skill root, or a persona root.
- **Operating policy** (`AGENTS.md` / `AGENTS.local.md`): standing instructions in a user environment, project, or session (`session://<session>/AGENTS.md`).
- **A persona** (`persona://<name>/PERSONA.md`, managed via `plurnk.personas` or `plurnk.edit`): a reusable operating identity, optional model/effort route, and instruction body selected per session or copied to `session://<session>/AGENTS.md`.
- **A skill**: knowledge or scripts run with existing runtimes (`sh`, `js`).
- **An MCP server**: an external API the model calls as tools.
- **A plugin**: skills, personas, and MCP servers installed or shared together.
- **A client**: an external application driving Plurnk through ACP.
- **A hook**: an external command receiving lifecycle events on stdin.
- **An extension**: trusted code loaded at daemon startup (a runtime, address scheme, media-type reader, model provider, or page materializer).
- **A module**: daemon-managed functionality (a family behind the management verbs, a listener endpoint such as `/acp` or `/oauth/*`, or an event observer).

## Plurnk uses X

| Surface | Shape | The model sees | Code in the daemon |
| --- | --- | --- | --- |
| Persona | `<name>.md`, `<name>/PERSONA.md`, or inline definition | `persona://<name>/PERSONA.md` | none |
| Skill | directory holding `SKILL.md` | `skill://<name>/` | none |
| MCP server | one MCP definition | runtime `<server>.<tool>` and scheme `<server>://` | none: a process or URL |
| Plugin | directory holding `plugin.json`, `skills/`, `personas/`, `mcp.json` | its skills, personas, and MCP servers | none, unless it declares an extension |
| Extension | npm package declaring one kind | runtime, scheme, media-type reader, model provider, page materializer, or module | trusted, in the daemon |

Manage personas, skills, and MCP definitions live in the current workspace via `plurnk.personas`, `plurnk.skills`, and `plurnk.mcp` (`mcp:///plurnk/<tool>.json`). Extensions load at daemon startup.

## X uses Plurnk

| Surface | Shape | Code in the daemon | Contract |
| --- | --- | --- | --- |
| Application | ACP v2 client: WebSocket or Streamable HTTP JSON-RPC 2.0 at `/acp` (`PLURNK_PORT`), authenticated via OAuth 2.1 (`/.well-known/*`, `/oauth/*`) when `PLURNK_AUTH=1` | none | `skill://plurnk/packages/@plurnk/plurnk-acp/SPEC.md`, `skill://plurnk/packages/@plurnk/plurnk-auth/SPEC.md` |
| Command | executable in `PLURNK_HOOKS_COMMAND`, run once per event in `PLURNK_HOOKS_EVENTS` with one JSON line on stdin | none | `skill://plurnk/packages/@plurnk/plurnk-hooks/SPEC.md` |

## Extensions

Declare an extension under `plurnk` in `package.json`, or under `extensions.ai.plurnk` in a plugin's `plugin.json`.

| Kind | Adds | Kind-owned field | Contract |
| --- | --- | --- | --- |
| `exec` | runtimes invoked as tool calls | `runtimes` | `skill://plurnk/packages/@plurnk/plurnk-execs/SPEC.md` |
| `scheme` | address schemes | `schemes`, or `name` for one | `skill://plurnk/packages/@plurnk/plurnk-schemes/SPEC.md` |
| `mimetype` | readers for media types | `handlers` | `skill://plurnk/packages/@plurnk/plurnk-mimetypes/SPEC.md` |
| `provider` | a model provider | `name` | `skill://plurnk/packages/@plurnk/plurnk-providers/SPEC.md` |
| `http-materializer` | page rendering for web reads | `materializers` | `skill://plurnk/packages/@plurnk/plurnk-schemes-http/SPEC.md` |
| `module` | lifecycle membership (management family, listener mount, or event observer) | `module` | `skill://plurnk/packages/@plurnk/plurnk-modules/SPEC.md` |

- Extensions load at daemon startup from installed npm packages; modules also load from user plugins (`$XDG_CONFIG_HOME/plurnk/plugins/`, `$XDG_CONFIG_HOME/agents/plugins/`, `~/.agents/plugins/`). Project plugins (`.agents/plugins/`) contribute only skills, personas, and MCP servers, never code.
- `PLURNK_EXTENSIONS_TRUSTED_ONLY` gates loading: `@plurnk/*` always loads, third-party packages load when listed, and `0` disables the gate.
- A module exports `{ setup?, start?, stop?, close? }` or a factory returning one; read-only resource folders can use `registerResourceTreeScheme` from `@plurnk/plurnk-schemes`.

## Examples

See the [Tavily plugin](https://github.com/plurnk/plurnk-tavily-plugin) for a standalone HTTP materializer plugin.

A plugin directory:

```text
acme-tools/
├── plugin.json
├── mcp.json
└── skills/notes-format/SKILL.md
```

`plugin.json`:

```json
{
    "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    "name": "acme-tools",
    "description": "Acme skills and MCP servers."
}
```

`mcp.json` (`$schema` and each server's `type` are required; stdio servers start in the plugin directory):

```json
{
    "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    "mcpServers": {
        "files": { "type": "stdio", "command": "node", "args": ["server.mjs"] }
    }
}
```

Scheme extension `package.json` (default export is the scheme handler):

```json
{
    "name": "@acme/plurnk-scheme-notes",
    "type": "module",
    "exports": { ".": "./dist/index.js" },
    "plurnk": { "kind": "scheme", "name": "notes" }
}
```

Module `package.json` and `./module` export:

```json
{
    "name": "@acme/plurnk-module-pager",
    "type": "module",
    "exports": { "./module": "./dist/module.js" },
    "plurnk": { "kind": "module", "module": "./module" }
}
```

```js
export default () => ({
    setup(seam) {},
    async stop() {},
});
```

## Contracts

`skill://plurnk/packages/<package name>/SPEC.md` and sibling `dist/*.d.ts` declarations hold each installed package's contract; search them with `plurnk.find`.
