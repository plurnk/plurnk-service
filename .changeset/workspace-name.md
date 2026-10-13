---
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-agui": patch
---

A workspace's name is an opaque handle compared by exact bytes, its identity is
its id and its folder is a separate fact ({§workspace-name}). Created with a
project root and no name, a workspace is named after the root with the daemon's
home abbreviated to `~`, and that name selects the existing workspace when one
exists, so every client launched on the same project shares one world.
