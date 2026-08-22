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

## §a2a-outbound-resources Outbound resources

The `a2a` scheme is an exterior client adapter over ordinary Plurnk resource
and subscription contracts. Its URI authority is the configured remote-agent
alias. The adapter is not a Worker producer, scheduler, Task store, or alternate
operation runtime.

| Operation | Target | Result |
|---|---|---|
| READ | `a2a://<agent>` | Materialize the discovered Agent Card. |
| SEND `[200]` | `a2a://<agent>` | Send a new user Message. A direct Message creates one static `/messages/<id>` resource and returns `200`; a Task creates one live `/tasks/<id>` resource and returns `102`. |
| SEND `[200]` | Exact `/tasks/<id>` resource | Continue the same non-terminal Task identity, including an input-required or auth-required Task. |
| SEND `[499]` | Live Task resource | Cancel the ordinary local subscription, which requests cancellation of the remote Task. |
| READ | Exact Task or Artifact resource | Materialize the remote resource's current canonical snapshot. |

Task-backed calls use Core's ordinary live-resource path: the scheme seeds one
entry, opens one subscription, returns its exact address with `102`, and closes
that subscription with the remote Task result. Core alone owns parking, waking,
the terminal next-turn READ, and cancellation propagation.

## §a2a-resource-projection Resource projection

Every retained Agent Card, Message, Task, and Artifact has a model-oriented
Markdown `#body` and an exact protocol `#json` channel serialized by the pinned
official SDK. A Task's Artifact identities remain distinct URI descendants and
materialize independently; the adapter never flattens multiple Artifacts into
one fabricated result. Projection wording is presentation rather than protocol
identity: tests assert lifecycle state, content, media type, and addressability,
not a prose template.
