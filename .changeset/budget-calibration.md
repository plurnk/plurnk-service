---
"@plurnk/plurnk-service": patch
---

Hold one calibration factor per loop: a loop's first settled response fixes the
conversion from provider capacity into the curation budget for the rest of the
loop, and until then its packets use the model's most recently fixed factor.
The budget the model sees changes at most once in a loop, not on every turn.
