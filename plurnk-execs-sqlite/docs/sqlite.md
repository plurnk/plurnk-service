# sqlite

Runs **one SQL statement** in-process via `node:sqlite` and writes the result to the `results` channel as `application/json` — ready for a jsonpath body-matcher.

One statement per operation is enforced. A multi-statement script fails with
`sqlite_multi_statement` (400) and names the rejected tail; partial execution
never passes as success. Trailing semicolons and comments are allowed.
Dot-commands such as `.tables` and `.schema` belong to the sqlite3 shell rather
than SQL. Use their SQL equivalents, such as querying `sqlite_master`.

## Database target

`## EXEC1 [sqlite] (./app.db)` with a SQL body runs against the file `./app.db` (created if absent),
a persistent host-mutating database that requires proposal review. With no
target, it runs against a fresh `:memory:` database that is gone when the
operation finishes and bypasses proposal review. A directory is not a database
target; core routes it as a working directory, leaving SQLite in memory.

## Query vs mutation

The result shape is decided by the statement's columns, never by parsing the SQL:

- **Row-returning** (SELECT, RETURNING, PRAGMA) → an array of row objects.
- **Mutation** (INSERT / UPDATE / DELETE / CREATE) → `{ changes, lastInsertRowid }`.

Large integers come back stringified (JSON cannot hold a bigint). Failures close
`results` as `errored` with an RFC 9457 Problem: invalid authored SQL is 400, a
missing database target is 404, and runtime/open failures are 500.
