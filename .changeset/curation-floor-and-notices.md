---
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-digest": minor
"@plurnk/plurnk-acp": patch
"@plurnk/plurnk-parser": patch
"@plurnk/plurnk-models": patch
---

Scope `## Log Curation` (`tokens`, `budget`, `percent`) and client
`curationWeight` / `curationBudget` gauges to curatable log room by
subtracting the non-curatable packet floor (`#1476`), route stateless `>= 400`
refusals, `204`/`304` mutation no-ops, and `budget_exceeded` /
`continued_without_note` advisories through transient one-turn `## Notices`
(`loop_notices` and `notice_log_cursor`), preserve top-level CommonMark
indented code blocks and bracketed heredoc tags in the parser, surface
provider generation/response-contract strikes and `max-commands-exceeded` rail
rows cleanly to ACP clients while aligning `plurnk.md` and recovery hints on
`<mcp>.<function>({}) // aside` (`#1478`), and update the bundled model
catalog (`#1477`).
