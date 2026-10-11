---
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-schemes": minor
---

The environment registry is an address space, the env family's own face: every
name in effect for a Worker's commands is a resource at `env:///NAME` whose body
is its value, so FIND lists it, READ shows it, COPY carries it into a file or an
entry, EDIT sets it and KILL retires it. Writes land on the Worker's own layer,
never the workspace's or the operator's: EDIT is the family's `add` for the
Worker, KILL its `remove` for an entry the Worker owns and its `disable` for one
it inherited. A reserved name is refused as it is at `add`. A runtime scheme
facet may now own writable resources: `RuntimeSchemeFacet` takes `editBatch` and
states `writableBy` in its manifest, and the writer gate reads the manifest that
governs the coordinate.
