# @plurnk/plurnk-mcp

The current [Model Context Protocol](https://modelcontextprotocol.io/) host
module for [Plurnk](https://github.com/plurnk/plurnk-service).

Each configured MCP server becomes a model-facing executor and resource
authority. Enabled tools appear directly in Plurnk's Registered Tools table:

```plurnk
## EXEC0 [github] (issue_read)
{"owner":"acme","repo":"project","issue_number":42,"method":"get"}

## FIND0 (github:///resources/**)

## READ0 (github:///resources/https%3A%2F%2Fexample.test%2Fdocument)
```

The module requires protocol revision `2026-07-28`. It does not negotiate or
fall back to a legacy revision.

## Configuration

Configuration is daemon-owned. One `PLURNK_MCP_<server>` variable declares
each server; its suffix case-folds to an `[a-z][a-z0-9-]*` executor and URI
authority name.

Streamable HTTP:

```text
PLURNK_MCP_github=https://example.test/mcp
PLURNK_MCP_github_BEARER=${GITHUB_TOKEN}
PLURNK_MCP_github_TOOLS=["issue_read","issue_search"]
PLURNK_MCP_github_READ=["issue_read","issue_search"]
```

Stdio:

```text
PLURNK_MCP_local=/absolute/path/to/executable
PLURNK_MCP_local_ARGS=["--stdio"]
PLURNK_MCP_local_CWD=/absolute/working/directory
PLURNK_MCP_local_ENV={"TOKEN":"${LOCAL_TOKEN}"}
```

The stdio target is exactly one executable path or name, including any literal
whitespace. Arguments are a JSON array; the module never parses or invokes a
shell command. `${NAME}` references read the daemon's inherited environment at
startup, so secrets do not need to be copied into Plurnk environment files.

`PLURNK_MCP_<server>_TOOLS` is an optional JSON array of exact tool names.
Absent enables all server tools; an array enables exactly those names; `[]`
enables none. Only enabled tools appear in Registered Tools, their generated
kernel document, and EXEC admission. `PLURNK_MCP_<server>_READ` is an exact
enabled-tool subset whose calls use Plurnk's read effect; all other calls
conservatively use the host effect.

Portable timeout defaults and complete examples live in
[`.env.defaults`](./.env.defaults).

## Current surface

- Registered Tools contains one exact row per enabled tool, including its
  JSON-shaped invocation signature.
- `worker://plurnk/docs/<server>.md` contains the enabled tools' exact input
  and output schemas through the standard kernel documentation surface.
- `## EXEC0 [server] (tool)` calls a tool with one JSON object in the body.
- `## READ0 (server:///)` returns the resource catalog only; tools have no
  parallel FIND/READ discovery surface.
- `server:///resources` exposes the resource catalog through ordinary Plurnk
  `FIND` and `READ` sections.
- `server:///resources/<encoded-uri>` reads a concrete MCP resource and stores
  it as an ordinary entry, after which normal projection and slicing apply.
- Remote annotations remain catalog data and never grant effect authority.
  Only the operator-owned `_READ` list selects Plurnk's read effect.

Prompt retrieval, resource subscriptions, current multi-round-trip input,
current task methods, and OAuth/OIDC authorization are not part of this
vertical slice. They will use the same module and connection seams; no legacy
protocol surface is retained as a fallback.

## Verification

`npm test` type-checks the module and exercises exact current-version
negotiation, configuration, generated tool signatures and docs, closed EXEC
admission, tool calls, resource reads, runtime registration, canonical names,
exact executable/argument handling, and secret references.
