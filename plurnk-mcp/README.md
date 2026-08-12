# @plurnk/plurnk-mcp

The current [Model Context Protocol](https://modelcontextprotocol.io/) host
module for [Plurnk](https://github.com/plurnk/plurnk-service).

Each configured MCP server becomes a model-facing executor and resource
authority:

```plurnk
## READ0 (github:///)

## EXEC0 [github] (create_issue)
{"title":"Bug"}

## FIND0 (github:///resources/**)

## READ0 (github:///resources/https%3A%2F%2Fexample.test%2Fdocument)
```

The module requires protocol revision `2026-07-28`. It does not negotiate or
fall back to a legacy revision.

## Configuration

Configuration is daemon-owned. One `PLURNK_MCP_<server>` variable declares
each server; the suffix case-folds to the executor and URI authority name.

Streamable HTTP:

```text
PLURNK_MCP_github=https://example.test/mcp
PLURNK_MCP_github_HEADERS={"Authorization":"Bearer ${GITHUB_TOKEN}"}
```

Stdio:

```text
PLURNK_MCP_local=/absolute/path/to/executable
PLURNK_MCP_local_ARGS=["--stdio"]
PLURNK_MCP_local_CWD=/absolute/working/directory
PLURNK_MCP_local_ENV={"TOKEN":"${LOCAL_TOKEN}"}
```

The stdio target is exactly one executable. Arguments are a JSON array; the
module never parses or invokes a shell command. `${NAME}` references read the
daemon's inherited environment at startup, so secrets do not need to be copied
into Plurnk environment files.

Portable timeout defaults and complete examples live in
[`.env.defaults`](./.env.defaults).

## Current surface

- `## READ0 (server:///)` returns the live tools, resources, resource templates, and
  prompts catalog.
- `## EXEC0 [server] (tool)` calls a tool with one JSON object in the body.
- `server:///resources` exposes the resource catalog through ordinary Plurnk
  `FIND` and `READ` sections.
- `server:///resources/<encoded-uri>` reads a concrete MCP resource and stores
  it as an ordinary entry, after which normal projection and slicing apply.
- A tool's `readOnlyHint` selects Plurnk's read effect. Unknown or mutating
  tools retain the host effect.

Prompt retrieval, resource subscriptions, current multi-round-trip input,
current task methods, and OAuth/OIDC authorization are not part of this
vertical slice. They will use the same module and connection seams; no legacy
protocol surface is retained as a fallback.

## Verification

`npm test` type-checks the module and exercises exact current-version
negotiation, configuration, tool calls, resource reads, runtime registration,
and rejection of ambiguous shell and secret configuration.
