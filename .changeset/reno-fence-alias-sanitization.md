---
"@plurnk/plurnk-contracts": patch
"@plurnk/plurnk-parser": minor
"@plurnk/plurnk-service": patch
---

Drop `"unfenced"` from the session card and emission directives, pair inline
heredocs before matching outer Markdown fences, unwrap fenced JSON/XML/Pythonic
and language-tagged Code Mode tool calls under RENO while preserving prose
fences, recover unprefixed core/runtime verbs and `bash`/`shell`/`python`/`py`
aliases, and promote `description`/`explanation`/`comment` options to `aside` in
model-turn parsing (#1472).
