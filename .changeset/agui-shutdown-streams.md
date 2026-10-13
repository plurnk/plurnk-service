---
"@plurnk/plurnk-agui": patch
---

Close remaining AG-UI Runs during daemon shutdown after terminal-event delivery,
including idle client connections. Refuse stream registration after module closure
instead of holding HTTP teardown until its emergency deadline (#1111).
