---
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-providers": patch
---

Render each notice in the model packet as one alert callout in the card's own
form: the level picks the callout, an optional `directive` (`YOU MUST`,
`YOU SHOULD`, ...) leads, then the factual message and the kind. Notices about
the model's own output carry a directive; environment notices carry none.
