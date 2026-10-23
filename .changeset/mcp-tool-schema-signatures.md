---
"@plurnk/plurnk-execs": patch
"@plurnk/plurnk-mcp": patch
"@plurnk/plurnk-service": patch
---

Surface required multi-value `enum` unions, one-level structured object/array
shapes, and bounded optional property signatures (`name?: type`) in tool
invocation asides and blank-invocation recovery fences, and include the tool's
working invocation fence in `invalid-tool-arguments` and `tool-reported-error`
recovery ({§executor-input-schema-preview}, {§executor-blank-invocation},
{§problems-mcp}) (#1228).
