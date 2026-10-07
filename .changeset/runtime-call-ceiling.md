---
"@plurnk/plurnk-service": patch
---

Exclude runtime bookkeeping from model-call ceiling inheritance. Model trees
beneath `_plurnk` retain their own shared cap across children, grandchildren, and
BARE; the default remains unlimited.
