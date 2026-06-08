# @plurnk/plurnk-execs-sqlite

SQLite runtime executor for [plurnk-service](https://github.com/plurnk/plurnk-service)'s `exec` scheme. Runs the `sqlite` runtime tag **in-process** via Node's builtin `node:sqlite` — no subprocess.

A `@plurnk/plurnk-execs-*` sibling built on the [plurnk-execs](https://github.com/plurnk/plurnk-execs) framework.

## Runtime tag

| Tag | Glyph | Engine |
|---|---|---|
| `sqlite` | 🗃 | `node:sqlite` (Node 25 builtin) |

## Database target

The EXEC target slot is the database file; with no target it defaults to an ephemeral in-memory db:

```
<<EXEC[sqlite]:SELECT * FROM users:EXEC            → :memory: (fresh per run)
<<EXEC[sqlite](./app.db):SELECT * FROM users:EXEC  → ./app.db (persistent)
```

`:memory:` is ephemeral — state does not persist across EXECs. Pass a file path for persistence.

## Output

Writes to the `results` channel as `application/json`, ready for the jsonpath body-matcher (plurnk-mimetypes' JSON handler):

- **Row-returning statements** (SELECT, RETURNING, PRAGMA) → an array of row objects.
- **Mutations** (INSERT/UPDATE/DELETE/DDL) → `{ changes, lastInsertRowid }`.

The query/mutation split is decided by the prepared statement's `columns()`, never by parsing the SQL. One statement per EXEC. Errors emit a `TelemetryEvent` (`source: "exec:sqlite"`): `sqlite_open_failed`, `sqlite_error`.

## Availability & proposal gating

`probe()` always reports available (`node:sqlite` is a builtin). `effect()` — which will mark `:memory:` as `pure` (auto-run) and a file-backed db as `host` (propose) — is pending the contract addition in plurnk-service#182 and lands when that does.

## Tests

`test:lint`, `test:unit`.
