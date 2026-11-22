---
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-parser": minor
"@plurnk/plurnk-acp": major
"@plurnk/plurnk-mcp": minor
"@plurnk/plurnk-service": minor
---

Unify exterior actor attribution across `SEND`, `/acp`, and `/mcp`, erase
`plurnk-acp`'s per-subject `isNamedPrincipalPeer` wire filtering so every
admitted ACP peer receives the full unfiltered ACP v2 stream and `openMessages`
visibility, and rename `_meta.plurnk.voice` / `voices` to `actor` / `actors`
(#1548).
