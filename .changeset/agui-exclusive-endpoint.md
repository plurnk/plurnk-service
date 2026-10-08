---
"@plurnk/plurnk-agui": major
"@plurnk/plurnk-service": major
"@plurnk/plurnk-contracts": patch
"@plurnk/plurnk-modules": patch
"@plurnk/plurnk-meta": patch
---

Serve AG-UI only at `/agui`, removing the root endpoint. Clients must use the
advertised URL or append `/agui` to the daemon origin. The HTTP root is available
to an independent module; when unclaimed it returns 404 after startup. Rootless
daemons retain the same startup-admission and mount-ownership checks.
