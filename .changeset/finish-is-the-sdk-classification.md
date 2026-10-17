---
"@plurnk/plurnk-providers": major
"@plurnk/plurnk-service": patch
---

The finish reason is the AI SDK's unified classification; the raw vendor value
rides beside it. A finish the SDK classifies as `error` fails the attempt as
`generation_failed` (502, not re-issued; Core settles it on the provider
response contract). The dropped-output rule, its `output_dropped` kind and
`PLURNK_PROVIDERS_DROPPED_OUTPUT_TOKENS` are gone: billed output tokens are
accounting, never evidence of missing text, so a completed answer is admitted
with absent, summarized or verbatim reasoning (#1156, #1157).
