# mcp

The read face for MCP server-side state. Every server an operator configures (`PLURNK_EXECS_MCP_<server>=…`) is addressable as `mcp://<server>/…` — what the server **holds** is read here, while what its tools **do** is called via `<<EXEC[<server>](<tool>):<json-args>:EXEC`, whose results land behind `<server>://…` like every tag's output. Whoever owns the state names the address.

## Addresses

```
<<READ(mcp://<server>/)::READ                          capability-aware catalog: tools + resources (+ templates) + prompts
<<READ(mcp://<server>/tools/<name>)::READ              one tool's schema + annotations
<<READ(mcp://<server>/resources/<encoded-uri>)::READ   read a resource
<<READ(mcp://<server>/prompts/<name>?<args>)::READ     fetch a prompt (string-valued arguments as query params)
```

A resource's own URI rides as **one** path segment, `encodeURIComponent`-encoded: `file:///log.txt` → `mcp://build/resources/file%3A%2F%2F%2Flog.txt`. Resource **templates** are listed in the catalog; expand one and read the expanded URI through the same rule.

## Content

A single-part text resource lands with its **own** mimetype; anything else (multi-part, binary blob) lands as a JSON envelope. Catalogs, tool schemas, and prompts are JSON. The catalog reflects only what the server **advertises** — reading an unadvertised primitive fails exactly (`mcp_unadvertised`, 501), never as a generic transport error.

## Not supported — deliberately

Sampling, elicitation, and resource subscriptions are server-calls-back-into-us: they need the model loop or the user, which no scheme or executor can reach (the producer boundary). Declining them is MCP-conformant — a client advertises what it supports. A changed resource is a re-READ of a stable address.

## Auth

An OAuth-demanding server 401s (`mcp_auth_required`); the device-grant flow (authorize → show code → poll → install) is documented on the executor face. Both faces share one connection per server, so a token installed there serves reads here too.
