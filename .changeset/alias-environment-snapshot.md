---
"@plurnk/plurnk-providers": patch
---

Read one fresh environment snapshot per alias projection instead of repeatedly
enumerating host variables for every knob, preserving precedence and live edits.
