---
"@plurnk/plurnk-agui": minor
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-service": minor
---

Wherever the application port returns a workspace's folder it returns the
daemon's label for it beside it ({§workspace-label}): `projectLabel` on a
client envelope, the `workspace/created` notice and the AG-UI snapshot's
`plurnk.workspace`, and `project_label` on `listWorkspaces` rows and the
`workspace.list` action. The label spells the folder as a default name does
(`~`, `~/<rest>`, otherwise absolute) and is null without a folder, so a
client compares a workspace's name with its label by equality and derives
neither from its own home.
