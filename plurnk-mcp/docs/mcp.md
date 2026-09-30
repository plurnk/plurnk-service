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
schema. The turn-0 catalog lists every enabled server's document. `list`
shows every server, including disabled ones and unavailable ones with their
exact Problem; `enable` turns a server on; `discover` finds servers to add.

## discover, then add

`discover` takes `{"query": "<name>"}` and searches the MCP Registry; each
candidate carries the exact definition to add. Discovery never persists or
enables anything.

```mcp (discover) <!-- search before adding -->
{"query": "filesystem"}
```

`add` saves a workspace definition, connects, and enables it atomically. It is a host
effect, admitted under the loop's policy.

```mcp (add)
{"alias": "files", "definition": {"name": "files", "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/absolute/project/path"]}}
```

A complete definition names one transport: `stdio` has `command` and optional
`args`, `env`, `cwd`; `streamable-http` has `url` and optional `headers`,
`authorization`. Local commands run without a shell, in workspace-owned state
unless `cwd` supplies an absolute directory. Use absolute project paths in
arguments. This is file placement, not a sandbox or plugin installation.
A tool marked `readOnlyHint` runs as a read; other tools retain the `host` effect.

## Environment

A local server inherits the operator's environment, which is where it reads
its credentials, without plurnk's own settings or model provider keys.
Workspace variables set with the `env` family (`env.md`) apply on top at
every server launch; worker-local overrides do not. A running server keeps its
launch environment; `disable` then `enable` restarts it with the current
workspace values, without a daemon restart.

```env (add)
{"scope": "workspace", "alias": "SERVICE_TOKEN", "definition": {"value": "<credential>"}}
```

Definitions may reference workspace variables as `${NAME}` in arguments,
environment values, working directories, HTTP headers, and authorization.
Structured authorization secrets must be references, not literal credentials.

## Authorization

An HTTP server that needs OAuth comes up `authorization-required` with an
authorization URL. That step is the user's, from their client; a body carries
no credentials and the URL is not a resource to READ. Afterwards `enable`
retries and the tools appear.

## Lifecycle

`disable` withdraws a server's tools while keeping its definition. `remove`
undoes the workspace definition and restores any inherited definition and
enabled state; use `disable` to suppress an inherited server. Neither action
deletes configuration files or saved results. The family document projects
the enabled-tool snapshot: after
`enable`, FIND the reference again before relying on a tool's signature.
