---
"@plurnk/plurnk-acp": major
"@plurnk/plurnk-contracts": major
"@plurnk/plurnk-execs": major
"@plurnk/plurnk-execs-common": patch
"@plurnk/plurnk-mcp": major
"@plurnk/plurnk-meta": major
"@plurnk/plurnk-parser": minor
"@plurnk/plurnk-providers": major
"@plurnk/plurnk-schedule": patch
"@plurnk/plurnk-schemes-http": major
"@plurnk/plurnk-service": major
---

Freeze v9.0 wire, `.env`, and SQLite contracts: unify approval policies onto
`review | accept | reject` and add `_MS`/`_SEC` suffixes to duration knobs;
move execution stream outputs onto `exec:///<runtime>/<id>`; serve computed
`plurnk:///status.json` and `plurnk:///recent.json`, camelCase notification
fields, `loop/started` and `loop/parked`, `session.rollback`, and `op.exec`;
and squash SQLite migrations `001..025` into `001_baseline.sql` (#1533).
