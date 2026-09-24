# Repository tooling

## §release-finalization Publication records

| Stage | Contract |
| --- | --- |
| Qualification | Canonical signed sources, npm authority, and GitHub release-write permission are checked before publication. |
| npm and consumers | Package publication and installed-product verification precede release records. |
| Git | Each release gets a signed `v<version>` tag on its exact verified source commit, pushed to the canonical forge and GitHub mirror. An existing tag is verified, never moved. |
| GitHub | A stable Release names that tag and uses the existing conventional-commit changelog formatter. Existing published records are preserved; conflicts or hosting failures fail the train. |
| Repair | `release:finalize` requires existing signed tags and served package versions; it creates missing records without publishing npm packages or selecting today's HEAD. A retry resumes the missing stage. |
