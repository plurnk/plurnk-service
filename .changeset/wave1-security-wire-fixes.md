---
"@plurnk/plurnk-acp": minor
"@plurnk/plurnk-auth": patch
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-execs": minor
"@plurnk/plurnk-execs-common": patch
"@plurnk/plurnk-mcp": minor
"@plurnk/plurnk-parser": patch
"@plurnk/plurnk-service": minor
---

Harden OAuth `requested_subject`, bounded RFC 7591 registration, and session
logout; fix `/mcp` resource errors, binary blobs, `ProposalPolicy` checks,
`2025-06-18` client interop, and CORS; fix `/acp` reverse-proxy origins,
`/entry` binary streaming, and `/notifications` `resync` cursors; and thread
`ExecStatement.env` structurally (#1532).
