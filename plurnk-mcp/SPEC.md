# Plurnk MCP host specification

## Current protocol boundary

- The only accepted MCP revision is `2026-07-28`.
- Every client connection pins that revision and verifies a modern
  `server/discover` result before registration.
- Stdio servers are invoked as an executable plus an explicit argument array.
  Shell command parsing is not part of the contract.
- HTTP uses Streamable HTTP. There is no legacy SSE fallback.
- A connection or discovery failure leaves no registered runtime.
- Shutdown waits for every connection attempt to settle, then closes every
  acquired connection and reports all close failures.

## Configuration

| Variable | Contract |
|---|---|
| `PLURNK_MCP_<server>` | HTTP(S) URL or exact stdio executable |
| `PLURNK_MCP_<server>_ARGS` | JSON string array for stdio |
| `PLURNK_MCP_<server>_CWD` | Working directory for stdio |
| `PLURNK_MCP_<server>_ENV` | JSON string map for stdio |
| `PLURNK_MCP_<server>_HEADERS` | JSON string map for HTTP |
| `PLURNK_MCP_CONNECT_TIMEOUT` | Positive integer milliseconds |
| `PLURNK_MCP_REQUEST_TIMEOUT` | Positive integer milliseconds |

Server names case-fold. Duplicate names, orphan companions, transport-specific
companions on the wrong transport, missing environment references, and invalid
JSON fail startup.

## Model-facing mapping

| MCP surface | Plurnk surface |
|---|---|
| Server | `## EXEC1 [server]` and `server://` |
| Tool catalog | `server:///` |
| Tool call | `## EXEC1 [server] (tool)` with a JSON object body |
| Resource catalog | `server:///resources` |
| Resource read | `server:///resources/<encoded-uri>` |

The executor manifest remains the owner of ordinary result coordinates. The
MCP resource facet claims only `/`, `/resources`, and descendants. Every other
path uses the standard executor-output scheme.

Tools and resources are current in this vertical slice. Cataloged prompts are
descriptive only. Prompt retrieval, subscriptions, multi-round-trip input,
tasks, and authorization remain unavailable until their current contracts are
implemented and covered; they do not fall back to legacy behavior.
