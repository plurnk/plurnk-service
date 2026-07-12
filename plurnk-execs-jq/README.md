# @plurnk/plurnk-execs-jq

`jq` runtime executor for [plurnk-service](https://github.com/plurnk/plurnk-service)'s `exec` scheme. Drives `EXEC[jq]` by shelling the system `jq` binary to filter/transform JSON — no third-party JSON-filter library.

A `@plurnk/plurnk-execs-*` sibling built on the [plurnk-execs](https://github.com/plurnk/plurnk-execs) framework.

## Invocation model

**body = the jq program** (defaults to `.` if empty) · **target = optional data source** — present → jq reads it; **absent → `-n` (null input)** so the body is self-contained.

| EXEC | runs | does |
|---|---|---|
| `<<EXEC[jq]:{"a":1}:EXEC` | `jq -n '{"a":1}'` | construct / validate inline JSON |
| `<<EXEC[jq]:[1,2,3] \| add:EXEC` | `jq -n '[1,2,3] \| add'` | pure compute, no data |
| `<<EXEC[jq](data.json):.users[].name:EXEC` | `jq '.users[].name' data.json` | filter a file |
| `<<EXEC[jq](data.json):EXEC` | `jq '.' data.json` | empty body → identity (pretty-print) |
| `<<EXEC[jq](exec://…/EXEC#results):.items[]:EXEC` | filter a **prior op's output** | once the service resolves the scheme target ([plurnk-service#201](https://github.com/plurnk/plurnk-service/issues/201)) |

Output → the `results` channel (`application/json`).

## Effect & availability

- **`effect`** — inline/`-n` → `pure`; a file-path data source → `read` (filesystem). Both **auto-run** (jq is a pure filter — no host writes or exec).
- **`probe`** — `jq` on PATH (`jq --version`).
- **Errors** emit a `TelemetryEvent` (`source: "exec:jq"`): `jq_error` (program/parse failure), `jq_spawn_failed`.

jq is a leaf process, so cancellation is a plain signal kill — no process-group handling needed.

## Tests

`test:lint`, `test:unit`. jq-dependent tests auto-skip where `jq` is absent.
