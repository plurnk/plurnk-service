# @plurnk/plurnk-a2a

The A2A v1 exterior adapter for
[Plurnk](https://github.com/plurnk/plurnk-service). It discovers an agent from
its standard Agent Card and selects only the advertised HTTP+JSON v1 binding.

```ts
import { connectHttpJsonAgent } from "@plurnk/plurnk-a2a";

const client = await connectHttpJsonAgent("https://agent.example");
```

The current protocol witness exercises the official A2A v1 SDK against an
independent agent actor before the Plurnk-facing task projection is added. See
[`SPEC.md`](./SPEC.md) for the current contract.
