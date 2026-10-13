---
"@plurnk/plurnk-service": patch
---

The live and demo tiers write a census: every run lands its workers and a
`census.md`/`census.json` under one `tier-<kind>-<stamp>/` directory in the
benchmark home, each specimen declares what it requires of its route and skips
by name when unmet, and `tier:history` ledgers runs ({§tier-census}).
`digest-missing` recovers workers inside tier runs and resolves the benchmark
home the one way every harness does.
