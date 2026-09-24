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
shows every configured server, including disabled ones and unavailable ones
with their exact Problem; `enable` turns a configured server on; `discover`
inspects a server before anything is attached.

## discover, then add

`discover` takes `{"source": "<URL or command line>"}`: the server is
connected once, its tool list is read, and one inert candidate comes back
carrying the exact definition to add. Discovery never persists or enables a
server definition.

```mcp (discover) <!-- inspect before adding -->
{"source": "npx -y @modelcontextprotocol/server-filesystem /absolute/project/path"}
```

`add` persists the definition for this workspace, connects, and enables it
atomically. It is a host effect, admitted under the loop's policy.

```mcp (add)
{"alias": "files", "definition": {"name": "files", "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/absolute/project/path"]}}
```

A `stdio` definition carries `command` and optional `args`, `cwd`; an `http`
definition carries `url` and optional `headers`. `tools` narrows the enabled
tool set and `read` names the tools that are read-only; every other tool keeps
the conservative `host` effect. A credential is a symbolic reference such as
`"${TOKEN}"` to the operator's environment, never a pasted secret.

Local servers start in their workspace's server directory under
`XDG_STATE_HOME` (normally `~/.local/state/plurnk`), not in the project:
project inputs and outputs are absolute paths, or `cwd` is set explicitly when
a server requires it. State survives reconnects and disable/remove; a discovery
probe uses a temporary directory removed after it closes. This is file
placement, not a sandbox.

## Environment

Workspace variables, set with the `env` family (`env.md`) before discovering
or adding a local server, reach every server launch; worker-local overrides do
not. A running server keeps its launch environment; `disable` then `enable`
restarts it with the current workspace values, without a daemon restart.

## Authorization

An `http` server that needs OAuth comes up `authorization-required` with an
authorization URL. That step is the user's, from their client; a body carries
no credentials and the URL is not a resource to READ. Afterwards `enable`
retries and the tools appear.

## Lifecycle

`disable` withdraws a server's tools while keeping its definition; `remove`
deletes a workspace definition. Operator-configured servers
(`PLURNK_MCP_<server>` in the service environment) are disable-only. The
family document projects the enabled-tool snapshot: after `enable`, FIND the
reference again before relying on a tool's signature.
