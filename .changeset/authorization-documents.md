---
"@plurnk/plurnk-agui": minor
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-service": patch
---

The authorization server's pages are plain semantic HTML with no script and
no class, readable alone in either color scheme ({§agui-oauth-documents}). A
module may register a stylesheet with its client, `stylesheetPath`, a path
under its own mounts, and the pages shown to that client's requests link it
in place of their own style with a same-origin style policy
({§credential-module-client}). `authorizationDocumentSpecimens()` renders
every page for a consumer whose CSS pruning must keep their selectors.
