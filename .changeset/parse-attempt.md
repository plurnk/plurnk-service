---
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-parser": minor
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-agui": major
---

A statement the parser refused names its attempt ({§parse-attempt}): the parse
error item carries the statement's text as written and the verb its opening
fence names. Core records it in the refusal row's `attrs`, outside the row's
body and weight, so the model's packet is unchanged. AG-UI presents the
refusal as the call the worker attempted, named by that verb with the text as
its arguments and answered by the refusal ({§agui-parse-refusal}). A refusal
that names no attempt is no call and rides `CUSTOM plurnk.ambient`; no tool
named `error` is invented.
