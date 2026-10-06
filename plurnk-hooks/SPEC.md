# Plurnk command hooks specification

## §hooks-command-delivery Exact command delivery

An admitted selected event is delivered to the configured executable with its
argument array and `shell: false`, subject to {§hooks-bounded-delivery}. The child receives one complete
hook event from {§hooks-event-projection} followed by a newline on stdin.
The child inherits the daemon's working
directory and resolved daemon environment captured at module construction;
its standard output and error remain visible in the daemon's streams. Event
data is serialized at publication, never read later from a mutable payload.

## §hooks-selection Event selection

`PLURNK_HOOKS_EVENTS` selects exact comma-separated hook names from
{§hooks-event-projection}. Unknown, retired core-event spellings and wildcard
names are configuration diagnostics; retired spellings name their replacement.
Core event names and the module subscription contract do not change.

| Consumer | Integration |
|---|---|
| Installed module | `ApplicationPort.subscribeToEvents`, under {§module-lifecycle} |
| Ordinary executable or script | This package's JSON-stdin adapter; no plugin manifest required |
| Client | The client-interface protocol's projection; not a raw event-bus subscription |

## §hooks-event-projection Notification vocabulary and payload

These names and snake_case fields follow common agent-hook conventions, not a
portable hook standard. Every hook is an asynchronous observation, including
`PreToolUse` and `PermissionRequest`; it is never a barrier or a decision request
to the command.

| Hook | Owning core event | Meaning |
|---|---|---|
| `PreToolUse` | `operation/event`, `phase=started` | One model/client operation enters dispatch, before capability/proposal admission. |
| `PostToolUse` | `operation/event`, `phase=settled`, status below 400 | That dispatch settled; a started executor may still be running. |
| `PostToolUseFailure` | `operation/event`, `phase=settled`, status at least 400 | That dispatch returned a failure, retaining its exact result. |
| `Stop` | `loop/terminated` | One worker loop terminated, including failure or cancellation; parking is not termination. |
| `Notification` | `notice/event` | The existing notice, with its producer's message and severity. |
| `PermissionRequest` | `loop/proposal` with client disposition, or `loop/interaction` | An operation awaits a client decision/input. Automatically settled proposals are not requests to a person. |

| Field | Source |
|---|---|
| `hook_event_name` | Name above. |
| `session_id` | Owning worker's database ID as a string; absent for workspace-only notices. Not a client connection or a loop ID. |
| `cwd` | Operation event's project root, when present. Never inferred from a path operand or substituted with the daemon's directory. |
| `tool_use_id` | `turnId/sequence` for operation events; stable across start and settlement, unique within this database. |
| `tool_name` | Operation keyword or executor runtime; a runtime's target remains in `tool_input`. Interaction requests retain their declared tool name. |
| `tool_input` | Exact parsed operation, or the proposal/interaction's declared input. No synthetic vendor tool signature. |
| `tool_response` | Exact settled operation result, on either post-tool event. |
| `message` | Notice or interaction message when supplied. |
| `plurnk` | Unchanged `{ workspaceId, method, params }` core envelope, including all native coordinates and evidence. |

Only model/client dispatch produces tool hooks; runtime bookkeeping and automatic
log observations do not. READ fan-out is one dispatch with one pair of events;
its result records the fan-out, while the log retains the individual reads.
BARE starts before prompt preparation/inference and settles after its receipt
commits; concurrent BARE calls may overlap their starts. Internal exceptions
that prevent settlement do not invent a post-tool result. Session start/end and
user-prompt hooks are not inferred from client attachment or generic message
ingress. Installed modules can subscribe to the full core event surface directly.

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

## §hooks-module Daemon module

The package declares itself a daemon module in `package.json#plurnk`, so the host discovers it
({§module-discovery}). Its factory reads this package's configuration and the module is inert
while `PLURNK_HOOKS_COMMAND` is absent ({§module-self-activation}). It claims no HTTP mounts.

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
