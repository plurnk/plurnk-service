---
"@plurnk/plurnk-acp": patch
"@plurnk/plurnk-contracts": major
"@plurnk/plurnk-meta": patch
"@plurnk/plurnk-parser": major
"@plurnk/plurnk-service": major
---

Exclude unanswered Open Messages from `## Log Curation.largest` and name
retired `message://` coordinates in `log_curated`; return `204` with a 1-turn
observation when `kill` targets an already-terminated `exec:///` stream; and
retire `kill` `note` distillation, coercing model-tier `note` to `aside`
(#1535).
