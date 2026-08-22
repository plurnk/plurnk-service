# @plurnk/plurnk-a2a

The A2A v1 exterior adapter for
[Plurnk](https://github.com/plurnk/plurnk-service). It discovers an agent from
its standard Agent Card and selects only the advertised HTTP+JSON v1 binding.

```ts
import { connectHttpJsonAgent } from "@plurnk/plurnk-a2a";

const client = await connectHttpJsonAgent("https://agent.example");
```

The package also exports the outbound `a2a://` scheme handler. Its client
resolver keeps agent configuration outside the protocol/resource owner while
Messages, Tasks, and Artifacts use ordinary Plurnk entry and subscription
mechanics. See [`SPEC.md`](./SPEC.md) for the current contract.
