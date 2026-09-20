# @plurnk/plurnk-a2a

The A2A v1 exterior adapter for
[Plurnk](https://github.com/plurnk/plurnk-service). It exposes a Plurnk
workspace as an A2A agent and discovers remote agents through their standard
Agent Cards. The first implementation deliberately supports only the stable
HTTP+JSON v1 binding.

## Expose an agent

The module is an exterior client of Core's `ApplicationPort`; it does not add
an A2A scheduler or Task database. The installed service reads the ordinary
Plurnk environment cascade. Enable the exposure and describe its public
identity in an operator or project `.env`:

```dotenv
PLURNK_A2A_EXPOSE=1
PLURNK_A2A_WORKSPACE=research
PLURNK_A2A_NAME="Research agent"
PLURNK_A2A_DESCRIPTION="Researches questions in its Plurnk workspace"
PLURNK_A2A_VERSION=1.0.0
PLURNK_A2A_SKILLS=[{"id":"research","name":"Research","description":"Researches a question and returns a sourced answer","tags":["research"]}]
```

The module mounts the Agent Card at `/.well-known/agent-card.json` and the
advertised HTTP+JSON interface at `/a2a` on the service listener
(`PLURNK_HOST:PLURNK_PORT`); it opens no socket of its own. With
`PLURNK_A2A_TOKEN` set, the card declares an HTTP bearer scheme and the
interface requires that bearer; the card itself stays public. Starting the
service or reading the card does not create or hydrate the named workspace;
the first admitted Task does so.

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

In the service those definitions are the baseline of the workspace `a2a`
Functionality family (`OutboundModule`): every Worker lists, discovers, adds,
enables, disables, and removes outbound agents through the common
`workspace.a2a.*` actions or the generated ```` ```a2a ```` manager, and the
`a2a://<alias>` scheme resolves an alias against the workspace's enabled
snapshot. Enabled agents appear in Turn 0 as one `worker:///_plurnk/a2a/<alias>.md`
catalog row each; the exact Agent Card stays pullable with `READ a2a://<alias>`.

The package also exports the scheme's live face for embedding: a runtime named
`a2a` carries it as its `scheme`, and it claims every coordinate that opens
with an alias. Its resolver maps each URI authority, in the operation's
workspace, to one client while keeping alias and credential policy outside the
protocol/resource owner:

```ts
import { A2a, connectHttpJsonAgent } from "@plurnk/plurnk-a2a";

const face = new A2a(async (alias, ctx) =>
    alias === "research" && ctx.workspaceId === 1 ? await connectHttpJsonAgent("https://agent.example") : null);
```

Messages, Tasks, and Artifacts then use ordinary Plurnk entries and live
subscriptions. See [`SPEC.md`](./SPEC.md) for the current contract.
