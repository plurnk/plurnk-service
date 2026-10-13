---
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-agui": patch
---

A workspace's name is an opaque handle compared by exact bytes, its identity is
its id and its folder is a separate fact ({§workspace-name}). Created with a
project root and no name, a workspace is named after the root with the daemon's
home abbreviated to `~`, and that name selects the existing workspace when one
exists, so every client launched on the same project shares one world.
Creation and rename refuse two spellings as `name-invalid`, because a name is
embedded in paths a URL parser reads: text that is not well-formed Unicode,
and a name with a slash-delimited segment that is exactly `.` or `..`. Every
other spelling is admitted as written, and a workspace already carrying a
refused spelling keeps it until it is renamed. A project root that is not
well-formed Unicode is `project-root-invalid`.
