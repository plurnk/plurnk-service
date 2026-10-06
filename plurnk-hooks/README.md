# @plurnk/plurnk-hooks

First-party local command hooks for
[Plurnk](https://github.com/plurnk/plurnk-service). The module selects existing
core lifecycle events and delivers each hook as JSON to one exact
executable on stdin. It does not define another event bus or invoke a shell.

## Configure

Put the following in `$XDG_CONFIG_HOME/plurnk/.env` (normally
`~/.config/plurnk/.env`):

```dotenv
PLURNK_HOOKS_COMMAND=/usr/bin/node
PLURNK_HOOKS_ARGS=["/absolute/path/to/plurnk-hook.mjs"]
PLURNK_HOOKS_EVENTS=Stop,PermissionRequest,Notification
```

`PLURNK_HOOKS_ARGS` is a JSON string array. Supported names are `PreToolUse`,
`PostToolUse`, `PostToolUseFailure`, `Stop`, `Notification`, and
`PermissionRequest`. These follow common agent-hook conventions; there is no
portable hook standard or vendor configuration-file loader.

Each process receives one line such as:

```json
{"hook_event_name":"Stop","session_id":"7","plurnk":{"workspaceId":42,"method":"loop/terminated","params":{"workerId":7,"loopId":9,"result":{"status":200}}}}
```

`session_id` identifies the owning worker. Tool hooks include `tool_use_id`,
`tool_name`, `tool_input`, and, after settlement, `tool_response`; `cwd` is
included when the operation has a project root. `plurnk` retains the original
core event unchanged. `PostToolUse` reports settled dispatch, not a background
process's exit. `Stop` reports loop termination, never a parked wait or client
disconnect. Standard output and error are
inherited from the daemon. A spawn, stdin, nonzero-exit, signal, or timeout
failure is reported to daemon diagnostics without changing loop control flow.
All hooks are asynchronous notifications: neither output nor an exit code can
block, approve, or rewrite work, including at `PreToolUse` or `PermissionRequest`.
Payloads may contain project or model
content; treat the command and any downstream sink as trusted.

By default, commands run one at a time with up to 64 waiting events and a
30-second deadline from admission. Queue overflow and deadline expiry are
reported; neither blocks the agent. Adjust `PLURNK_HOOKS_CONCURRENCY`,
`PLURNK_HOOKS_QUEUE_LIMIT`, and `PLURNK_HOOKS_TIMEOUT_MS` through the same
environment cascade. Delivery is best-effort, without retries or replay.

## Test one hook

Save this as the script path named in `PLURNK_HOOKS_ARGS`:

```js
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const event = JSON.parse(input);
process.stdout.write(`${event.hook_event_name} workspace=${String(event.plurnk.workspaceId)}\n`);
```

Test it before restarting the daemon:

```sh
printf '%s\n' '{"hook_event_name":"Stop","session_id":"7","plurnk":{"workspaceId":42,"method":"loop/terminated","params":{"workerId":7}}}' \
  | /usr/bin/node /absolute/path/to/plurnk-hook.mjs
```

## Module or external tool?

An ordinary executable needs only the configuration above. An installed daemon
module can instead use `ApplicationPort.subscribeToEvents` directly. Both
observe the same core events; modules can consume events beyond the command
adapter's vocabulary. Producer modules implement `stop()` to refuse
new work and settle existing work; observers unsubscribe in `close()`, after
producer settlement. See the
[module contract](../plurnk-modules/SPEC.md).

The complete delivery contract lives in
[`SPEC.md`](./SPEC.md). Portable defaults live in
[`.env.defaults`](./.env.defaults).
