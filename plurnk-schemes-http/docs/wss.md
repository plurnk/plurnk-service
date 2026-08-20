# wss:// — WebSocket

## Summary

Maintain persistent, bidirectional WebSocket connections as addressable entries.

Use WebSocket for a persistent, bidirectional connection. `wss` is a
stateful scheme, not an HTTP content type: READ claims a workspace address and
owns its socket until terminal settlement, while EDIT, SEND, and KILL address
that owner.

| Operation                                      | Effect                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| `## READ0 (wss://host/path)`                   | Claim the address, connect, mark `messages` active on `open`, and stream inbound frames |
| A second READ of the same address              | Return `409` until the existing owner's terminal cleanup releases the claim             |
| `## EDIT0 (wss://host/path)` with body         | Send one whole text frame through an already-open owner; ranges and batches are invalid  |
| `## SEND0 [200] (wss://host/path)` with body   | Send one whole text frame; it may follow the opening READ in the same turn               |
| `## SEND0 [499] (wss://host/path)`             | Cancel the owning READ through its routed subscription handle                           |
| `## KILL0 (wss://host/path)`                   | Close or cancel the claimed owner; an address with no owner is `404`                    |

| Owner state  | Meaning                                              | EDIT or SEND with signal `200`                   |
| ------------ | ---------------------------------------------------- | ------------------------------------------------ |
| `claimed`    | Address reserved while entry/subscription setup runs | `409`; no second ownership path is created       |
| `connecting` | Native socket exists but has not emitted `open`      | `409`; wait for the active stream event          |
| `open`       | `open` was observed and the native state is open     | Sends one whole text frame                       |
| `settling`   | A terminal transition owns cleanup                   | `409`; wait for cleanup before another READ      |

The native `open` event plus durable `messages` activation is the acquisition
boundary. It emits the ordinary metadata-only stream event and returns the READ
at `102`; later operations from the same worker or client may then EDIT, SEND,
or KILL the live owner. A close before acquisition is a direct `502` connection
failure. After acquisition, close, cancellation, and failure settle the retained
subscription without rewriting the initial READ.

EDIT and SEND share the same outbound-frame behavior. Operation phase order is
the only scheduling distinction: SEND can follow READ in one turn, while EDIT
runs before READ and therefore requires a connection opened by an earlier turn.

Connection identity includes the workspace, exact `ws`/`wss` protocol, host,
non-default port, path, and ordered query. A fragment does not change socket
identity; `messages` is the only current channel.

| Current transport boundary | Behavior                                                                |
| -------------------------- | ----------------------------------------------------------------------- |
| Inbound payload            | String event data only; no coercion or binary projection                |
| Inbound order              | Native event order; one durable write completes before the next begins  |
| Binary inbound payload     | Keep the text prefix, prune the suffix, settle `415`, and close with private-use code `4003` |
| Persistence failure        | Keep the successful prefix; prune queued and later frames; settle `500` |
| Reconnection               | None; READ again after terminal cleanup                                 |
| Handshake headers          | Target header metadata is not applied                                   |
