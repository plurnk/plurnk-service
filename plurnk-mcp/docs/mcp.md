# mcp

An MCP server publishes tools, and an enabled server is a runtime here under
its own name. A tool runs the way `sh` or `node` runs: a fenced call names the
server and the tool, and its body is the tool's JSON arguments.

```files (list_directory) <!-- server (tool) -->
{"path": "/absolute/project/path"}
```

One fenced call runs one tool, and the result is that call's output.
`worker:///_plurnk/tools/<server>.md` lists a server's invocations and their
required top-level inputs; each invocation links to the complete raw input
schema. Its sibling `<server>.json` contains `{"tools":[...]}` with complete
tool definitions, including input/output schemas, descriptions, and annotations.
Both documents reflect the same enabled tools. JSONPath selects individual
definitions without reading the whole catalog:

```READ (worker:///_plurnk/tools/files.json) $.tools[?(@.name=="list_directory")]
```

The turn-0 catalog lists every enabled server's Markdown document. `list`
shows every server, including disabled ones and unavailable ones with their
exact Problem; `enable` turns a server on; `discover` finds servers to add.

## discover, then add

`discover` takes `{"query": "<name>"}` and searches the MCP Registry; each
candidate carries the exact definition to add. Discovery never persists or
enables anything.

```mcp (discover) <!-- search before adding -->
{"query": "filesystem"}
```

`add` saves and enables a workspace definition, then reports its connection
state. It is a host effect, admitted under the loop's policy. Inspect that state:
saved configuration does not imply a connected server.

```mcp (add)
{"alias": "files", "definition": {"name": "files", "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/absolute/project/path"]}}
```

A complete definition names one transport: `stdio` has `command` and optional
`args`, `env`, `cwd`; `streamable-http` has `url` and optional `headers`,
`authorization`. Native definitions run local commands without a shell, in workspace-owned state
unless `cwd` supplies an absolute directory. Use absolute project paths in
arguments. This is file placement, not a sandbox or plugin installation.
A tool marked `readOnlyHint` runs as a read; other tools retain the `host` effect.

## Environment

Shared definitions may come from `~/.agents/mcp.json`,
`$XDG_CONFIG_HOME/plurnk/mcp.json`, or the project's `.agents/mcp.json`, each
containing a `mcpServers` map. Nearer files override farther ones; environment
definitions override files. `list` reports the winning file and entry.
Live management changes the workspace, never those files. File edits are
picked up before the next turn; enabledness and tool filters still use
`PLURNK_MCP_<alias>_ENABLED` and `PLURNK_MCP_<alias>_TOOLS`.

Installed Agent Plugins contribute servers from their root `mcp.json` through
the same family. Within each scope standalone definitions win; nearer scopes
win over farther ones. Plugin commands default to the plugin root and receive
`PLUGIN_ROOT` plus a persistent `PLUGIN_DATA` directory. Their arguments,
environment values, and cwd expand only those two placeholders; HTTP values
and all other placeholder-like text remain literal. `list` identifies the
source. A complete workspace override replaces these plugin semantics too.

A local server inherits the operator's environment, which is where it reads
its credentials, without plurnk's own settings or model provider keys.
Workspace variables set with the `env` family (`env.md`) apply on top at
every server launch; worker-local overrides do not. A running server keeps its
launch environment; `disable` then `enable` restarts it with the current
workspace values, without a daemon restart.

```env (add)
{"scope": "workspace", "alias": "SERVICE_TOKEN", "definition": {"value": "<credential>"}}
```

Native definitions may reference workspace variables as `${NAME}` in arguments,
environment values, working directories, HTTP headers, and authorization.
Structured authorization secrets must be references, not literal credentials.

## Authorization

For an OAuth server, start by adding its URL; the client supplies the callback.

```mcp (add)
{"alias": "remote", "definition": {"name": "remote", "type": "streamable-http", "url": "https://example.com/mcp"}}
```

`authorization-required` means the user must run `/mcp oauth remote` in their
client. Tell them the alias and that command; do not run it in a model executor.
The client opens the browser and receives the callback; Plurnk handles OAuth
and activates the tools. Neither the sign-in URL nor callback is a resource to
READ. After the user signs in, `list` confirms readiness and the server's tool
reference becomes available. `enable` alone does not sign in.

An advanced `authorization` definition can specify scope or client registration;
the add schema describes it. A fixed redirect is optional. Bearer credentials
remain environment references. `unavailable` includes a Problem: repair its
reported cause rather than assuming every failure is an OAuth challenge.

## Lifecycle

`disable` withdraws a server's tools while keeping its definition. `remove`
undoes the workspace definition and restores any inherited definition and
enabled state; use `disable` to suppress an inherited server. Neither action
deletes configuration files or saved results. The family document projects
the enabled-tool snapshot: after
`enable`, FIND the reference again before relying on a tool's signature.
