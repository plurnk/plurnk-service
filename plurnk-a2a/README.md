# @plurnk/plurnk-a2a

The A2A v1 exterior adapter for
[Plurnk](https://github.com/plurnk/plurnk-service). It exposes a Plurnk
workspace as an A2A agent and discovers remote agents through their standard
Agent Cards. The first implementation deliberately supports only the stable
HTTP+JSON v1 binding.

## Expose an agent

Enable the exposure in `$XDG_CONFIG_HOME/plurnk/.env` (normally
`~/.config/plurnk/.env`), or a service configuration file selected with
`--config`. A project `.env` is not automatically loaded; see
[service configuration](../plurnk-core/INSTALL.md#precedence).

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

Restart an already-running service to load these settings. Configure its
[model](../plurnk-providers/README.md#configure-a-model) through the ordinary
model settings. For a new workspace, `PLURNK_A2A_PROJECT_ROOT=/absolute/project`
selects a project folder; leaving it empty creates a headless workspace.

### Without a declared parent

Omit `PLURNK_A2A_PARENT_WORKER` to use `_plurnk`. New Context workers are its
children, and Task workers are children of their Context. They inherit the runtime
owner, which cannot review approvals. With the default
`PLURNK_SERVICE_PROPOSALS=review`, operations requiring approval are rejected.
For unattended automatic approval, set:

```dotenv
PLURNK_SERVICE_PROPOSALS=accept
```

This setting applies service-wide, not just to A2A, and does not bypass
capability restrictions.

### With a client-owned parent

In the service configuration, name an existing worker in the inbound workspace:

```dotenv
PLURNK_A2A_PARENT_WORKER=supervisor
```

Create or open that worker through a client attached to the same running daemon
before admitting new A2A contexts. For the `research` workspace above:

```sh
PLURNK_CLIENT_YOLO=0 plurnk --workspace=research --worker=supervisor
```

Control attachment claims runtime-owned work; it does not take ownership from
another client. New Context and Task workers inherit the parent's approval owner.
With service approval set to `review`, that client receives their approval requests
even while idle. Client YOLO defaults to on; the command above selects manual review.
Disconnecting a review-capable owner leaves approvals waiting for reconnection.

In either setup, task clarification returns to the A2A caller through
`input-required`; it is not an operation approval. A missing named parent refuses
new Context creation, and changing the setting does not reparent existing Contexts.
See [A2A ownership](./SPEC.md)
({§a2a-worker-ownership}), [core ownership](../plurnk-core/SPEC.md)
({§worker-ownership}), and [the configuration reference](./.env.defaults).

## Connect to an agent

```ts
import { connectHttpJsonAgent } from "@plurnk/plurnk-a2a";

const client = await connectHttpJsonAgent("https://agent.example");
```

Available remote agents use complete named definitions in the same environment
cascade. Their discovered standard Agent Cards remain authoritative:

```dotenv
PLURNK_A2A_research={"name":"research","url":"https://agent.example","authorization":{"type":"bearer","token":"${A2A_RESEARCH_TOKEN}"}}
```

Declared agents start enabled. `PLURNK_A2A_research_ENABLED=0` disables that
agent without hiding its definition; `PLURNK_A2A_ENABLED=0` changes the family
default. Aliases are lowercase; `_` represents `-` in environment names.

The service discovers the package as one module ({§a2a-module}). Those definitions are the baseline
of its workspace `a2a` Functionality family: every Worker lists, discovers, adds,
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
