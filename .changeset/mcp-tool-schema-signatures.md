---
"@plurnk/plurnk-execs": patch
"@plurnk/plurnk-mcp": patch
"@plurnk/plurnk-service": patch
---

Surface required multi-value `enum` unions, one-level structured object/array
shapes, and bounded optional property signatures (`name?: type`) in tool
invocation asides and blank-invocation recovery fences, include the tool's
working invocation fence in `invalid-tool-arguments` and `tool-reported-error`
recovery, hold model Functionality mutations at the workspace boundary across
`authorization-required` sign-in, and conclude loops when a turn pairs a reply
`SEND` with `WAIT` and no live work remains ({§executor-input-schema-preview},
{§executor-blank-invocation}, {§problems-mcp}, {§functionality-model-mutation},
{§oauth-continuation}, {§wait-obligation-matrix}) (#1228).
