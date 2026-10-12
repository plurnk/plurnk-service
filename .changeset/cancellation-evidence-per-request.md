---
"@plurnk/plurnk-providers": patch
---

A request cancelled through a shared abort signal keeps its own failure
evidence: the SDK now rejects every request on that signal with the same reason
object, so the transport wraps it per request before keying evidence on it.
