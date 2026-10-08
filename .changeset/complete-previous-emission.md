---
"@plurnk/plurnk-service": patch
"@plurnk/plurnk-contracts": patch
---

Replace body-truncated assistant-history operations with one complete
Previous Emission section at the end of the user packet. The most recent
emission retains its real bodies, so examples no longer teach destructive empty
EDIT operations. Older operation results remain in the ordinary curated log.
