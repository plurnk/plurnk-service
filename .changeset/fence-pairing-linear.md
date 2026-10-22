---
"@plurnk/plurnk-parser": patch
---

A long line above a closing fence pairs in one pass. The orphan-closer check
rescanned the line from each character, so a 300 KB line took seconds and a
megabyte line minutes, with the daemon's event loop blocked (#1205).
