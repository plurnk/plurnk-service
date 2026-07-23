# plurnk-agui

`@plurnk/plurnk-agui` is the daemon's external client interface.

It owns:

- AG-UI HTTP and SSE transport;
- translation between daemon events and AG-UI events;
- client-facing management actions;
- proposal delivery and resolution over the client protocol;
- authentication at the external listener.

Keep model-loop scheduling, persistence, and operation policy in core. Keep
terminal rendering and editor integration in client repositories. Do not invent
AG-UI fields when the daemon cannot supply their semantics; change the internal
contract or omit the event.

`SPEC.md` defines the projection and management surfaces. Test changes against
both protocol conformance and the in-process daemon integration.
