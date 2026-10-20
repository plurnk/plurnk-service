---
"@plurnk/plurnk-agui": patch
---

A Run reads `status.children` and `status.spend` again after another worker's
lifecycle beat, so a child queued, claimed or parked moves the count at once
({§agui-status-children}).
