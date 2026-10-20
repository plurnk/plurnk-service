---
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-agui": major
---

A Run may negotiate its reasoning by link with
`forwardedProps.plurnk.reasoning: "link"`: each reasoning message holds no
text and names its turn's reasoning at
`/agui/<workspace>/<worker>/reasoning/L/T`, the live text arrives as
`CUSTOM plurnk.reasoning`, and a snapshot holds each turn's link
({§agui-reasoning-link}). Every other Run receives reasoning as AG-UI defines
it. `ApplicationPort.readReasoning` reads a turn's reasoning source
({§methods-reasoning-read}). No row repeats reasoning its message holds.
