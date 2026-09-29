# @plurnk/plurnk-hooks

First-party local command hooks for
[Plurnk](https://github.com/plurnk/plurnk-service). The module selects existing
core lifecycle events and delivers each unchanged event envelope to one exact
executable on stdin. It does not define another event bus or invoke a shell.

## Configure

Put the following in `$XDG_CONFIG_HOME/plurnk/.env` (normally
`~/.config/plurnk/.env`):

```dotenv
PLURNK_HOOKS_COMMAND=/usr/bin/node
PLURNK_HOOKS_ARGS=["/absolute/path/to/plurnk-hook.mjs"]
PLURNK_HOOKS_EVENTS=loop/terminated,loop/proposal,notice/event
```

`PLURNK_HOOKS_ARGS` is a JSON string array. Select exact event names from the
[core event reference](../plurnk-core/SPEC.md#notifications-core-events),
such as `loop/terminated`, `loop/interaction`, or `workspace/preparation`.
There is no hook-specific event vocabulary or wildcard syntax.

Each process receives one line such as:

```json
{"workspaceId":42,"method":"loop/terminated","params":{"workerId":7,"loopId":9,"result":{"status":200}}}
```

Workspace scope and event-owned worker/loop coordinates are passed through;
the module does not infer missing coordinates. Standard output and error are
inherited from the daemon. A spawn, stdin, nonzero-exit, signal, or timeout
failure is reported to daemon diagnostics without changing loop control flow.
Event payloads retain the core contract and may contain project or model
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
process.stdout.write(`${event.method} workspace=${String(event.workspaceId)}\n`);
```

Test it before restarting the daemon:

```sh
printf '%s\n' '{"workspaceId":42,"method":"loop/terminated","params":{}}' \
  | /usr/bin/node /absolute/path/to/plurnk-hook.mjs
```

## Plugin or external tool?

An ordinary executable needs only the configuration above. An installed daemon
module can instead use `ApplicationPort.subscribeToEvents` directly. Both
observe the same core events. Producer modules implement `stop()` to refuse
new work and settle existing work; observers unsubscribe in `close()`, after
producer settlement. See the
[module contract](../plurnk-core/SPEC.md#module-lifecycle-module-lifecycle-and-setup-seam).

The complete delivery contract lives in
[`SPEC.md`](./SPEC.md). Portable defaults live in
[`.env.defaults`](./.env.defaults).
