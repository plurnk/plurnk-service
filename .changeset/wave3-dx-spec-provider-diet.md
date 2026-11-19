---
"@plurnk/plurnk-acp": patch
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-execs-common": patch
"@plurnk/plurnk-mcp": patch
"@plurnk/plurnk-meta": minor
"@plurnk/plurnk-mimetypes": patch
"@plurnk/plurnk-mimetypes-audio": patch
"@plurnk/plurnk-mimetypes-image": patch
"@plurnk/plurnk-parser": patch
"@plurnk/plurnk-providers": minor
"@plurnk/plurnk-schedule": patch
"@plurnk/plurnk-service": patch
"@plurnk/plurnk-spec-check": minor
---

Move `MCP_WIRE_TOOL` to `@plurnk/plurnk-contracts`; clean up provider error
classes, Google/Bedrock fetch and non-image media projection, and `<think>`
preservation; bound concluded stream maps and split `Module.test.ts` in
`plurnk-acp`; cache compiled `/mcp` tool schemas; unify `ProposalLifecycle`
diffs on `diff`; remove 0-byte `POLICY.md` and dead table stripping; rebalance
`SPEC.md` contracts and `plurnk-spec-check`; and split offline `deps:check`
from `deps:drift` (#1534).
