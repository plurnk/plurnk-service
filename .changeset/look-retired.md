---
"@plurnk/plurnk-parser": major
"@plurnk/plurnk-contracts": major
"@plurnk/plurnk-agui": major
"@plurnk/plurnk-service": major
---

LOOK is retired. The grammar has no LOOK and no client tier:
`PlurnkParser.parseClient` is removed, client-authored text parses with
`parseStatements`, and `ParseResult` and `ParseItem` are no longer generic.
Contracts drop `ClientStatement`, `ClientOp`, the `ClientStatement` schema,
`Validator.validateClientStatement` and `ApplicationPort.look`. The AG-UI
`op.look` action and the daemon's unlogged read are removed; a client reads a
resource with an ordinary READ through `op.parse`, or with `entry.read` and
`log.read`.
