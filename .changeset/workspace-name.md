---
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-agui": patch
---

A workspace's name is an opaque handle compared by exact bytes, its identity is
its id and its folder is a separate fact ({§workspace-name}). Created with a
project root and no name, a workspace is named after the root with the daemon's
home abbreviated to `~`, and that name selects the existing workspace when one
exists, so every client launched on the same project shares one workspace.
Creation and rename refuse ASCII digit-only names (reserved for IDs), text
that is not well-formed Unicode, and literal slash-delimited `.` or `..`
segments as `name-invalid`. Existing records retain their names and remain
attachable and renameable by ID. A project root that is not well-formed
Unicode is `project-root-invalid`.
