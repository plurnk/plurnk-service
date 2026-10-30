# Intentional interoperability differences

PLURNK follows established protocols and conventions by default. This file
records product-level differences that materially affect interoperability. It
does not catalog ordinary implementation choices.

## Model operation language

PLURNK models emit a grammar-constrained operation language instead of a list of
JSON function calls. Operations address resources with URIs and can compose
across installed schemes and executors.

This is the project's primary experiment: determine whether a compact,
constrained language plus persistent addressable context improves reliability,
especially for smaller models.

Interoperability:

- PLURNK hosts current MCP servers through `@plurnk/plurnk-mcp`, exposing
  their tools and resources through the ordinary operation language.
- Clients use ACP.
- Provider adapters use established model APIs.

This difference is justified only if whole-product evaluations demonstrate an
advantage over conventional tool calling.

## Internal resource addressing

Agent-visible state uses URI schemes such as `workspace:///`, `session://`,
`ops://`, `reasoning://`, `mcp:///`, `skill://`, and `plurnk:///`. The URI
authority identifies the relevant session namespace where the scheme supports one.

This provides one address form for project content, session state, execution
results, and external resources. The internal representation does not alter
MCP, ACP, or provider wire protocols.

## ACP management extensions

ACP v2 defines JSON-RPC 2.0 sessions, notifications, and client-bound gates, and
PLURNK management actions use `_plurnk/action` and `_meta.plurnk` extension fields
on the same authenticated endpoint.

These extensions must remain optional to generic ACP consumers. If ACP
standardizes equivalent management operations, PLURNK should adopt them.
