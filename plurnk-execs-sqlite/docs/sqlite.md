# sqlite

Runs one SQL statement in-process via `node:sqlite` and writes the result to the `results` channel as `application/json` — ready for a jsonpath body-matcher.

## Database target

`EXEC[sqlite](./app.db):…` runs against the file `./app.db` (created if absent) — a persistent, host-mutating database. With **no target** it runs against an ephemeral `:memory:` database that's gone when the statement finishes (pure, auto-run). A directory is never a valid target and falls back to `:memory:`.

## Query vs mutation

The result shape is decided by the statement's columns, never by parsing the SQL:

- **Row-returning** (SELECT, RETURNING, PRAGMA) → an array of row objects.
- **Mutation** (INSERT / UPDATE / DELETE / CREATE) → `{ changes, lastInsertRowid }`.

Large integers come back stringified (JSON can't hold a bigint). A SQL or open error closes `results` as `errored` with status 500 and a `sqlite_error` telemetry note.
