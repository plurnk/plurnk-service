# A2A

## Summary

Call configured A2A v1 agents and retain their current Messages, Tasks, and
Artifacts as addressable Plurnk resources.

## Invocation

```plurnk
## SEND0 [200] (a2a://researcher)
Compare the two proposals and return a recommendation with evidence.
```

`SEND` to an agent root starts new work. A Task response returns `102` and an
exact `a2a://<agent>/tasks/<id>` resource; a direct Message returns `200` and an
exact `a2a://<agent>/messages/<id>` resource. Continue an interrupted Task by
sending the requested input to its Task resource.

Task resources default to a concise `#body` and retain the protocol snapshot in
`#json`. Their Artifact addresses are listed in the body and materialize on
READ. `SEND [499]` to a live Task resource cancels the local obligation and
requests remote cancellation.
