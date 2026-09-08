# mcp

An MCP server is an external process (`stdio`) or endpoint (`http`) that
publishes tools. Once a server is enabled, it is a runtime here under its own
name: each tool is a target — `### EXEC_ [<server>] (<tool>)` with a JSON
body — and its input schema and result channel are documented at
`worker://~/_plurnk/plurnk/<server>.md` and `worker://~/_plurnk/tools/`. You
never speak the protocol yourself; one EXEC is one tool call.

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
carrying the exact definition to add. Discovery persists and enables nothing.

```example
### EXEC_ [mcp] (discover) <!-- inspect before adding -->
{"source": "npx -y @modelcontextprotocol/server-filesystem ."}
```

`add` persists the definition for this worker, connects, and enables it
atomically. It is a host effect: it proposes and runs only on acceptance.

```example
### EXEC_ [mcp] (add)
{"alias": "files", "definition": {"name": "files", "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]}}
```

A `stdio` definition carries `command` and optional `args`, `cwd`, `env`; an
`http` definition carries `url` and optional `headers`. `tools` narrows the
enabled tool set and `read` names the tools that are read-only (every other
tool keeps the conservative `host` effect and proposes before it runs). A
credential is a symbolic reference such as `"${TOKEN}"` to the operator's
environment, never a pasted secret.

## Authorization

An `http` server that needs OAuth comes up `unavailable` with an
authorization URL in its Problem. Only the user can complete that step, from
their client; afterwards `enable` retries and the tools appear. Do not try to
fetch the authorization URL or supply credentials in a body.

## Lifecycle

`disable` withdraws a server's tools while keeping its definition; `remove`
deletes a definition this worker added. Operator-configured servers
(`PLURNK_MCP_<server>` in the service environment) can only be disabled. When
a server's published tools change, its document is regenerated; `FIND` the
reference again after enabling before relying on a tool's signature.
