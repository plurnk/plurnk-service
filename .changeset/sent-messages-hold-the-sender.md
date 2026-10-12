---
"@plurnk/plurnk-service": minor
---

A message a worker sends to another worker holds the sender until it is
completed: `worker_obligations` gains `messages` beside `streams` and
`workers`, an authored WAIT parks on it, the completion wakes the same loop, and
with no WAIT the sender joins the bounded park instead of concluding idle. The
packet's Delegation object lists those messages as its third pointer list. A
loop that ends with another worker's message unanswered has it completed 499
by the daemon, delivered to the sender like any reply.
