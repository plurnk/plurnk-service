# Plurnk command hooks specification

## §hooks-command-delivery Exact command delivery

An admitted selected event is delivered to the configured executable with its
argument array and `shell: false`, subject to {§hooks-bounded-delivery}. The child receives one complete
`{ workspaceId, method, params }` JSON envelope followed by a newline on stdin.
The core-supplied workspace scope and payload pass through without inferred
coordinates or payload translation. The child inherits the daemon's working
directory and resolved daemon environment captured at module construction;
its standard output and error remain visible in the daemon's streams. Event
data is serialized at publication, never read later from a mutable payload.

## §hooks-selection Event selection

`PLURNK_HOOKS_EVENTS` selects exact comma-separated event names from
{§notifications}. Hooks do not maintain a second closed inventory, translate
names, infer lifecycle transitions, or implement a wildcard/filter language.
A selected name with no corresponding publication causes no delivery.

| Consumer | Integration |
|---|---|
| Installed module | `ApplicationPort.subscribeToEvents`, under {§module-lifecycle} |
| Ordinary executable or script | This package's JSON-stdin adapter; no plugin manifest required |
| Client | The client-interface protocol's projection; not a raw event-bus subscription |

## §hooks-bounded-delivery Bounded delivery

| Boundary | Behavior |
|---|---|
| Admission | Start immediately when a command slot is free; otherwise queue FIFO up to the configured waiting-event limit. Reject excess events with a diagnostic. |
| Concurrency | At most `PLURNK_HOOKS_CONCURRENCY` commands at once. A value of `1` preserves completion order; larger values permit overlapping completion. |
| Deadline | `PLURNK_HOOKS_TIMEOUT_MS` starts at admission, including queue time. Expired queued events are reported without execution; a running executable is killed on expiry. |
| Failure | At most one command attempt per admitted event; no retry, replay, or durable queue. |
| Shutdown | Remain subscribed through producer settlement under {§module-shutdown-order}; unsubscribe in `close()`, then drain already admitted deliveries. Repeated close joins the same drain. |

The daemon's absolute shutdown deadline also bounds hook drainage. Forced
shutdown can lose notifications. A command owns any subprocesses it creates;
this adapter is not a process-tree supervisor.

## §hooks-failure-isolation Failure isolation

Typed configuration errors refuse module construction; the host contains them
according to {§configuration-repair-path}. Event dispatch never awaits
command completion. Serialization, spawn, stdin, nonzero-exit, signal, and timeout failures are
reported to daemon diagnostics and cannot alter loop state or event dispatch.
Command output and exit status cannot veto or rewrite an operation. Child
ownership lasts until process closure, including after a broken stdin. A failed
diagnostic reporter preserves both errors in the fallback diagnostic.

## §hooks-config Operator configuration

| Variable | Contract |
|---|---|
| `PLURNK_HOOKS_COMMAND` | One executable; absent disables hooks |
| `PLURNK_HOOKS_ARGS` | Optional JSON string array; invalid JSON or non-string members refuse hook configuration |
| `PLURNK_HOOKS_EVENTS` | Required with a command; explicit comma-separated names from {§hooks-selection} |
| `PLURNK_HOOKS_TIMEOUT_MS` | Positive integer delivery deadline including queue time |
| `PLURNK_HOOKS_CONCURRENCY` | Positive integer simultaneous-command limit |
| `PLURNK_HOOKS_QUEUE_LIMIT` | Nonnegative integer waiting-event limit; `0` disables queueing |

Arguments or events without a command, malformed or duplicate event names,
malformed arguments, and invalid bounds fail at this module boundary. The
command is an executable name or path, including paths containing spaces;
it is never split or interpreted as shell text. Choices come from the assembled
cascading daemon environment; workspace and model inputs cannot configure hooks.
