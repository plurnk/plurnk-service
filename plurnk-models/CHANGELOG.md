# @plurnk/plurnk-models

## 3.0.0

### Major Changes

- 8d9fb11: `retiredProviderNames()` is removed. A provider segment resolves only as a
  Models.dev id; any other segment resolves to nothing.

## 2.0.0

### Major Changes

- Establish the coordinated 2.0 baseline and independent package versioning. From
  this release onward, each package follows its own SemVer contract; compatible
  unchanged dependencies no longer force synchronized releases. Library and
  extension dependencies declare compatible ranges, while the service records its
  assembled dependency selection. Exact tested compositions accompany releases.
