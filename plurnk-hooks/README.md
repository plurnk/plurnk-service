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

`PLURNK_HOOKS_ARGS` is a JSON string array. `PLURNK_HOOKS_EVENTS` is an
explicit comma-separated selection from:

```text
log/entry
loop/proposal
loop/terminated
notice/event
stream/concluded
stream/event
workspace/branch-batch
workspace/created
```

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

The complete contract and event-to-core mapping live in
[`SPEC.md`](./SPEC.md). Portable defaults live in
[`.env.defaults`](./.env.defaults).
