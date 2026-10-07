# Extending Plurnk

An integration points one way or both. Plurnk uses X when X's knowledge, tools,
agents or models reach the model. X uses Plurnk when X drives Plurnk as a
client or receives its lifecycle events. Each surface below states what it
reaches and where its code runs: nowhere, in an external process, or in the
daemon.

## Choosing a surface

The surfaces run from least to most code and trust, and each is for what the ones
before it cannot do:

- **Configuration** when what the integration needs already exists: a setting in
  the cascade, or a definition in `mcp.json` or a skill root.
- **A skill** when the model needs knowledge, or a script it runs with its existing
  runtimes (`sh`, `node`).
- **An MCP server** when X has an API the model calls as tools. A server X already
  publishes needs only its definition.
- **A plugin** when skills and MCP servers install together, or travel to other agents.
- **A client** when X drives Plurnk from outside: an application through AG-UI, an
  agent through A2A.
- **A hook** when X hears about Plurnk's lifecycle events and answers nothing.
- **An extension** only when the model needs something new inside the daemon that
  none of the above can add: a runtime, an address scheme, a media-type reader, a
  model provider or a page materializer. The operator installs and trusts it, and
  it loads when the daemon starts.
- **A module** only when the daemon itself serves or manages something: a family
  behind the six verbs, an endpoint on Plurnk's listener, or an observer of its events.

## Plurnk uses X

| Surface | Shape | The model sees | Code in the daemon |
| --- | --- | --- | --- |
| Skill | a directory holding `SKILL.md` | `skill://<name>/` | none |
| MCP server | one MCP definition | a runtime named for the server, its tools as invocation targets, and its resources as an address scheme | none: a process or a URL |
| A2A agent | one Agent Card URL | `a2a://<alias>`, a peer that takes tasks | none: a remote agent |
| Plugin | a directory holding `plugin.json`, `skills/` and `mcp.json` | its skills and MCP servers | none, unless it declares an extension |
| Extension | a package declaring one kind | a runtime, an address scheme, a media-type reader, a model provider, a page materializer, or what a module contributes | trusted, in the daemon |

Skills, MCP servers and A2A agents are definitions. The `skills`, `mcp` and
`a2a` runtimes add, enable, disable and remove them in the current workspace,
and `worker:///_plurnk/plurnk/skills.md`, `mcp.md` and `a2a.md` show each
definition's form. A definition needs no restart; an extension loads only when
the daemon starts.

## X uses Plurnk

| Surface | Shape | Code in the daemon |
| --- | --- | --- |
| Application | an AG-UI client: `POST /agui` with `RunAgentInput` on the daemon's listener (`PLURNK_PORT`) returns an event stream | none |
| Agent | an A2A client of the exposure that `PLURNK_A2A_EXPOSE` mounts | none |
| Command | the executable in `PLURNK_HOOKS_COMMAND`, run once per event named in `PLURNK_HOOKS_EVENTS` with one JSON line on stdin; its output and exit status change nothing | none |
| Protocol server | a module that declares mounts and serves its routes on the daemon's listener | trusted, in the daemon |

## Extensions

An extension is one package of one kind, declared once: under `plurnk` in its
`package.json`, or under `extensions.ai.plurnk` in a plugin's `plugin.json`.

| Kind | Adds | Kind-owned field | Contract |
| --- | --- | --- | --- |
| `exec` | runtimes the model invokes as fences | `runtimes` | `skill://plurnk/packages/@plurnk/plurnk-execs/SPEC.md` |
| `scheme` | address schemes | `schemes`, or `name` for one | `skill://plurnk/packages/@plurnk/plurnk-schemes/SPEC.md` |
| `mimetype` | readers for media types | `handlers` | `skill://plurnk/packages/@plurnk/plurnk-mimetypes/SPEC.md` |
| `provider` | a model provider | `name` | `skill://plurnk/packages/@plurnk/plurnk-providers/SPEC.md` |
| `http-materializer` | page rendering for web reads | `materializers` | `skill://plurnk/packages/@plurnk/plurnk-schemes-http/SPEC.md` |
| `module` | lifecycle membership: a definition family behind the six verbs, a protocol server, or an event observer | `module` | `skill://plurnk/packages/@plurnk/plurnk-modules/SPEC.md` |

- An extension loads when the daemon starts, from the service's installed npm
  packages. A module also loads from a plugin in `$XDG_CONFIG_HOME/plurnk/plugins/`
  or `~/.agents/plugins/`. A plugin in a project's `.agents/plugins/` contributes
  its skills and MCP servers, never code, and a package written into the project
  loads nothing until it is installed among the service's npm packages.
- `PLURNK_EXTENSIONS_TRUSTED_ONLY` gates loading: `@plurnk/*` packages always
  load, a third-party package loads only when the setting lists its package
  name, and `0` turns the gate off.
- A module exports one lifecycle object or a factory returning one. The daemon
  runs every module's `setup` before any module's `start`, then `stop` and
  `close` at shutdown; each member is optional.

A module exposing read-only resource folders can use `registerResourceTreeScheme`
from `@plurnk/plurnk-schemes`: it supplies names and original bytes; the host owns
MIME handling, entry projections and ordinary selection. See {§resource-tree-scheme}
in that package's contract. `@plurnk/plurnk-skills` is the built-in example; its
contract is `skill://plurnk/packages/@plurnk/plurnk-skills/SPEC.md`.

## Examples

The [Tavily plugin](https://github.com/plurnk/plurnk-tavily-plugin) is a working,
separately installed example: a standard `plugin.json`, one HTTP materializer
extension, its own configuration floor, and public-interface installation tests.
It is not bundled with the service.

A plugin directory, under a plugin root or packaged for npm:

```text
acme-tools/
├── plugin.json
├── mcp.json
└── skills/notes-format/SKILL.md
```

Its `plugin.json`:

```json
{
    "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    "name": "acme-tools",
    "description": "Acme skills and MCP servers."
}
```

Its `mcp.json`, where `$schema` and each server's `type` are required: without `$schema` the
plugin carries no MCP servers, and an entry without `type` is skipped. A stdio server starts in the
plugin's directory:

```json
{
    "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    "mcpServers": {
        "files": { "type": "stdio", "command": "node", "args": ["server.mjs"] }
    }
}
```

A scheme extension's `package.json`; its default export is the scheme handler:

```json
{
    "name": "@acme/plurnk-scheme-notes",
    "type": "module",
    "exports": { ".": "./dist/index.js" },
    "plurnk": { "kind": "scheme", "name": "notes" }
}
```

A module's `package.json` and its `./module` export:

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

`skill://plurnk/packages/` holds the `SPEC.md` of every installed package that
ships one, at `skill://plurnk/packages/<package name>/SPEC.md`, and beside it the
package's type declarations under `dist/`: `dist/index.d.ts` is the package root's,
and a relative import names a sibling file. FIND searches them by tag or term; each
contract's examples, tables and declarations are authoritative.
