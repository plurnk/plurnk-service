# wss:// — WebSocket

Use WebSocket for a guarded, persistent, bidirectional connection. `wss` is a
stateful scheme, not an HTTP content type: READ claims a workspace address and
owns its socket until terminal settlement, while concurrent SEND and KILL
operations address that owner.

| Operation                             | Effect                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| `READ(wss://host/path)`               | Claim the address, construct the socket, and stream inbound frames into `messages` |
| A second `READ` of the same address   | Return `409`; it never replaces the existing owner                                 |
| `SEND[200](wss://host/path):message:` | Send through the socket claimed by READ; no claimed socket is `409`                |
| `SEND[499](wss://host/path)`          | Cancel the owning READ through its routed subscription handle                      |
| `KILL(wss://host/path)`               | Close the claimed socket; no claimed socket is `404`                               |

The READ remains pending until the socket settles. Inbound frames accumulate in
the `messages` channel, and a separate concurrent dispatch can SEND or KILL
while that address remains claimed. Operations in one model turn run in order,
so a SEND placed after the pending READ in that same turn cannot address it.
An ordinary remote close finishes the subscription and the READ resolves with
streaming status `102`.

Connection identity includes the workspace, exact `ws`/`wss` protocol, host,
non-default port, path, and ordered query. A fragment does not change socket
identity; `messages` is the only current channel.

The target is resolved and checked before socket construction. Loopback,
link-local, RFC-1918/CGNAT, and other non-public address ranges are refused with
`403`.

| Current transport boundary | Behavior                                                                    |
| -------------------------- | --------------------------------------------------------------------------- |
| Readiness                  | The constructed socket is addressable immediately; no open event is exposed |
| Inbound payload            | `String(event.data)` in `messages`; binary semantics are not retained       |
| Reconnection               | None; READ again after a close                                              |
| Handshake headers          | Target header metadata is not applied                                       |
