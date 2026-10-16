---
"@plurnk/plurnk-agui": patch
---

A sync Run's `MESSAGES_SNAPSHOT` comes before what reached the Run while its
log was read ({§agui-sync}). A row published during the read used to arrive
ahead of the snapshot, so an official client filed it before the whole
conversation; a row the snapshot already holds as it arrived is no longer
built a second time.
