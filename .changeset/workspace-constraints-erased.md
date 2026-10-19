---
"@plurnk/plurnk-contracts": patch
"@plurnk/plurnk-agui": patch
---

`ApplicationPort.createWorkspace` and `AguiPlusState` drop `constraints`,
which the daemon stopped reading when workspace membership became the Members
functionality. A Run that creates its workspace refuses a `projectRoot` that is
not a string or null (`project-root-invalid`) and `settings` that are neither
a string nor an object (`settings-invalid`). A forwarded `maxTurns`, `openPaths`
or `childSelector` of the wrong type is coded `max-turns-invalid`,
`open-paths-invalid` or `child-selector-invalid`, a 400 where it was a 500.
