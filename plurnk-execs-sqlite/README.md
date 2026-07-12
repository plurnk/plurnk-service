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

### Transient tabular calculations

With no target, `:memory:` is a scratch calculator over ad-hoc tables — build one inline with `VALUES` and aggregate, no schema or file needed:

```
<<EXEC[sqlite]:WITH t(item,qty,price) AS (VALUES ('a',3,2),('b',1,5)) SELECT sum(qty*price) AS total, sum(qty*price)*1.0/sum(qty) AS avg_price FROM t:EXEC
```

**Use floats to avoid integer truncation.** SQLite integer division truncates — `11/4` → `2`. Multiply by `1.0` (or `CAST(x AS REAL)`) to force real division: `11*1.0/4` → `2.75`. Any division over integer columns needs this, or the result is silently floored.

## Output

Writes to the `results` channel as `application/json`, ready for the jsonpath body-matcher (plurnk-mimetypes' JSON handler):

- **Row-returning statements** (SELECT, RETURNING, PRAGMA) → an array of row objects.
- **Mutations** (INSERT/UPDATE/DELETE/DDL) → `{ changes, lastInsertRowid }`.

The query/mutation split is decided by the prepared statement's `columns()`, never by parsing the SQL. One statement per EXEC. Errors emit a `TelemetryEvent` (`source: "exec:sqlite"`): `sqlite_open_failed`, `sqlite_error`.

## Availability & proposal gating

`probe()` always reports available (`node:sqlite` is a builtin). `effect(target)` marks `:memory:` (and no target) as `pure` (auto-run) and a file-backed db as `host` (propose) — classified by the target only, never by inspecting the SQL.

## Tests

`test:lint`, `test:unit`.
