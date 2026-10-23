---
"@plurnk/plurnk-meta": patch
"@plurnk/plurnk-service": patch
---

`instanceof ConfigurationError` recognizes a configuration error from any copy of
the package by its name and key ({§configuration-error-identity}), so a module
loaded from its own plugin root reports its configuration errors as its
diagnostic instead of aborting daemon boot.
