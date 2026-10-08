---
"@plurnk/plurnk-schemes": major
---

Exports kept only for earlier consumers are removed: the `EditStatement` alias,
the `SubscriptionCaps.notifyChunk` and `close` forwarders (the subscription
`open` returns carries both), and `SchemeInfo.attribution` (discovery's
`packageAttributions` carries every package's tags).
