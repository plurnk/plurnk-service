# wss:// — WebSocket

## Summary

Maintain persistent, bidirectional WebSocket connections as addressable entries (`ws://` also supported).

| Operation | Effect |
| --- | --- |
| `await plurnk.read({ path: "wss://host/path" })` | Claim the address, connect, mark `messages` active on `open` (`102`), and stream inbound text frames |
| Second `read` of the same address | Read the retained representation on the existing connection without reconnecting |
| `await plurnk.edit({ path: "wss://host/path", text })` | Propose one whole text frame through an open connection, sent on acceptance (no ranges) |
| `await plurnk.send({ target: "wss://host/path", text })` | Propose one whole text frame, sent on acceptance (may follow the opening `read` in the same turn) |
| `await plurnk.kill({ path: "wss://host/path" })` | Close or cancel the connection (`404` when no connection exists) |

| Connection state | Meaning | `edit` or directed `send` |
| --- | --- | --- |
| `claimed` | Address reserved while setup runs | `409`; no second connection is created |
| `connecting` | Socket exists but has not emitted `open` | `409`; wait for the active stream event |
| `open` | `open` observed and socket is open | Proposes one whole text frame, sent on acceptance |
| `settling` | Terminal transition owns cleanup | `409`; wait for cleanup before another `read` |

await plurnk.read({ path: "wss://api.example.com/feed" })

await plurnk.edit({ path: "wss://api.example.com/feed", text: "{\"type\":\"subscribe\",\"channel\":\"updates\"}" })

await plurnk.send({ target: "wss://api.example.com/feed", text: "{\"type\":\"ping\"}" })

- Close before `open` returns `502`; after `open`, close, cancellation, or error settles the subscription without rewriting the initial `read`.
- Connection identity is `(workspace, protocol, host, port, path, query)`; `messages` is the only channel, text frames only (`415` on binary frames), no automatic reconnection (`read` again after settlement), and no custom request headers.
