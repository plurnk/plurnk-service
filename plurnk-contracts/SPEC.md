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

### Model-facing language

The durable Problem on a failed log row is also the model-facing error. Its
fields follow one writing contract:

| field | rule |
|---|---|
| `title` | Stable problem class, with no occurrence data or instruction. |
| `detail` | State the failed subject, observed fact, and violated constraint as tersely as the cause permits. Do not infer motives, blame the model, restate the status, or expose an implementation accident as the cause. |
| `stage` | Name the stable failed stage only when neighboring stages imply different recovery. |
| factual extensions | Preserve operands the producer already knows, such as a requested range, available extent, allowed operations, or token deficit. |
| `recovery` | State one generally valid next action. Omit it when recovery depends on facts the producer does not know. |
| `retryable` | Use `true` only when the producer recommends automatically retrying the identical request. Use `false` when caller input or operator state must change, or replay could violate intent. Omit it when the producer cannot know. |

`detail` is failure truth; `recovery` is not a second explanation. Recovery
does not repeat general syntax or packet teaching. Exact measurements remain
factual even when no universal recovery amount exists.

`Problems.create(owner, code, status, detail, extensions?, options?)` derives
the stable title from `code` by default. A type whose established title is not
that mechanical rendering supplies `options.title`; occurrence-specific text
never belongs there.

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
