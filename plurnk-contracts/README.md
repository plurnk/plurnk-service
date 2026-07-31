# @plurnk/plurnk-contracts

Runtime-neutral PLURNK wire contracts:

- RFC 9457 `ProblemDetails`;
- universal `OperationResult`;
- nonterminal `Notice`;
- universal Unicode text coordinates through `TextRegion`.

The package publishes JSON Schemas, generated TypeScript types, and runtime
validation without importing PLURNK's parser, daemon, providers, or plugin SDKs.

```ts
import {
    Problems,
    Validator,
    type OperationResult,
    type ProblemDetails,
} from "@plurnk/plurnk-contracts";

const problem = Problems.create("scheme:file", "not-found", 404, "Missing.");
Validator.assertOperationResult(result);
```

Schemas are available through package exports such as
`@plurnk/plurnk-contracts/schema/ProblemDetails.json`.
