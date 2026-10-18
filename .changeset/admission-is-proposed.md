---
"@plurnk/plurnk-service": minor
---

A model's READ of an untracked file, or a FIND whose text pattern matches inside
one, proposes the file's admission through the proposal lifecycle (202, body
`{"files": [...]}`, effect `host`): accepted by policy where nobody reviews or by
the reviewer otherwise, it is admitted as the Worker's own `members (add)` and
the operation runs again; rejected, it admits nothing. The universe is listed
whenever the knob is on ({§membership-auto-add}; #1160).
