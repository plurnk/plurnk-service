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

- PLURNK consumes MCP servers through `plurnk-execs-mcp`.
- Clients use AG-UI.
- Provider adapters use established model APIs.

This difference is justified only if whole-product evaluations demonstrate an
advantage over conventional tool calling.

## Internal resource addressing

Agent-visible state uses URI schemes such as `worker://`, `prompt://`, and
`log://`. The URI authority identifies the relevant worker namespace where the
scheme supports one.

This provides one address form for project content, worker state, execution
results, and external resources. The internal representation does not alter
MCP, AG-UI, or provider wire protocols.

## AG-UI management extensions

AG-UI defines agent runs but not all workspace-management operations PLURNK
requires. Management actions therefore use AG-UI's extension fields and custom
events on the same authenticated endpoint.

These extensions must remain optional to generic AG-UI consumers. If AG-UI
standardizes equivalent management operations, PLURNK should adopt them.
