---
"@plurnk/plurnk-execs": patch
"@plurnk/plurnk-service": patch
---

Polish Turn-0 packet orientation, render MCP server tool rosters as `Tools: ...`
without synthetic bracketed tool names or 256-character truncation, deduplicate
`skill://plurnk/!(SKILL).md` in initial discovery, preserve optional `?` markers
on `anyOf`/`oneOf`-only parameters in tool signature asides, and document
`<@hash>` anchor provenance on `plurnk.edit` (#1473).
