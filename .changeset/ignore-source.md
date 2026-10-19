---
"@plurnk/plurnk-service": patch
---

Membership honors the daemon user's own git excludes file, the configured
`core.excludesFile` or git's default, and a refusal or `discover` verdict for an
ignored file names the rule's file and line instead of "the repository"
({§membership-git-hermetic}, {§membership-ignore-source}).
