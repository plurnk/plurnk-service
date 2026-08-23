# @plurnk/plurnk-a2a

The A2A v1 exterior adapter for
[Plurnk](https://github.com/plurnk/plurnk-service). It exposes a Plurnk
workspace as an A2A agent and discovers remote agents through their standard
Agent Cards. The first implementation deliberately supports only the stable
HTTP+JSON v1 binding.

## Expose an agent

The module is an exterior client of Core's `ApplicationPort`; it does not add
an A2A scheduler or Task database. Register it on the daemon and bind it to the
workspace whose model workers will serve requests:

```ts
import { A2A_PROTOCOL_VERSION, type AgentCard } from "@a2a-js/sdk";
import { Module as A2aModule } from "@plurnk/plurnk-a2a";

const card: AgentCard = {
    name: "Research agent",
    description: "Researches questions in its Plurnk workspace",
    supportedInterfaces: [{
        url: "",
        protocolBinding: "HTTP+JSON",
        protocolVersion: A2A_PROTOCOL_VERSION,
        tenant: "",
    }],
    provider: { organization: "Example", url: "https://example.com" },
    version: "1.0.0",
    capabilities: {
        streaming: true,
        pushNotifications: false,
        extensions: [],
        extendedAgentCard: false,
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/markdown"],
    skills: [{
        id: "research",
        name: "Research",
        description: "Researches a question and returns a sourced answer",
        tags: ["research"],
        examples: ["Compare two cited accounts of an event."],
        inputModes: ["text/plain"],
        outputModes: ["text/markdown"],
        securityRequirements: [],
    }],
    documentationUrl: "",
    signatures: [],
};

daemon.registerModule(A2aModule.init({
    workspaceId,
    card,
    host: "127.0.0.1",
    port: 4100,
}));
```

The module publishes the Agent Card at `/.well-known/agent-card.json` and the
advertised HTTP+JSON interface at `/a2a`. It rejects security declarations
until an authenticated exposure owns the corresponding enforcement path.

## Connect to an agent

```ts
import { connectHttpJsonAgent } from "@plurnk/plurnk-a2a";

const client = await connectHttpJsonAgent("https://agent.example");
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
