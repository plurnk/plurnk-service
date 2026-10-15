---
"@plurnk/plurnk-agui": minor
"@plurnk/plurnk-service": minor
---

A Loop's identity and stamps travel together ({§agui-status-timing}). The
lifecycle beat carries its loop's packet count and claim stamp
({§loop-status-notice}), and `loop/terminated` carries `terminatedAt`
({§notifications-loop-terminated}). A connected observer therefore updates
`lifecycle`, `loopId`, `packetCount` and the stamps in one delta, never holds
one loop's stamp beside another loop's number, and receives the end stamp
before the Run's terminal. A loop that concludes with any result below 400 is
`completed` live as in a snapshot.
