---
"@plurnk/plurnk-agui": major
"@plurnk/plurnk-contracts": patch
---

A row's `metadata.plurnk.attrs` travels without the bodies it holds: a file
write's `original`, `patched`, `patchedBytes`, `patch` and `editReceipt`, and
a statement's `body` and `inputBody`, which the row's result and its call's
arguments carry; a `plurnk.ambient` row likewise ({§agui-plurnk-metadata}).
The AG-UI conformance kit's specimens follow.
