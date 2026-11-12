---
"@plurnk/plurnk-acp": patch
"@plurnk/plurnk-service": patch
---

Settle unanswered `acp://` messages with `499` when a loop terminates after
re-homing unpublished arrivals, omit internal `_plurnk` abandonment `fail` rows
from ACP chat and tool-call chunks while emitting operator abandonment
telemetry, and preserve model-only loop answer resolution (#1466).
