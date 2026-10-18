# jq executor

The shared invocation, input, and result contracts are {§executor-contract},
{§executor-stdin}, and {§executor-results}.

§jq-identity-default **An empty body runs the identity filter `.`**: the input passes through unchanged.

## §problems-executor-jq Problems

| code | status | condition |
|---|---:|---|
| `input-unsupported` | 501 | The invocation requests live input but the consumer provides none. |
| `cancelled` | 499 | The execution was cancelled. |
| `spawn-failed` | 500 | jq could not start; detail includes a bounded cause. |
| `jq-error` | 500 | jq exited unsuccessfully; detail contains bounded stderr or, when empty, the exit code. |

Shared invocation and stdin failures follow {§problems-executor-input}.
