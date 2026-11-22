---
"@plurnk/plurnk-acp": major
"@plurnk/plurnk-auth": major
"@plurnk/plurnk-contracts": major
"@plurnk/plurnk-service": major
---

Replace plaintext `PLURNK_PASS` with salted `scrypt` `PLURNK_AUTH_PASSWORD_HASH`
and `plurnk-service hash-password [--stdin]`, remove configuration leaks and
third-party delegation copy from `/oauth/authorize` HTML, bound `scrypt`
concurrency and per-address auth failure rates (`429` + `Retry-After`), and
default `PLURNK_ACP_ALLOW_ORIGIN` and `PLURNK_SERVICE_NOTIFICATIONS_ALLOW_ORIGIN`
to empty (#1546).
