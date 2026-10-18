# @plurnk/plurnk-schemes

## 3.2.2

### Patch Changes

- Updated dependencies [f320b9b]
- Updated dependencies [a619ed6]
- Updated dependencies [acffc4f]
- Updated dependencies [dc0808c]
  - @plurnk/plurnk-contracts@5.0.0

## 3.2.1

- Update compatible dependency ranges: `@plurnk/plurnk-contracts@4.0.0`.

## 3.2.0

### Minor Changes

- 3e3e2f4: A settled file mutation's log row keeps the unified diff of what it did: an
  accepted EDIT, COPY, MOVE or KILL that writes or removes a text member appends
  `current` to `proposed` to `log_entries.patch` (migration 28), served as the
  row's `patch` channel (`log:///<loop>/<turn>/<item>/<OP>#patch`, `text/x-diff`)
  for the life of the row and copied by a fork. A byte write, a member past the
  materialization bound, and a row settled before this version keep none, and a
  reader meets no channel rather than an invented one.

### Patch Changes

- Updated dependencies [157cf8f]
- Updated dependencies [a8df72c]
  - @plurnk/plurnk-contracts@3.3.0

## 3.1.1

### Patch Changes

- 7163937: Document existing failure codes omitted from the owning specifications. Runtime
  behavior and failure identities are unchanged.
- 8f3ed44: Preserve the source type when COPY or MOVE creates a channel at an untyped
  destination, including binary files with unknown or absent extensions. Retain
  existing and declared channel types and recognized destination-extension
  compatibility checks through proposal review, publication, and unchanged-source
  reprojection.
  Allow a dynamically typed default channel beside explicitly typed sibling channels.
- Updated dependencies [960777f]
- Updated dependencies [f383d7d]
- Updated dependencies [0b7f8b1]
- Updated dependencies [42058d0]
- Updated dependencies [c8b3bb9]
  - @plurnk/plurnk-contracts@3.2.0

## 3.1.0

### Minor Changes

- 9e0a3b2: The environment registry is an address space, the env family's own face: every
  name in effect for a Worker's commands is a resource at `env:///NAME` whose body
  is its value, so FIND lists it, READ shows it, COPY carries it into a file or an
  entry, EDIT sets it and KILL retires it. Writes land on the Worker's own layer,
  never the workspace's or the operator's: EDIT is the family's `add` for the
  Worker, KILL its `remove` for an entry the Worker owns and its `disable` for one
  it inherited. A reserved name is refused as it is at `add`. A runtime scheme
  facet may now own writable resources: `RuntimeSchemeFacet` takes `editBatch` and
  states `writableBy` in its manifest, and the writer gate reads the manifest that
  governs the coordinate.
- 7a678da: Replay each turn of the loop as the NOTEs it wrote, in the model's own voice:
  one assistant message between the turn's emission record and its results,
  holding every content NOTE whole and in order. Every other operation is omitted;
  its receipt in the log is its record and the program stays readable at `ops://`.
  A replayed turn's emission row carries the legend of its NOTEs, one numbered
  line per NOTE with its `log:///` path and weight, and those NOTE rows render
  nowhere else; retiring a NOTE row retires it from the replay too. A turn that is
  not replayed, an earlier loop or a program omitted at the wall, shows its NOTEs
  as ordinary rows: a NOTE's text is in the packet once, as replay or as row.
  Preserve native attachments, cache-prefix stability, capacity accounting, and
  historical request roles.
  
  Expose message roles in packet section drafts. Preserve retained packet sections
  and their content-addressed items when upgrading the database.
  
  Add a readable, ordered request artifact and show each turn's input role
  sequence in the digest, distinguishing assistant input history from newly
  emitted output.

### Patch Changes

- Updated dependencies [0060c82]
- Updated dependencies [6769a6a]
- Updated dependencies [1d585b4]
- Updated dependencies [eb33a1f]
- Updated dependencies [9f8e27b]
  - @plurnk/plurnk-contracts@3.1.0
  - @plurnk/plurnk-meta@2.1.0

## 3.0.0

### Major Changes

- 8d9fb11: Exports kept only for earlier consumers are removed: the `EditStatement` alias,
  the `SubscriptionCaps.notifyChunk` and `close` forwarders (the subscription
  `open` returns carries both), and `SchemeInfo.attribution` (discovery's
  `packageAttributions` carries every package's tags).

### Patch Changes

- 06960fc: Diagnostics across the stack say what happened, never why. A refusal names what
  was read, what was done with it and where, and recovers with the construct's
  working form; rebuilt scopes, suggested operations, presumed causes and
  migration hints for retired forms are gone.
- Updated dependencies [8d9fb11]
- Updated dependencies [85bcf56]
- Updated dependencies [85bcf56]
- Updated dependencies [06960fc]
- Updated dependencies [69f3ffe]
- Updated dependencies [8d9fb11]
- Updated dependencies [4153042]
- Updated dependencies [6c33cec]
- Updated dependencies [06960fc]
- Updated dependencies [f1bbc46]
- Updated dependencies [85bcf56]
- Updated dependencies [85bcf56]
  - @plurnk/plurnk-contracts@3.0.1
  - @plurnk/plurnk-mimetypes@3.0.0

## 2.0.0

### Major Changes

- Establish the coordinated 2.0 baseline and independent package versioning. From
  this release onward, each package follows its own SemVer contract; compatible
  unchanged dependencies no longer force synchronized releases. Library and
  extension dependencies declare compatible ranges, while the service records its
  assembled dependency selection. Exact tested compositions accompany releases.

### Patch Changes

- Updated dependencies
  - @plurnk/plurnk-meta@2.0.0
  - @plurnk/plurnk-contracts@2.0.0
  - @plurnk/plurnk-mimetypes@2.0.0
