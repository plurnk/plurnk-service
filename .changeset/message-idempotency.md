---
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-service": major
---

A client message's address is its idempotency key ({§message-idempotency}).
`ApplicationPort.messageAdmission({ workspaceId, address, body })` answers `new`
when nothing is accepted there and `accepted` when the same body is, so a repeat
attaches to what the message started; another body under an accepted address is
refused, 422 `message-address-reused`. `runLoop` refuses every repeat it is
handed: other words with 422 `message-address-reused` (they were 409
`message-already-accepted`), the same words still with 409
`message-already-accepted`, a duplicate racing the original.
