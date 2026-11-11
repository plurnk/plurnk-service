# Extending Plurnk

## Summary

Extend Plurnk with configuration, personas, Agent Skills, MCP servers, Agent Plugins, ACP v2 clients, notification consumers, and first-party `@plurnk/*` packages.

## Choosing a surface

Surfaces run from least to most code and trust:

- **Configuration**: a setting in the cascade, or a definition in `mcp.json`, a skill root, or a persona root.
- **Operating policy** (`AGENTS.md` / `AGENTS.local.md`): standing instructions in a user environment, project, or session (`session://<session>/AGENTS.md`).
- **A persona** (`persona://<name>/PERSONA.md`, managed via `plurnk.personas` or `plurnk.edit`): a reusable operating identity, optional model/effort route, and instruction body selected per session or copied to `session://<session>/AGENTS.md`.
- **A skill**: knowledge or scripts run with existing runtimes (`sh`, `js`).
- **An MCP server**: an external process or HTTP endpoint exposing tools, resources, or prompts over MCP.
- **A plugin**: an Agent Plugins `1.0.0` directory bundling skills, personas, and MCP servers together.
- **A client**: an external application driving Plurnk over ACP v2 at `/acp`.
- **A notification consumer**: an external subscriber reading `DaemonNotification` events from `GET /notifications` SSE.
- **An extension**: a first-party `@plurnk/*` package loaded in-process at daemon startup to provide a runtime (`exec`), address scheme (`scheme`), media-type reader (`mimetype`), or model provider (`provider`).
- **A module**: a first-party `DaemonModule` composed by the service (`@plurnk/plurnk-modules`) to manage a functionality family, mount a listener route, or observe daemon lifecycle.

## Plurnk uses X

| Surface | Shape | The model sees | Code in the daemon |
| --- | --- | --- | --- |
| Persona | `<name>.md`, `<name>/PERSONA.md`, or inline definition | `persona://<name>/PERSONA.md` | none |
| Skill | directory holding `SKILL.md` | `skill://<name>/` | none |
| MCP server | one MCP definition | runtime `<server>.<tool>` and scheme `<server>://` | none: a process or URL |
| Plugin | directory holding `plugin.json`, `skills/`, `personas/`, `mcp.json` | its skills, personas, and MCP servers | none |
| Extension | `@plurnk/*` npm package declaring `package.json#plurnk` | runtime, scheme, media-type reader, or model provider | first-party, in the daemon |

Manage personas, skills, and MCP definitions live in the current workspace via `plurnk.personas`, `plurnk.skills`, and `plurnk.mcp` (`mcp:///plurnk/<tool>.json`).

## X uses Plurnk

| Surface | Shape | Code in the daemon | Contract |
| --- | --- | --- | --- |
| Application | ACP v2 client: WebSocket or Streamable HTTP JSON-RPC 2.0 at `/acp` (`PLURNK_PORT`), authenticated via OAuth 2.1 (`/.well-known/*`, `/oauth/*`) when `PLURNK_AUTH=1` | none | `skill://plurnk/packages/@plurnk/plurnk-acp/SPEC.md`, `skill://plurnk/packages/@plurnk/plurnk-auth/SPEC.md` |
| Notification stream | Server-Sent Events consumer at `GET /notifications[?event=...&workspace=...&session=...]` (`PLURNK_PORT`), authenticated via OAuth 2.1 bearer token (`acp` or `notifications` scope) | none | `skill://plurnk/packages/@plurnk/plurnk-service/SPEC.md`, `skill://plurnk/packages/@plurnk/plurnk-contracts/SPEC.md` |

## First-party framework packages

First-party `@plurnk/*` extension packages declare `plurnk` in `package.json`:

| Kind | Adds | Kind-owned field | Contract |
| --- | --- | --- | --- |
| `exec` | runtimes invoked as tool calls | `runtimes` or `runtimesModule` | `skill://plurnk/packages/@plurnk/plurnk-execs/SPEC.md` |
| `scheme` | address schemes | `schemes`, or `name` for one | `skill://plurnk/packages/@plurnk/plurnk-schemes/SPEC.md` |
| `mimetype` | readers for media types | `handlers` | `skill://plurnk/packages/@plurnk/plurnk-mimetypes/SPEC.md` |
| `provider` | a model provider | `name` | `skill://plurnk/packages/@plurnk/plurnk-providers/SPEC.md` |

First-party daemon modules implement `DaemonModule` (`@plurnk/plurnk-modules/SPEC.md`) and are composed statically by `@plurnk/plurnk-service`.

## Examples

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

First-party scheme package `package.json` (default export is the scheme handler):

```json
{
    "name": "@plurnk/plurnk-schemes-notes",
    "type": "module",
    "exports": { ".": "./dist/index.js" },
    "plurnk": { "kind": "scheme", "name": "notes" }
}
```

First-party `DaemonModule` `./module` export:

```js
export default () => ({
    setup(seam) {},
    async stop() {},
});
```

## Contracts

`skill://plurnk/packages/<package name>/SPEC.md` and sibling `dist/*.d.ts` declarations hold each installed `@plurnk/*` package's contract; search them with `plurnk.find`.
