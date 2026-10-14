---
"@plurnk/plurnk-agui": patch
---

A Run ended while its request still streams reasoning, by revocation,
shutdown or failure, closes the reasoning message and span it opened before
`RUN_ERROR` instead of throwing; signing out mid-reasoning no longer stops
the daemon, and the request streams on to every Run still observing it. A
Run that joins after a request's reasoning began presents none of that
request's deltas ({§agui-readable-reasoning}).
