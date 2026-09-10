# agents

An A2A agent is another agent reachable over HTTP that advertises an Agent
Card. Once added, it is addressed as `a2a://<alias>` and worked like a worker
you cannot see inside: `SEND` it a task, wait for its result, `READ` what it
returned. It is not a tool with a schema; it is a peer that takes instructions
in prose.

## When to reach for an agent

- The user names an agent, or the turn-0 catalog lists an enabled one whose
  card describes the job at hand. `READ (a2a://<alias>)` shows its card and
  skills before you commit work to it.
- Delegation you could do yourself with a worker (`WORK`) stays a worker:
  an agent is for capability that lives elsewhere.

## discover, then add

`discover` takes `{"source": "<agent base URL>"}`, fetches the Agent Card, and
returns one inert candidate carrying the exact definition. `add` persists and
enables it for this workspace (a host effect, run on acceptance):

````agents (add)
{"alias": "planner", "definition": {"name": "planner", "url": "https://agents.example.com/planner"}}
````

Authentication is the definition's business (headers or a token the operator
configured), never something you type into a body. An agent whose card is
unreachable is listed `unavailable` with its exact Problem.

## Working with an added agent

````SEND (a2a://planner) <!-- start a task -->
Compare the two proposals in docs/ and return a recommendation with evidence.
````

A task answers `102` with its `a2a://planner/tasks/<id>` resource and wakes
your next turn when it concludes; a direct message answers `200` with an
`a2a://planner/messages/<id>` resource. `READ` the task for its status,
artifacts, and any input it requests; `SEND` to the task resource to continue
it; `KILL` it to cancel. `disable` and `remove` follow the family lifecycle;
operator-configured agents (`PLURNK_A2A_*`) can only be disabled.
