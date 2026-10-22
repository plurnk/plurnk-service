---
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-agui": minor
---

`loop/packet`, `loop/terminated` and the `loop_status` notice carry `loopSeq`,
the loop's number among its worker's loops, beside `loopId`
({§notifications-loop-packet}, {§notifications-loop-terminated},
{§loop-status-notice}). The AG-UI status gauge carries it as `status.loopSeq`,
replaced in every delta that replaces `loopId` ({§agui-status-loop-number}); the
conformance kit's gauge carries it.
