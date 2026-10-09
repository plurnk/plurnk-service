---
"@plurnk/plurnk-a2a": minor
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-service": minor
---

Run each hosted A2A Task in an ordinary child worker, with related conversation
available as a retained Context resource. Tasks can progress and be cancelled
independently without an extra Context worker or a second execution manager.
Each streaming request observes its own initial snapshot and the durable result.

Support an exact unfinished Loop recipient on the application message boundary;
late continuations cannot reopen completed Tasks. Make simultaneous first model
selections reuse the same immutable route instead of failing a uniqueness check.
