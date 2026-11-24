---
"@plurnk/plurnk-contracts": major
"@plurnk/plurnk-parser": major
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-meta": patch
---

Place required `aside` ahead of `arguments` in the universal `mcp` wire tool (`#1561`):

- `@plurnk/plurnk-contracts`: Reorder `MCP_WIRE_TOOL.parameters.properties` to
  `server`, `tool`, `aside`, `arguments`, require `aside` in
  `MCP_WIRE_TOOL.parameters.required`, and tighten `aside.description` to
  `"Terse intent note."`.
- `@plurnk/plurnk-parser`: Always emit `{ server, tool, aside, arguments }` from
  `toMcpCall` (constructing `aside: ""` when absent), preserve model-tier RENO
  toleration for omitted or empty `aside`, and recover DSML/XML invoke-boundary
  leaks inside `outer.aside`.
- `@plurnk/plurnk-service`: Replay structured `OperationHistory` assistant
  `toolCalls` in `{ server, tool, aside, arguments }` schema order, emitting
  `aside: ""` when none was provided.
- `@plurnk/plurnk-meta`: Align `DIVERGENCES.md` with the updated `mcp` wire
  contract.
