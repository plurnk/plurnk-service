# Plurnk command hooks specification

## §hooks-command-delivery Exact command delivery

One selected core event starts one configured executable with its configured
argument array and `shell: false`. The child receives one complete
`{ workspaceId, method, params }` JSON envelope followed by a newline on stdin.
The core-supplied workspace scope and payload pass through without inferred
coordinates or payload translation. The child inherits the daemon's working
directory and environment; its standard output and error remain visible in the
daemon's streams.

## §hooks-selection Event selection

`PLURNK_HOOKS_EVENTS` is a comma-separated set from the following closed
inventory. These are core event names, not a hook-local vocabulary or filter
language.

| Exposed event | Owning core notification |
|---|---|
| `log/entry` | `{§notifications-log-entry-notify}` |
| `loop/proposal` | `{§notifications-loop-proposal}` |
| `loop/terminated` | `{§notifications-loop-terminated}` |
| `notice/event` | `{§notifications-notice-event}` |
| `stream/concluded` | `{§notifications-stream-concluded}` |
| `stream/event` | `{§notifications-stream-event-on-channel-change}` |
| `workspace/branch-batch` | `{§notifications-workspace-branch-batch}` |
| `workspace/created` | `{§notifications-workspace-created}` |

## §hooks-failure-isolation Failure isolation

Configuration errors fail module construction. Delivery runs outside the core
subscriber call. Spawn, stdin, nonzero-exit, signal, and timeout failures are
reported to daemon diagnostics and cannot alter loop state or event dispatch.
Module close first unsubscribes, then settles admitted deliveries; the required
positive timeout bounds each child process.

## §hooks-config Operator configuration

| Variable | Contract |
|---|---|
| `PLURNK_HOOKS_COMMAND` | One executable; absent disables hooks |
| `PLURNK_HOOKS_ARGS` | Optional JSON string array; invalid JSON or non-string members fail startup |
| `PLURNK_HOOKS_EVENTS` | Required with a command; explicit comma-separated names from {§hooks-selection} |
| `PLURNK_HOOKS_TIMEOUT_MS` | Required positive integer delivery bound |

Arguments or events without a command, unknown or duplicate event names,
shell-shaped command text, and malformed timeouts fail at this module boundary.
