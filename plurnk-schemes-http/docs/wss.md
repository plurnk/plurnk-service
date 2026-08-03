# wss:// — WebSocket

A full-duplex, persistent connection to a WebSocket origin. Unlike `http://`
(request/response) or SSE (a one-way `http://` event stream), a WebSocket is
**bidirectional and stateful**: you open it once, then send and receive on the
same live connection until it closes.

## Ops

| Op | Effect |
| --- | --- |
| `READ(wss://host/path)` | Open the socket. Inbound frames stream into the `messages` channel as they arrive; the READ holds until the socket closes. A second READ of the same target in this workspace is a `409`. |
| `SEND[200](wss://host/path):your message:` | Push a message onto the **already-open** socket. READ it first — a SEND with no open socket is a `409`. |
| `SEND[499](wss://host/path)` | Cancel: closes the open socket. |
| `KILL(wss://host/path)` | Close the open socket. |

```
<<READ(wss://echo.websocket.events)::READ
<<SEND[200](wss://echo.websocket.events):hello:SEND
<<KILL(wss://echo.websocket.events)::KILL
```

A READ returns `102 Processing` and the socket's inbound frames accumulate in the
`messages` channel across turns — read them as they land, the way you read any
streaming subscription. The connection stays open for concurrent `SEND`s until
you `KILL` it or the origin closes.

## Model

- **One socket per target, per workspace.** The connection a READ opens is keyed by
  its exact protocol, host, non-default port, path, and ordered query. A later
  SEND/KILL to the same target acts on that connection; another READ cannot
  replace it.
- **SSRF-guarded.** The target is resolved and checked before connecting — a
  `ws://`/`wss://` into loopback, link-local, or RFC-1918/CGNAT space is refused
  (`403`), the same guard the fetch path uses.

## Day-one limits

- **Text frames only.** Binary frames stringify loosely; structured binary is a
  follow-up (#468).
- **No reconnection.** A dropped socket closes the READ; re-READ to reopen.
- **Default handshake identity.** Custom request headers on the WebSocket
  handshake aren't wired yet (the standard `WebSocket` constructor has no header
  slot); pending, tracked on #468.

Runtime: Node ≥22 (global `WebSocket`).
