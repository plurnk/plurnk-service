# wss:// — WebSocket

## Summary

Maintain persistent, bidirectional WebSocket connections as addressable entries.

Use WebSocket for a persistent, bidirectional connection. `wss` is a
stateful scheme, not an HTTP content type: READ opens a workspace connection,
while EDIT, SEND, and KILL address that connection.

| Operation                                      | Effect                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| ````` ````READ (wss://host/path) `````                   | Claim the address, connect, mark `messages` active on `open`, and stream inbound frames |
| A second READ of the same address              | Read the retained representation; reuse the existing connection without reconnecting    |
| ````` ````EDIT (wss://host/path) ````` with body         | Send one whole text frame through an already-open connection; ranges and batches are invalid |
| ````` ````SEND (wss://host/path) ````` with body         | Send one whole text frame; it may follow the opening READ in the same turn               |
| ````` ````KILL (wss://host/path) `````                   | Close or cancel the connection; an address with no connection is `404`                  |

| Connection state | Meaning                                          | EDIT or directed SEND                           |
| ------------ | ---------------------------------------------------- | ------------------------------------------------ |
| `claimed`    | Address reserved while entry/subscription setup runs | `409`; no second connection is created           |
| `connecting` | Native socket exists but has not emitted `open`      | `409`; wait for the active stream event          |
| `open`       | `open` was observed and the native state is open     | Sends one whole text frame                       |
| `settling`   | A terminal transition owns cleanup                   | `409`; wait for cleanup before another READ      |

The native `open` event plus durable `messages` activation is the acquisition
boundary. It emits the ordinary metadata-only stream event and returns the READ
at `102`; any worker or client in the workspace may then EDIT, SEND,
or KILL the connection. A close before acquisition is a direct `502` connection
failure. After acquisition, close, cancellation, and failure settle the retained
subscription without rewriting the initial READ.

EDIT and directed SEND share the same outbound-frame behavior. Both can follow
the opening READ in one turn: operations execute in authored order. Only the
turn's disposition operation is deferred until the other operations have run.

````READ (wss://api.example.com/feed)````

````EDIT (wss://api.example.com/feed)
{"type":"subscribe","channel":"updates"}
````

Connection identity includes the workspace, exact `ws`/`wss` protocol, host,
non-default port, path, and ordered query. A fragment does not change socket
identity; `messages` is the only current channel. An unavailable channel returns
`404 channel-not-found`, listing available channels without replacing the socket.

| Current transport boundary | Behavior                                                                |
| -------------------------- | ----------------------------------------------------------------------- |
| Inbound payload            | String event data only; no coercion or binary projection                |
| Inbound order              | Native event order; one durable write completes before the next begins  |
| Binary inbound payload     | Keep the text prefix, prune the suffix, settle `415`, and close with private-use code `4003` |
| Persistence failure        | Keep the successful prefix; prune queued and later frames; settle `500` |
| Reconnection               | None; READ again after terminal cleanup                                 |
| Handshake metadata         | `{metadata}` is unsupported                                              |
