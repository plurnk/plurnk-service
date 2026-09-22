# mcp

An MCP server publishes tools, and an enabled server is a runtime here under
its own name. You run a tool the way you run `sh` or `node`: a fenced call
names the server and the tool, and its body is the tool's JSON arguments.

````files (list_directory) <!-- server (tool) -->
{"path": "/absolute/project/path"}
````

One fenced call runs one tool, and the result is that call's output.
`worker:///_plurnk/tools/<server>.md` lists a server's invocations and their
required top-level inputs; each invocation links to the complete raw input
schema when you need more detail.

## When to reach for a server

- The turn-0 catalog lists every enabled server's document. Prefer a published
  tool over reimplementing the same capability in `sh` or `node`.
- The user names a server or a tool that is not listed: `list` shows every
  configured server, including disabled ones and unavailable ones with their
  exact Problem; `enable` turns a configured server on.
- Nothing configured fits: `discover` inspects a server before anything is
  attached.

## discover, then add

`discover` takes `{"source": "<URL or command line>"}`: the server is
connected once, its tool list is read, and one inert candidate comes back
carrying the exact definition to add. Discovery never persists or enables a server definition.

````mcp (discover) <!-- inspect before adding -->
{"source": "npx -y @modelcontextprotocol/server-filesystem /absolute/project/path"}
````

`add` persists the definition for this workspace, connects, and enables it
atomically. It is a host effect: it proposes and runs only on acceptance.

````mcp (add)
{"alias": "files", "definition": {"name": "files", "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/absolute/project/path"]}}
````

A `stdio` definition carries `command` and optional `args`, `cwd`; an
`http` definition carries `url` and optional `headers`. `tools` narrows the
enabled tool set and `read` names the tools that are read-only (every other
tool keeps the conservative `host` effect and proposes before it runs). A
credential is a symbolic reference such as `"${TOKEN}"` to the operator's
environment, never a pasted secret.

Local servers start in their workspace's server directory under `XDG_STATE_HOME`
(normally `~/.local/state/plurnk`), not in the project. Use absolute paths for
project inputs and outputs, or set `cwd` explicitly when a server requires it.
State survives reconnects and disable/remove; a discovery probe uses a temporary
directory removed after it closes. This is file placement, not a sandbox.

## Environment

Set workspace variables with the `env` family (`worker:///_plurnk/plurnk/env.md`)
before discovering or adding a local server. Worker-local overrides do not configure
shared MCP processes.

````env (add)
{"scope":"workspace","alias":"NODE_ENV","definition":{"value":"production"}}
````

A running server keeps its launch environment; `disable` then `enable` restarts
that server with the current workspace values. No daemon restart is needed.

## Authorization

An `http` server that needs OAuth comes up `authorization-required` with an
authorization URL. Only the user can complete that step, from
their client; afterwards `enable` retries and the tools appear. Do not try to
fetch the authorization URL or supply credentials in a body.

## Lifecycle

`disable` withdraws a server's tools while keeping its definition; `remove`
deletes a workspace definition. Operator-configured servers
(`PLURNK_MCP_<server>` in the service environment) can only be disabled. When
a server's published tools change, its document is regenerated; `FIND` the
reference again after enabling before relying on a tool's signature.
