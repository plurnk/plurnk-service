---
"@plurnk/plurnk-agui": major
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-service": minor
---

A gate is the operation it stops ({§agui-proposal-resolve}). A proposal's
interrupt names the operation's own tool call, `toolCallId` its coordinate, or
the call in a subagent's namespace with its `subagentRunId` when the Run has
that segment open, and names none on a Run that holds no conversation of its
worker. Every proposal's interrupt carries Core's `ProposalProjection` as
`metadata.plurnk.proposal`, what the reviewer reviews. The `request_approval`
call and its `prop:<id>` ids are gone, and a decision is no result of its own:
the operation's settlement folds its settled facts onto the call the client
holds, as a repeated `TOOL_CALL_START` and `TOOL_CALL_END` the official reducer
merges without touching the arguments, then answers it. A snapshot holds a
pending proposal as its call without a result. The interrupt carries
`expiresAt` when the operator sets a decision deadline. Every AG-UI owner
reviews, so a client declares no tool for it, and every Run on the owner's
thread re-presents its pending gates, a passive observation included
({§agui-sync}).

`ProposalProjection` names its `worker` and its row's `coordinate`, and carries
`expiresAt` when a deadline applies ({§proposal-projection}). A log row's wire
carries its lifecycle `state` ({§methods-log-entry-wire}), which the row's facts
include ({§agui-plurnk-metadata}). The conformance kit's proposal specimens take
the new shape.
