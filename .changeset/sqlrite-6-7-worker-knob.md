---
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-models": patch
"@plurnk/plurnk-digest": patch
---

Adopt `@possumtech/sqlrite@^6.7.0` and add `PLURNK_SERVICE_SQLITE_WORKER`
(#1583):

- Add `PLURNK_SERVICE_SQLITE_WORKER=1` (`1` = default Worker-isolated SQLite
  writer; `0` = in-thread async facade with zero Worker V8 isolates, requiring
  `PLURNK_SERVICE_SQLITE_READERS=0`), validated offline in `config check` and
  on database open.
- Simplify read-only catalog opening in `@plurnk/plurnk-models` using
  `sqlrite@6.7.0`'s native `readOnly: true` option without manual `SqlRiteCore`
  ownership handoff.
- Document `PLURNK_SERVICE_SQLITE_WORKER=0` in `plurnk-core/SPEC.md` and
  `plurnk-core/INSTALL.md`, and honor it in `npm run bench:memory`.
