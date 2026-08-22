# Plurnk A2A specification

## §a2a-http-json-discovery HTTP+JSON discovery

`connectHttpJsonAgent` discovers the standard A2A Agent Card, selects an
advertised `HTTP+JSON` interface at protocol version `1.0`, and returns the
official SDK client. An explicit Agent Card path may replace the standard
well-known path. No legacy protocol or alternate binding is enabled.

## §a2a-protocol-witness Protocol witness

The integration witness places a discovery-first client and an independent
agent on opposite sides of the official A2A v1 HTTP+JSON binding. It covers
card discovery, blocking task completion, task retrieval, ordered streaming
updates, cancellation, a direct Message without a fabricated Task,
input-required continuation under the same Task and Context identities,
multiple distinct Artifacts, and multiple Tasks sharing one Context. The
independent agent may use the SDK's reference request handler and task store;
those test actors establish wire behavior and are not the Plurnk task
architecture.
