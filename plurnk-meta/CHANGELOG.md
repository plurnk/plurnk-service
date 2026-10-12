# @plurnk/plurnk-meta

## 2.1.1

### Patch Changes

- d8a45b0: Resolve bulk EDIT and resource KILL selectors before mutation, preserving
  per-resource approvals, scopes, anchors and receipts. Require a single resolved
  resource for each COPY/MOVE glob operand before changing either side. Keep
  selected channels through fan-out and count concrete operations against
  configured command limits.
- 05e38b8: Resolve encoded file URLs through native filesystem interpretation without
  double-decoding stored names. Reads, mutations, client attachments, catalogs,
  packets and digest addresses share the same identity. Render ambiguous filenames
  as reusable file URLs while keeping ordinary paths project-relative.
  Keep MOVE source approval bound to the source operand after its destination lands.
- 0b7f8b1: Add shared named definition replacement, retaining enabledness and preserving
  the previous publication on refusal. Use it for repeated environment EDITs
  and explicit child environment overrides, and reject fresh skill preparation
  failures when their definitions change. Carry attempt-local admission data
  through preparation without changing live state; schedule replacements and
  retries affect timers and held delivery failures only after publication.
- 66fcb98: Preserve literal backslashes and escaped glob characters consistently in resource
  selection, file-URL selectors, membership scans, inspection and SQL membership
  checks. Use the standard glob engine instead of Node's fixed separator handling.

## 2.1.0

### Minor Changes

- 9f8e27b: Add `Knob.family(prefix)`, and recap lines: each
  `PLURNK_SERVICE_RECAP_LINE_<alias>` renders as one directive callout ahead of
  the recap source, and an empty value turns a shipped line off. None ships.

## 2.0.2

### Patch Changes

- 85bcf56: Serve AG-UI only at `/agui`, removing the root endpoint. Clients must use the
  advertised URL or append `/agui` to the daemon origin. The HTTP root is available
  to an independent module; when unclaimed it returns 404 after startup. Rootless
  daemons retain the same startup-admission and mount-ownership checks.
- 8d9fb11: Retired names, settings and shapes are erased; nothing recognizes them to refuse
  or translate them. A setting the package does not read is inert, and an
  undeclared value fails through the package's ordinary check.

## 2.0.0

### Major Changes

- Establish the coordinated 2.0 baseline and independent package versioning. From
  this release onward, each package follows its own SemVer contract; compatible
  unchanged dependencies no longer force synchronized releases. Library and
  extension dependencies declare compatible ranges, while the service records its
  assembled dependency selection. Exact tested compositions accompany releases.
