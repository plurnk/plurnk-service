---
"@plurnk/plurnk-service": patch
---

A mounted route's failure ends its own request, never the daemon: its request
answers `500 route-failed`, or is cut where its response had begun, and the
failure is reported. A request target the listener cannot parse answers
`400 request-target-invalid` instead of ending the process ({§http-host}).
