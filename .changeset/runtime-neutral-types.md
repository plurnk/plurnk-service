---
"@plurnk/plurnk-contracts": major
"@plurnk/plurnk-agui": minor
---

A browser type-checks the client contracts with DOM libraries and no Node
globals:

- The contracts root is runtime-neutral ({§runtime-neutral-root}). The
  application port, whose HTTP host hands an adapter Node's request and
  response, moves with `HttpHost` and `HttpRouteHandler` to its own types-only
  entry, `@plurnk/plurnk-contracts/port`. Import them from there.
- `requestOrigin` and a credential face's `issuer` take a request's headers
  alone (`RequestHeaders`), which a Node request satisfies. A declared
  provider alias and a loop admission have names in the root,
  `ApplicationProviderAlias` and `ApplicationLoopAdmission`.
- `@plurnk/plurnk-agui/client` exports the AG-UI state types and
  `ActionOutcome`, types only ({§agui-client-types}); the package root stays
  the server module.
