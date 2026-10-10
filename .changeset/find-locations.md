---
"@plurnk/plurnk-service": minor
---

Render a FIND's match locations in the scope notation the model writes: each
location reads `{"region":"<48,1,48,25>","matched":"…"}` instead of a
four-field region object, and names its `channel` only when that is not the
resource's default channel. A broad FIND's single-match locator reads the same
way. The structured `results` keep their typed regions and channels.
