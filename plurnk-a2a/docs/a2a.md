# a2a

An A2A agent is another agent reachable over HTTP that advertises an Agent
Card. Once added, it is addressed as `a2a://<alias>` and worked like a worker
whose inside is not visible: `SEND` it a task, wait for its result, `READ`
what it returned. It is not a tool with a schema; it is a peer that takes
instructions in prose. `READ (a2a://<alias>)` shows its card and skills.

## discover, then add

`discover` takes `{"source": "<agent base URL>"}`, fetches the Agent Card, and
returns one inert candidate carrying the exact definition. `add` persists and
enables it for this workspace; it is a host effect, admitted under the loop's
policy.

```a2a (add)
{"alias": "peer", "definition": {"name": "peer", "url": "https://agents.example.com/peer"}}
```

Authentication is the definition's (headers or a token the operator
configured), never a body's. An agent whose card is unreachable is listed
`unavailable` with its exact Problem. `disable` and `remove` follow the family
lifecycle; operator-configured agents (`PLURNK_A2A_*`) are disable-only.

## Working with an added agent

```SEND (a2a://peer) <!-- start a task -->
The task, in prose.
```

A task answers `102` with its `a2a://peer/tasks/<id>` resource and wakes the
next turn when it concludes; a direct message answers `200` with an
`a2a://peer/messages/<id>` resource. `READ` the task for its status,
artifacts, and any input it requests; `SEND` to the task resource to continue
it; `KILL` it to cancel, which also asks the remote agent to stop.

A task resource defaults to a concise `#body` and keeps the protocol snapshot
in `#json`. Its Artifacts and binary Parts are retained as linked resources;
`READ` a link to inspect its content. Supplied URLs are not fetched on arrival.

## Attachments

SEND's `[{"attachments": [...]}]` option (`worker.md`) applies: exact resource
paths or channels, captured at SEND time, delivered to the agent as standard
Artifacts; a reply to an incoming A2A request omits the target and uses the
same option. Incoming files arrive as ordinary resource links; incoming
response-format preferences appear beside the message when supplied.
