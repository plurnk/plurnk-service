---
"@plurnk/plurnk-service": minor
---

`plurnk-service stop` ends the service that holds the configured database
and returns once it has exited; a database nobody holds is not running, and
that is success ({§service-stop}). A `shared` launch without a log file
writes to the service's `<state dir>/service.log`, which the result names as
`logFile` ({§daemon-launch}).
