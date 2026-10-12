---
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-schemes": minor
---

A settled file mutation's log row keeps the unified diff of what it did: an
accepted EDIT, COPY, MOVE or KILL that writes or removes a text member appends
`current` to `proposed` to `log_entries.patch` (migration 28), served as the
row's `patch` channel (`log:///<loop>/<turn>/<item>/<OP>#patch`, `text/x-diff`)
for the life of the row and copied by a fork. A byte write, a member past the
materialization bound, and a row settled before this version keep none, and a
reader meets no channel rather than an invented one.
