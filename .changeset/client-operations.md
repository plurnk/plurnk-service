---
"@plurnk/plurnk-contracts": major
"@plurnk/plurnk-service": major
"@plurnk/plurnk-agui": major
---

A worker is a model's identity. A person's client operations (an `op.exec`
command, `op.parse` statements, a rollback's compensations) are the
workspace's: each journals as one administrative loop in the runtime worker
`_plurnk`, and client workers are gone ({§connection-lifecycle}).

- `ClientEnvelope` carries only the workspace; `createWorkspace` and
  `attachWorkspace({ workspaceId })` mint no worker.
- `dispatchClientAction({ workspaceId, actor, contextWorkerId?, statements,
  onLoop? })` names the acting person, who is recorded as the operation loop's
  `promptSource`; its rows are acts with `source` null, so a person's SEND
  replies and completes as any author's does. `onLoop` hears the loop before
  any statement runs. `rollback` takes `actor` in place of `clientWorkerId`.
- A person's operation is never routed for review: under `review` it settles
  accepted with outcome `client_operation`, and `accept` and `reject` still
  apply ({§proposal-disposition}). A clarification it would need fails at once
  as unsupported.
- `log:///` in an operation reads the log of the worker the person acts for
  (`contextWorkerId`): READ and FIND answer, curation is refused as any client
  write to the log is, and with no such worker it is 404 `log-unaddressed`
  ({§actor-boundary-client-operations}). Every other address means the
  runtime worker's, so `env:///` is the environment every person's commands in
  the workspace receive.
- Shutdown cancels every client operation still dispatching and reaps every
  execution an operation started.
- Migration 30 carries existing databases forward: each client worker's loops,
  rows, subscriptions and events become its workspace's `_plurnk`'s (its loops
  numbered after `_plurnk`'s own, each naming the worker's owner as
  `promptSource`), a worker it parented becomes `_plurnk`'s child, its own
  environment overrides go, and the client worker is removed. A worker's
  `origin` is `model` or `_plurnk`.
- WORK and FORK are a model's delegation: the child is always a model worker,
  and a worker that is not a model is refused `409 model-worker-required` when
  it would start one; WORK to a worker that exists is still its message.
  `forkWorker` forks only a model worker ({§machine-processes-worker-origin}).
- `cancelLoop({ workspaceId, loopId, reason? })` cancels exactly one operation:
  its dispatch while it runs, settling the loop 499 `operation-cancelled`, and
  every attached execution its rows started that still runs.
- AG-UI: `workspace.create` and `workspace.attach` answer `{ id, name }`, and
  `workspace.attach` takes only `id`. `op.exec` and `op.parse` act as the
  thread's owner for the worker the thread names when it exists, and never
  create, claim or declare capabilities ({§agui-client-operation}). Their Run
  observes exactly the operation's loop, holding a stream's earlier activity
  until the row that announces it, settles on its action result, and cancels
  exactly that operation on disconnect. No action Run presents an interrupt.
