# wss:// — WebSocket

## Summary

Maintain persistent, bidirectional WebSocket connections as addressable entries.

Use WebSocket for a persistent, bidirectional connection. `wss` is a
stateful scheme, not an HTTP content type: `plurnk.read` opens a workspace connection,
while `plurnk.edit`, `plurnk.send`, and `plurnk.kill` address that connection.

| Operation | Effect |
| --- | --- |
| `await plurnk.read({ path: "wss://host/path" })` | Claim the address, connect, mark `messages` active on `open`, and stream inbound frames |
| A second `read` of the same address | Read the retained representation; reuse the existing connection without reconnecting |
| `await plurnk.edit({ path: "wss://host/path", content })` | Propose one whole text frame through an already-open connection, sent on acceptance; ranges and batches are invalid |
| `await plurnk.send({ target: "wss://host/path", text })` | Propose one whole text frame, sent on acceptance; it may follow the opening `read` in the same turn |
| `await plurnk.kill({ path: "wss://host/path" })` | Close or cancel the connection; an address with no connection is `404` |

| Connection state | Meaning | `edit` or directed `send` |
| --- | --- | --- |
| `claimed` | Address reserved while entry/subscription setup runs | `409`; no second connection is created |
| `connecting` | Native socket exists but has not emitted `open` | `409`; wait for the active stream event |
| `open` | `open` was observed and the native state is open | Proposes one whole text frame, sent on acceptance |
| `settling` | A terminal transition owns cleanup | `409`; wait for cleanup before another `read` |

The native `open` event plus durable `messages` activation is the acquisition
boundary. It emits the ordinary metadata-only stream event and returns the `read`
at `102`; any session or client in the workspace may then `edit`, `send`,
or `kill` the connection. A close before acquisition is a direct `502` connection
failure. After acquisition, close, cancellation, and failure settle the retained
subscription without rewriting the initial `read`.

`edit` and directed `send` share the same outbound-frame behavior. Both can follow
the opening `read` in one turn: operations execute in authored order. Only the
turn's disposition operation is deferred until the other operations have run.

await plurnk.read({ path: "wss://api.example.com/feed" });

await plurnk.edit({ path: "wss://api.example.com/feed", content: "{\"type\":\"subscribe\",\"channel\":\"updates\"}" });

await plurnk.send({ target: "wss://api.example.com/feed", text: "{\"type\":\"ping\"}" });

Connection identity includes the workspace, exact `ws`/`wss` protocol, host,
non-default port, path, and ordered query. A fragment does not change socket
identity; `messages` is the only current channel. An unavailable channel returns
`404 channel-not-found`, listing available channels without replacing the socket.

The transport carries text frames only, in native order, one durable write at a
time; a binary inbound frame settles `415` and closes the socket; there is no
reconnection (`read` again after terminal cleanup) and no request headers.
