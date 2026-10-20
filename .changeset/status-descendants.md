---
"@plurnk/plurnk-agui": major
"@plurnk/plurnk-contracts": patch
---

`status.descendants` replaces `status.children`: the bound Worker's whole tree
beneath it, each worker `{ id, name, parentWorkerId, kind, lifecycle, gates }`,
`gates` the proposals and client interactions it waits on. A Run reads it and
`status.spend` again after another worker's lifecycle beat, when a gate is
presented, and, while a descendant waits on one, after another worker's row or
a stream's conclusion ({§agui-status-descendants}). The AG-UI conformance
kit's snapshot specimen carries the tree.
