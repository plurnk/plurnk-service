---
"@plurnk/plurnk-contracts": patch
"@plurnk/plurnk-acp": minor
"@plurnk/plurnk-service": patch
"@plurnk/plurnk-providers": minor
"@plurnk/plurnk-meta": minor
"@plurnk/plurnk-skills": patch
---

Align exterior actor admission and slash-command boundaries (`#1553`, `#1555`,
`#1557`), expose `log.read` loop-window parameters, mark `/script`
terminal-only, enforce `PLURNK_PROVIDERS_RAWBODY` as `0 | 1`, rename
`PLURNK_META_ACCEPTANCE_TIMEOUT_MS`, and erase post-`#1550` `.items`/`.enabled`
compatibility shims (`#1559`).
