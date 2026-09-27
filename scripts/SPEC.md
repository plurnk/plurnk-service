# Repository tooling

## §release-finalization Publication records

| Stage | Contract |
| --- | --- |
| Qualification | Canonical signed sources, npm authority, and GitHub release-write permission are checked before publication. |
| npm and consumers | Package publication and installed-product verification precede release records. |
| Git | Each release gets a signed `v<version>` tag on its exact verified source commit, pushed to the canonical forge and GitHub mirror. An existing tag is verified, never moved. |
| GitHub | A stable Release names that tag and uses the existing conventional-commit changelog formatter. Existing published records are preserved; conflicts or hosting failures fail the train. |
| Repair | `release:finalize` requires existing signed tags and served package versions; it creates missing records without publishing npm packages or selecting today's HEAD. A retry resumes the missing stage. |

## §problem-codes-declared Problem codes are named by their owner

Every Problem code a package mints — a kebab-case literal followed by an HTTP status, the code argument of `Problems.create`, or a `code:` field in a result shape — is named in inline code inside a tagged block of that package's `SPEC.md` (a table counts when the paragraph before it carries the declaration); `scripts/problem-codes.mjs` refuses the root lint otherwise, so a code can be found from its symptom (#888).
