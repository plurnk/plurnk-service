# Intentional interoperability differences

PLURNK follows established protocols and conventions by default. This file
records product-level differences that materially affect interoperability. It
does not catalog ordinary implementation choices.

## MCP expression language

PLURNK models emit declarative MCP expressions (`<mcp>.<tool>({}) // aside`)
instead of provider-pushed JSON function-call schemas. Expressions address
resources with URIs and compose across installed schemes, executors, and MCP
servers.

This is the project's primary experiment: determine whether a compact MCP
expression language plus persistent addressable context improves reliability,
especially for smaller models.

Interoperability:

- PLURNK hosts MCP servers through `@plurnk/plurnk-mcp` (`@modelcontextprotocol/sdk`), exposing
  their tools and resources directly as `<mcp>.<tool>({})` expressions and `mcp://` URIs.
- Clients connect over ACP v2 (`@agentclientprotocol/sdk`).
- Provider adapters delegate multi-provider wire transport to `@earendil-works/pi-ai` and official provider APIs.

This difference is justified only if whole-product evaluations demonstrate an
advantage over conventional tool calling.

## Internal resource addressing

Agent-visible state uses URI schemes such as `workspace:///`, `session://`,
`ops://`, `reasoning://`, `mcp:///`, `skill://`, `persona://`, and `plurnk:///`. The URI
authority identifies the relevant session namespace where the scheme supports one.

This provides one address form for project content, session state, execution
results, and external resources. The internal representation does not alter
MCP, ACP v2, or provider wire protocols.

## ACP v2 residual bridge

PLURNK converges on ACP v2 (`@agentclientprotocol/sdk/experimental/v2/unstable`) as its client
boundary: sessions, prompts, permissions, elicitations, terminals, tool cancellations, config
options, and `SessionUpdate` notifications use standard ACP v2 methods and shapes.

Only workspace and virtual-machine operations that ACP v2 cannot yet express ride `_plurnk/action`,
and Plurnk-specific provenance rides `_meta.plurnk`. Generic ACP v2 clients operate without
`_plurnk/action`, and whenever ACP v2 standardizes an equivalent capability, PLURNK retires its
`_plurnk/action` counterpart in one cut (`ARCHITECTURE.md` § Standards and substrate).
