# @plurnk/plurnk-a2a

The A2A v1 exterior adapter for
[Plurnk](https://github.com/plurnk/plurnk-service). It exposes a Plurnk
workspace as an A2A agent and discovers remote agents through their standard
Agent Cards. The first implementation deliberately supports only the stable
HTTP+JSON v1 binding.

## Expose an agent

The module is an exterior client of Core's `ApplicationPort`; it does not add
an A2A scheduler or Task database. The installed service reads the ordinary
Plurnk environment cascade. Enable one listener and describe its public
identity in an operator or project `.env`:

```dotenv
PLURNK_A2A_EXPOSE=1
PLURNK_A2A_WORKSPACE=research
PLURNK_A2A_NAME="Research agent"
PLURNK_A2A_DESCRIPTION="Researches questions in its Plurnk workspace"
PLURNK_A2A_VERSION=1.0.0
PLURNK_A2A_SKILLS=[{"id":"research","name":"Research","description":"Researches a question and returns a sourced answer","tags":["research"]}]
```

The module publishes the Agent Card at `/.well-known/agent-card.json` and the
advertised HTTP+JSON interface at `/a2a`. It rejects security declarations
until an authenticated exposure owns the corresponding enforcement path.
Starting the listener or reading its card does not create or hydrate the named
workspace; the first admitted Task does so.

## Connect to an agent

```ts
import { connectHttpJsonAgent } from "@plurnk/plurnk-a2a";

const client = await connectHttpJsonAgent("https://agent.example");
```

Available remote agents use parallel alias blocks in the same environment
cascade. Their discovered standard Agent Cards remain authoritative:

```dotenv
PLURNK_A2A_RESEARCH=https://agent.example
PLURNK_A2A_RESEARCH_BEARER=${A2A_RESEARCH_TOKEN}
PLURNK_A2A_ENABLED=["research"]
```

The package also exports the outbound `a2a://` scheme handler. Its resolver
maps each URI authority to one configured client while keeping alias and
credential policy outside the protocol/resource owner:

```ts
import { A2a, connectHttpJsonAgent } from "@plurnk/plurnk-a2a";

const scheme = new A2a(async (alias) =>
    alias === "research" ? await connectHttpJsonAgent("https://agent.example") : null);
```

Messages, Tasks, and Artifacts then use ordinary Plurnk entries and live
subscriptions. See [`SPEC.md`](./SPEC.md) for the current contract.
