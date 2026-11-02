# plurnk-acp

`@plurnk/plurnk-acp` is the daemon's external client interface.

It owns:

- ACP v2 WebSocket and Streamable HTTP JSON-RPC 2.0 transport (`@agentclientprotocol/sdk/experimental/v2/unstable`), plus HTTP entry and history routes;
- projection of daemon lifecycle and log evidence onto standard ACP v2 `SessionUpdate` notifications;
- `_plurnk/action`, the shrinking residual bridge for workspace and VM operations ACP v2 cannot yet express;
- proposal (`session/request_permission`) and elicitation (`elicitation/create`) delivery and resolution over the ACP v2 session stream;
- authentication at the external listener.

Keep model-loop scheduling, persistence, and operation policy in core. Keep
terminal rendering and editor integration in client repositories. Do not invent
ACP fields when the daemon cannot supply their semantics; change the internal
contract or omit the event.

`SPEC.md` defines the projection and management surfaces. Test changes against
both protocol conformance and the in-process daemon integration.
