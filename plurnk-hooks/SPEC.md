# Plurnk command hooks specification

## §hooks-event-projection 1. Command Delivery, Selection, and Event Projection

An admitted event selected by `PLURNK_HOOKS_EVENTS` (exact comma-separated hook names below; any other name or wildcard is a configuration diagnostic) is delivered to `PLURNK_HOOKS_COMMAND` with `PLURNK_HOOKS_ARGS` and `shell: false`, writing one serialized JSON hook event followed by `\n` to `stdin`. The child inherits the daemon working directory and resolved environment captured at module construction, with `stdout`/`stderr` visible in daemon streams. Every hook is an asynchronous observation (never a barrier or decision request). Only model/client dispatch produces tool hooks (`READ` fan-out is one pair of events; `BARE` starts before prompt preparation and settles after receipt commit).

| Hook | Owning core event | Meaning |
| --- | --- | --- |
| `PreToolUse` | `operation/event`, `phase=started` | Model/client operation enters dispatch, before capability/proposal admission. |
| `PostToolUse` | `operation/event`, `phase=settled`, status `< 400` | Dispatch settled (a started executor may still be running). |
| `PostToolUseFailure` | `operation/event`, `phase=settled`, status `>= 400` | Dispatch returned a failure, retaining its exact result. |
| `Stop` | `loop/terminated` | Session loop terminated (including failure/cancellation; parking is not termination). |
| `Notification` | `notice/event` | Notice with its producer's message and severity. |
| `PermissionRequest` | `loop/proposal` (client disposition) or `loop/interaction` | Operation awaits a client decision/input (auto-settled proposals excluded). |

| Payload field | Source |
| --- | --- |
| `hook_event_name` | Hook name from table above. |
| `session_id` | Owning session's database ID as string (absent for workspace-only notices). |
| `cwd` | Operation event's project root when present (never inferred from operand or daemon cwd). |
| `tool_use_id` | `turnId/sequence` for operation events, stable across start and settlement. |
| `tool_name` | Operation keyword, executor runtime, or interaction request's declared tool name. |
| `tool_input` | Exact parsed operation or proposal/interaction input. |
| `tool_response` | Exact settled operation result on `PostToolUse` / `PostToolUseFailure`. |
| `message` | Notice or interaction message when supplied. |
| `plurnk` | Unchanged `{ workspaceId, method, params }` core envelope. |

## §hooks-module 2. Bounded Delivery, Daemon Module, and Configuration

`@plurnk/plurnk-hooks` declares itself a daemon module in `package.json#plurnk` ({§module-lifecycle}), claiming no HTTP mounts and staying inert while `PLURNK_HOOKS_COMMAND` is absent ({§module-contract}). Typed configuration errors refuse module construction and are contained under {§configuration-repair-path}.

| Boundary / Knob | Contract |
| --- | --- |
| `PLURNK_HOOKS_COMMAND` | Executable name or path (never shell-split); absent disables hooks. |
| `PLURNK_HOOKS_ARGS` | Optional JSON string array; invalid JSON, non-string members, or presence without a command fails configuration. |
| `PLURNK_HOOKS_EVENTS` | Required when command is set; comma-separated hook names. |
| `PLURNK_HOOKS_CONCURRENCY` | Positive integer simultaneous-command limit (`1` preserves completion order). |
| `PLURNK_HOOKS_QUEUE_LIMIT` | Nonnegative integer FIFO waiting-event limit (`0` disables queueing; excess events are rejected with a diagnostic). |
| `PLURNK_HOOKS_TIMEOUT_MS` | Positive integer deadline from admission (including queue time); expired queued events report without running, and running children are killed on expiry. |
| Failure isolation & shutdown | At most one attempt per event; spawn, stdin, exit, signal, and timeout failures report to daemon diagnostics without altering loop state or event dispatch (preserving both errors if the diagnostic reporter fails). Remains subscribed through producer settlement ({§module-shutdown-order}), then unsubscribes in `close()` and drains admitted deliveries. |
