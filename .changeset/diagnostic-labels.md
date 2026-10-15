---
"@plurnk/plurnk-digest": patch
"@plurnk/plurnk-service": patch
---

A share, digest or requiem failure is labelled once, by the command or action
that ran it: the digest's own errors no longer prefix themselves, so the CLI
prints `share: no database at …` where it printed
`share: share: no database at …`.
