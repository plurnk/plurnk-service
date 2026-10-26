# mcp

An MCP server publishes tools, and an enabled server is a runtime here under
its own name. A tool runs the way `sh` or `js` runs: a fenced call names the
server and the tool, and its body is the tool's JSON arguments.

```files (list_directory) <!-- server (tool) -->
{"path": "/absolute/project/path"}
```

One fenced call runs one tool, and the result is that call's output.
`workspace:///_plurnk/tools/<server>.md` lists a server's invocations and their
required top-level inputs; each invocation links to the complete raw input
schema. Its sibling `<server>.json` contains `{"tools":[...]}` with complete
tool definitions, including input/output schemas, descriptions, and annotations.
Both documents reflect the same enabled tools. JSONPath selects individual
definitions without reading the whole catalog:

```READ (workspace:///_plurnk/tools/files.json) $.tools[?(@.name=="list_directory")]
```

The turn-0 catalog lists every enabled server's Markdown document. `list`
shows every server, including disabled ones and unavailable ones with their
exact Problem; `enable` turns a server on. An unavailable server's Problem
reports elapsed preparation time, its configured timeout, and any bounded,
redacted connection diagnostic or session stderr available to the host.

## discover, then add

`discover` is present when the operator configures an MCP Registry. It takes
`{"query": "<name>"}` and searches that registry; each candidate carries the
exact definition to add. Discovery never persists or enables anything.

```plurnk (mcp) <!-- search before adding -->
{"verb": "discover", "query": "filesystem"}
```

`add` saves and enables a workspace definition, then reports its connection
state. It is a host effect, subject to approval. Inspect that state:
saved configuration does not imply a connected server.

```plurnk (mcp)
{"verb": "add", "alias": "files", "definition": {"name": "files", "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/absolute/project/path"]}}
```

A complete definition names one transport: `stdio` has `command` and optional
`args`, `env`, `cwd`; `streamable-http` has `url` and optional `headers`,
`authorization`. Native definitions run local commands without a shell, in workspace-owned state
unless `cwd` supplies an absolute directory. Use absolute project paths in
arguments. This is file placement, not a sandbox or plugin installation.
A tool marked `readOnlyHint` runs as a read; other tools retain the `host` effect.

To change a definition, use `replace` with the same `{alias, definition}` shape.
Supply the complete definition; omitted fields are not inherited. It retains
enabledness and preserves the old server if the replacement is refused. A disabled
definition is saved without connecting; a new alias is created enabled.

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

A local server's inherited environment excludes Plurnk settings and model
provider keys; explicit definition bindings are separate.
Workspace variables set with the `env` family (`workspace:///_plurnk/tools/plurnk/env.json`) apply on top at
every server launch; session-local overrides do not. A running server keeps its
launch environment; `disable` then `enable` restarts it with the current
workspace values, without a daemon restart.

```plurnk (env)
{"verb": "add", "scope": "workspace", "alias": "SERVICE_TOKEN", "definition": {"value": "<credential>"}}
```

Native definitions resolve `${NAME}` once against the operator's environment
with workspace values and masks applied, in arguments, environment values,
working directories, HTTP headers, and authorization. This includes credentials
excluded from inheritance: `"env": {"GEMINI_API_KEY": "${GEMINI_API_KEY}"}` in a
native server definition supplies that key only to that server. The definition
retains the reference, not a copied credential, and follows ordinary launch
approval. A missing reference prevents launch.
Structured authorization secrets must be references, not literal credentials.

## Authorization

For an OAuth server, start by adding its URL; the client supplies the callback.

```plurnk (mcp)
{"verb": "add", "alias": "remote", "definition": {"name": "remote", "type": "streamable-http", "url": "https://example.com/mcp"}}
```

When a server requires OAuth sign-in, Plurnk notifies the user in the client and
holds `add`, `replace`, or `enable` until sign-in completes. Once the operation
returns `active`, the server's tool reference is ready for the next turn; an
active server's `detail.grant` names the sign-in it holds. Neither the sign-in
URL nor callback is a resource to READ.

An advanced `authorization` definition can specify scope, client registration,
the authorization server (`issuer`) or extra request parameters; the add schema
describes it. A fixed redirect is optional. Bearer credentials
remain environment references. `unavailable` includes a Problem: repair its
reported cause rather than assuming every failure is an OAuth challenge.

## Lifecycle

`disable` withdraws a server's tools while keeping its definition. `remove`
undoes the workspace definition and restores any inherited definition and
enabled state; use `disable` to suppress an inherited server. Neither action
deletes configuration files or saved results. The runtime document projects
the enabled-tool snapshot: after
`enable`, FIND the reference again before relying on a tool's signature.
