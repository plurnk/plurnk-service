---
"@plurnk/plurnk-service": major
---

Retired names, settings and shapes are erased; nothing recognizes them to refuse
or translate them, and a setting nothing reads is inert. The package exports
`./launch` and `./evidence`; the root export is removed. `plurnk-service paths
migrate` and the startup check for a `~/.plurnk` home are removed; operator files
live in the XDG locations. Workspace skills state is no longer moved from its
pre-2.0 directory. Migration 20 carries existing databases forward in place: a
WAIT receipt's unbounded `-1` marker is dropped, and the log projection loses its
two unread admission columns.
