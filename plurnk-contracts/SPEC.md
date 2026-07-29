# PLURNK contracts specification

## Ownership

This package owns PLURNK's runtime-neutral failure and observation envelopes.
Language grammar belongs to `@plurnk/plurnk-grammar`; scheme and executor
authoring helpers belong to `@plurnk/plurnk-schemes`; transport projections
belong to their adapters.

## Operation results

Every public PLURNK operation returns an `OperationResult`:

| status | contract |
|---|---|
| 100-399 | `problem` is forbidden |
| 400-599 | one RFC 9457 `problem` is required |

The legacy top-level `error` field is forbidden. Producer-specific success
fields and Problem Details extension members remain open.

## Problem Details

`ProblemDetails` requires `type`, `title`, `status`, and `detail`; `instance` is
optional until a durable host can attach the occurrence URI.

- `type` is the stable absolute URI for the problem class.
- `title` is stable across occurrences of that type.
- `status` equals the containing operation status.
- `detail` states the occurrence-specific cause at the layer that knows it.
- `instance` identifies the durable occurrence.
- Extensions carry factual domain context or enforced constraints.

Recovery prose is appropriate only when the producer can state a generally
valid response. Exact measurements remain factual even when no universal
recovery amount exists.

## Exceptions and external protocols

Internal invariant violations throw with their cause. They are bugs, not
ordinary operation failures.

An external protocol may require its own error envelope. Its adapter maps that
envelope to or from the canonical Problem without creating a second PLURNK
failure contract.

## Notices

A Notice is a transient, nonterminal observation. It cannot determine durable
failure truth, lifecycle, scheduling, or recovery. Sharing a renderer with
Problems does not merge their semantics.
