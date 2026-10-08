---
"@plurnk/plurnk-service": major
"@plurnk/plurnk-contracts": major
"@plurnk/plurnk-agui": major
"@plurnk/plurnk-a2a": major
"@plurnk/plurnk-schedule": major
"@plurnk/plurnk-digest": patch
"@plurnk/plurnk-hooks": patch
"@plurnk/plurnk-execs-common": patch
"@plurnk/plurnk-mcp": patch
"@plurnk/plurnk-skills": patch
"@plurnk/plurnk-providers": patch
---

Bind worker approvals to durable owners, inherited by child workers. Client
attachments declare their supported interaction tools; reconnecting owners can
resume pending approvals. Explicit control attachment may claim runtime-owned
work but does not silently transfer another client's ownership.

Replace per-loop proposal and attendance policy with server approval settings
and owner capabilities. A2A contexts now descend from `PLURNK_A2A_PARENT_WORKER`
(default `_plurnk`); `PLURNK_A2A_PROPOSALS` is retired. Schedule definitions no
longer accept loop policy. A2A clarification still returns to the caller,
separately from local operation approval. Existing databases upgrade in place.
