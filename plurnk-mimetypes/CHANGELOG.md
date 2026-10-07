# @plurnk/plurnk-mimetypes

## 2.0.0

- Retire family-wide dependency freshness scanning; packages declare independent compatibility.
- Preserve ANTLR missing-token recovery nodes without fabricating exact source coordinates.

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
