---
"@plurnk/plurnk-service": minor
---

`PLURNK_MEMBERS_AUTO_ADD=1` (default): a model's READ of an untracked, unignored,
unexcluded project file admits it as the Worker's own member definition and reads
it; a FIND lists such files as `untracked` and admits the ones its text pattern
matches; a `member_added` notice announces each admission. Indexed dialects see
members only; the members scope still bounds every admission; `0` restores the
baseline (#1154).
