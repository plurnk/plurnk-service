# SQLite executor

The shared invocation and result contracts are {§executor-contract} and
{§executor-results}. Execution uses synchronous `node:sqlite`; cancellation is
checked before the statement starts, not during its execution.

## §problems-executor-sqlite Problems

| code | status | condition |
|---|---:|---|
| `cancelled` | 499 | The execution was cancelled before opening the database. |
| `sqlite-open-failed` | 500 | The database could not be opened. |
| `sqlite-invalid-statement` | 400 | The statement could not be prepared. |
| `sqlite-multi-statement` | 400 | Preparing the first statement left another statement; nothing is executed. |
| `sqlite-error` | 500 | Executing the prepared statement failed. |

Database and statement diagnostics include a bounded cause under
{§executor-results}.
