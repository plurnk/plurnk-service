---
"@plurnk/plurnk-service": patch
"@plurnk/plurnk-meta": patch
---

Resolve encoded file URLs through native filesystem interpretation without
double-decoding stored names. Reads, mutations, client attachments, catalogs,
packets and digest addresses share the same identity. Render ambiguous filenames
as reusable file URLs while keeping ordinary paths project-relative.
