---
"@plurnk/plurnk-service": minor
---

Resolve authored `~` and `~/…` file operands from the daemon user's home,
then translate them to project-relative addresses. Membership and mutation
authority are unchanged. Literal tilde names retain their stored identities
and render with `./` so displayed addresses can be reused safely.
