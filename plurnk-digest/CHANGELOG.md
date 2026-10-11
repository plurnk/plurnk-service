# @plurnk/plurnk-digest

## 3.1.0

### Minor Changes

- 1734172: Preserve inherited-history and ambient-event provenance in forensic log exports.
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

- 7de7f76: Link packet and physical-request evidence through readable Markdown. Preserve
  failure and missing-evidence distinctions; support opt-in capture of final
  SDK-dispatched request bodies while omitting headers and URL details.
- Updated dependencies [0060c82]
- Updated dependencies [6769a6a]
- Updated dependencies [1d585b4]
- Updated dependencies [eb33a1f]
- Updated dependencies [9f8e27b]
  - @plurnk/plurnk-contracts@3.1.0
  - @plurnk/plurnk-meta@2.1.0

## 3.0.0

### Major Changes

- 0addc81: The worker summary gains a `Room:` line: the budget the model was shown, in
  provider tokens, against the capacity, and the wall's estimate against the
  provider's count, marking requests the estimate admitted over the wall.
  `EvidencePacket` carries `weight` and `budget`; an evidence implementation must
  provide them.

### Patch Changes

- 8d9fb11: Retired names, settings and shapes are erased; nothing recognizes them to refuse
  or translate them. A setting the package does not read is inert, and an
  undeclared value fails through the package's ordinary check.
- 85bcf56: Bind worker approvals to durable owners, inherited by child workers. Client
  attachments declare their supported interaction tools; reconnecting owners can
  resume pending approvals. Explicit control attachment may claim runtime-owned
  work but does not silently transfer another client's ownership.
  
  Replace per-loop proposal and attendance policy with server approval settings
  and owner capabilities. A2A contexts now descend from `PLURNK_A2A_PARENT_WORKER`
  (default `_plurnk`); `PLURNK_A2A_PROPOSALS` is retired. Schedule definitions no
  longer accept loop policy. Existing databases upgrade in place.
- Updated dependencies [8d9fb11]
- Updated dependencies [85bcf56]
- Updated dependencies [85bcf56]
- Updated dependencies [69f3ffe]
- Updated dependencies [8d9fb11]
- Updated dependencies [4153042]
- Updated dependencies [6c33cec]
- Updated dependencies [06960fc]
- Updated dependencies [85bcf56]
- Updated dependencies [f1bbc46]
- Updated dependencies [85bcf56]
- Updated dependencies [503ea87]
- Updated dependencies [85bcf56]
  - @plurnk/plurnk-contracts@3.0.1
  - @plurnk/plurnk-providers@3.0.0

## 2.0.0

### Major Changes

- Move Skills ownership to `@plurnk/plurnk-skills` and reporting to
  `@plurnk/plurnk-digest`. The service no longer exports `Skill`, `/digest`, or
  `/share`. Reporting consumers import the named `Digest` and `Share` exports from
  `@plurnk/plurnk-digest` and supply `openEvidence: EvidenceReader.open`, with
  `EvidenceReader` imported from `@plurnk/plurnk-service/evidence`.

  Rename `PLURNK_SERVICE_SKILLS_FETCH_TIMEOUT_MS` to
  `PLURNK_SKILLS_FETCH_TIMEOUT_MS`, and `PLURNK_SERVICE_REQUIEM_MAX_TOKENS` and
  `PLURNK_SERVICE_REQUIEM_RETRY_MAX_TOKENS` to `PLURNK_DIGEST_REQUIEM_MAX_TOKENS`
  and `PLURNK_DIGEST_REQUIEM_RETRY_MAX_TOKENS`. Retired names are rejected rather
  than maintained as aliases. The CLI's `share` command remains unchanged, and
  existing databases are upgraded in place.
- Establish the coordinated 2.0 baseline and independent package versioning. From
  this release onward, each package follows its own SemVer contract; compatible
  unchanged dependencies no longer force synchronized releases. Library and
  extension dependencies declare compatible ranges, while the service records its
  assembled dependency selection. Exact tested compositions accompany releases.

### Patch Changes

- Updated dependencies
  - @plurnk/plurnk-meta@2.0.0
  - @plurnk/plurnk-contracts@2.0.0
  - @plurnk/plurnk-providers@2.0.0
