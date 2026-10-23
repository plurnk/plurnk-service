---
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-agui": minor
---

Workspaces and workers hide and show by a durable mark ({§place-hiding}):
`setWorkspaceHidden`, `setWorkerHidden` ({§methods-workspace-hide},
{§methods-worker-hide}). A worker's hide covers its subtree as one group;
`409 live-work` while anything covered is live; a live loop shows its group
and workspace. `listWorkspaces` and `listWorkers` take `hidden` and carry
`hidden_at`; the overview omits hidden places; `workspace/hidden`,
`worker/hidden`. AG-UI: `workspace.hidden.set`, `worker.hidden.set`;
`workspace.list` and `workspace.workers` take `includeHidden`
({§agui-place-hiding}). Migration 33.
