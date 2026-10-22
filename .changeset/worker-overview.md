---
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-agui": minor
---

`readWorkerOverview` reads the places of the daemon or of one workspace with their
lifecycle, the gates they wait on and their latest finished reply, most recently
finished first and bounded ({§methods-worker-overview}, {§worker-finished-reply},
{§application-worker-overview}); `excerptOf` is the one list excerpt rule
({§list-excerpt}). `workspace/renamed` announces a rename
({§notifications-workspace-renamed}). AG-UI: a Run carrying
`forwardedProps.plurnk.overview` observes the overview as state, binding
nothing: a snapshot on `/agui`, patches until the client leaves on
`/agui/connect` ({§agui-overview-run}, {§agui-overview-state},
{§agui-overview-updates}). `PLURNK_AGUI_OVERVIEW_WORKERS` bounds it and
`PLURNK_AGUI_EXCERPT_CHARS` caps every list excerpt.
