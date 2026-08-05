# wss:// — WebSocket

Use WebSocket for a persistent, bidirectional connection. `wss` is a
stateful scheme, not an HTTP content type: READ claims a workspace address and
owns its socket until terminal settlement, while concurrent SEND and KILL
operations address that owner.

| Operation                             | Effect                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `READ(wss://host/path)`               | Claim the address, connect, mark `messages` active on `open`, and stream inbound frames    |
| A second `READ` of the same address   | Return `409` until the existing owner's terminal cleanup releases the claim                |
| `SEND[200](wss://host/path):message:` | Send only through an open socket; claimed, connecting, or settling owners return `409`     |
| `SEND[499](wss://host/path)`          | Cancel the owning READ through its routed subscription handle                              |
| `KILL(wss://host/path)`               | Close or cancel the claimed owner; an address with no owner is `404`                       |

| Owner state  | Meaning                                              | `SEND[200]`                                      |
| ------------ | ---------------------------------------------------- | ------------------------------------------------ |
| `claimed`    | Address reserved while entry/subscription setup runs | `409`; no second ownership path is created       |
| `connecting` | Native socket exists but has not emitted `open`      | `409`; wait for the active stream event          |
| `open`       | `open` was observed and the native state is open     | Sends the message                                |
| `settling`   | A terminal transition owns cleanup                   | `409`; wait for cleanup before another READ      |

The native `open` event plus durable `messages` activation is the acquisition
boundary. It emits the ordinary metadata-only stream event and returns the READ
at `102`; later operations from the same worker or client may then SEND or KILL
the live owner. A close before acquisition is a direct `502` connection
failure. After acquisition, close, cancellation, and failure settle the retained
subscription without rewriting the initial READ.

Connection identity includes the workspace, exact `ws`/`wss` protocol, host,
non-default port, path, and ordered query. A fragment does not change socket
identity; `messages` is the only current channel.

| Current transport boundary | Behavior                                                              |
| -------------------------- | --------------------------------------------------------------------- |
| Inbound payload            | `String(event.data)` in `messages`; binary semantics are not retained |
| Reconnection               | None; READ again after terminal cleanup                               |
| Handshake headers          | Target header metadata is not applied                                 |
