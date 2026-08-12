# @plurnk/plurnk-execs-jq

`jq` runtime executor for [plurnk-service](https://github.com/plurnk/plurnk-service)'s `exec` scheme. Drives `## EXEC1 [jq]` by shelling the system `jq` binary to filter/transform JSON — no third-party JSON-filter library.

A `@plurnk/plurnk-execs-*` sibling built on the [plurnk-execs](https://github.com/plurnk/plurnk-service/tree/main/plurnk-execs) framework.

## Invocation model

The body is the jq program and defaults to `.` when empty. The optional target
is the data source. Without one, jq receives `-n` (null input), so the program
is self-contained.

| Heading / body                                                        | Runs                              | Purpose                            |
| --------------------------------------------------------------------- | --------------------------------- | ---------------------------------- |
| `## EXEC1 [jq]`<br>`{"a":1}`                                         | `jq -n '{"a":1}'`                 | Construct or validate inline JSON. |
| `## EXEC1 [jq]`<br>`[1,2,3] \| add`                                  | `jq -n '[1,2,3] \| add'`          | Compute without input.             |
| `## EXEC1 [jq] (data.json)`<br>`.users[].name`                        | `jq '.users[].name' data.json`    | Filter a file.                     |
| `## EXEC1 [jq] (data.json)`                                           | `jq '.' data.json`                | Apply identity to a file.          |
| `## EXEC1 [jq] (search:///1/2/3#results)`<br>`.[] \| .title`         | Consumer materializes the target. | Filter a prior runtime's output.   |

Output streams to `#results` as `application/jsonl`: one compact JSON value per
line ({§executor-output-address}).

## Effect & availability

- **`effect`** — inline/`-n` is `pure`; a target data source is `read`. Both
  bypass the human proposal gate, then stream on the same next-turn path as
  every EXEC ({§executor-effect}).
- **`probe`** — `jq` on PATH (`jq --version`).
- **Errors** return RFC 9457 Problems (`jq-error`, `spawn-failed`) in the
  terminal operation result.

jq is a leaf process, so cancellation is a plain signal kill; it needs no
process-group handling.

## Tests

`test:lint`, `test:unit`. jq-dependent tests auto-skip where `jq` is absent.
