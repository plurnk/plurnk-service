# Extending Plurnk

## Summary

Extend Plurnk with configuration, personas, Agent Skills, MCP servers, Agent Plugins, ACP v2 clients, notification consumers, and first-party `@plurnk/*` packages.

## Choosing a surface

Surfaces run from least to most code and trust:

- **Configuration**: a setting in the cascade, or a definition in `mcp.json`, a skill root, or a persona root.
- **Operating policy** (`AGENTS.md` / `AGENTS.local.md`): standing instructions in a user environment, project, or session (`session://<session>/AGENTS.md`).
- **A persona** (`persona://<name>/PERSONA.md`, managed via `plurnk.personas` or `plurnk.edit`): a reusable operating identity, optional model/effort route, and instruction body selected per session or copied to `session://<session>/AGENTS.md`.
- **A skill**: knowledge or scripts run with existing runtimes (`sh`, `js`).
- **An MCP server**: an external process or HTTP endpoint exposing tools, resources, or prompts over MCP.
- **A plugin**: an Agent Plugins `1.0.0` directory bundling skills, personas, and MCP servers together.
- **A client**: an external application driving Plurnk over ACP v2 at `/acp`.
- **A notification consumer**: an external subscriber reading `DaemonNotification` events from `GET /notifications` SSE.
- **An extension**: a first-party `@plurnk/*` package loaded in-process at daemon startup to provide a runtime (`exec`), address scheme (`scheme`), media-type reader (`mimetype`), or model provider (`provider`).
- **A module**: a first-party `DaemonModule` composed by the service (`@plurnk/plurnk-modules`) to manage a functionality family, mount a listener route, or observe daemon lifecycle.

## Plurnk uses X

| Surface | Shape | The model sees | Code in the daemon |
| --- | --- | --- | --- |
| Persona | `<name>.md`, `<name>/PERSONA.md`, or inline definition | `persona://<name>/PERSONA.md` | none |
| Skill | directory holding `SKILL.md` | `skill://<name>/` | none |
| MCP server | one MCP definition | runtime `<server>.<tool>` and scheme `<server>://` | none: a process or URL |
| Plugin | directory holding `plugin.json`, `skills/`, `personas/`, `mcp.json` | its skills, personas, and MCP servers | none |
| Extension | `@plurnk/*` npm package declaring `package.json#plurnk` | runtime, scheme, media-type reader, or model provider | first-party, in the daemon |

Manage personas, skills, and MCP definitions live in the current workspace via `plurnk.personas`, `plurnk.skills`, and `plurnk.mcp` (`mcp:///plurnk/<tool>.json`).

## X uses Plurnk

| Surface | Shape | Code in the daemon | Contract |
| --- | --- | --- | --- |
| Application | ACP v2 client (`@agentclientprotocol/sdk` or raw JSON-RPC 2.0): WebSocket or Streamable HTTP at `/acp` (`PLURNK_HOST`:`PLURNK_PORT`), authenticated via OAuth 2.1 (`/.well-known/*`, `/oauth/*`) when `PLURNK_AUTH=1` | none | `skill://plurnk/packages/@plurnk/plurnk-acp/SPEC.md`, `skill://plurnk/packages/@plurnk/plurnk-auth/SPEC.md` |
| Notification stream | Server-Sent Events consumer at `GET /notifications[?event=...&workspace=...&session=...]` (`PLURNK_PORT`), authenticated via OAuth 2.1 bearer token (`acp` or `notifications` scope) | none | `skill://plurnk/packages/@plurnk/plurnk-service/SPEC.md`, `skill://plurnk/packages/@plurnk/plurnk-contracts/SPEC.md` |

ACP v2 JSON-RPC 2.0 wire on `/acp` (under `PLURNK_AUTH=1`, `POST /oauth/token` with `grant_type=client_credentials` and `scope=acp` against `PLURNK_AUTH_CLIENT_<id>` issues the `Authorization: Bearer <token>` header):

| Direction | Method | Payload / result |
| --- | --- | --- |
| Client → Agent | `initialize` | `{ protocolVersion: 2, info: { name, version } }` → `{ protocolVersion, info, capabilities }` |
| Client → Agent | `session/new` / `session/resume` | `{ cwd }` (`"/"` or `_meta: { plurnk: { workspace } }` for a folderless workspace; `session/resume` adds `sessionId` and optional `replayFrom: { type: "start" }`) → `{ sessionId }` (`"<workspaceId>#<sessionName>"`) |
| Client → Agent | `session/prompt` / `session/cancel` | `session/prompt`: `{ sessionId, prompt: [{ type: "text", text }] }` → `{ messageId }`; `session/cancel` notification: `{ sessionId }` |
| Agent → Client | `session/update` (notification) | `{ sessionId, update }`: `agent_message_chunk` (`{ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } }`) streams reply text; `state_update` (`{ sessionUpdate: "state_update", state: "running" \| "requires_action" \| "idle", stopReason? }`) marks loop settlement on `"idle"` |
| Agent → Client | `session/request_permission` / `elicitation/create` | Gate requests; `session/request_permission` returns `{ outcome: { outcome: "selected", optionId } }` (`allow_once`, `allow_always`, `reject_once`, `reject_always`) or `{ outcome: { outcome: "cancelled" } }` |

## First-party framework packages

First-party `@plurnk/*` extension packages declare `plurnk` in `package.json`:

| Kind | Adds | Kind-owned field | Contract |
| --- | --- | --- | --- |
| `exec` | runtimes invoked as tool calls | `runtimes` or `runtimesModule` | `skill://plurnk/packages/@plurnk/plurnk-execs/SPEC.md` |
| `scheme` | address schemes | `schemes`, or `name` for one | `skill://plurnk/packages/@plurnk/plurnk-schemes/SPEC.md` |
| `mimetype` | readers for media types | `handlers` | `skill://plurnk/packages/@plurnk/plurnk-mimetypes/SPEC.md` |
| `provider` | a model provider | `name` | `skill://plurnk/packages/@plurnk/plurnk-providers/SPEC.md` |

First-party daemon modules implement `DaemonModule` (`@plurnk/plurnk-modules/SPEC.md`) and are composed statically by `@plurnk/plurnk-service`: `mounts` claims listener pathname prefixes before `setup(seam)`, `start(port)` receives `ApplicationPort` (`@plurnk/plurnk-contracts/port`: `registerHttpRoute`, `registerHttpUpgrade`, `ensureSessionReference`, `attachWorkspace`, `createWorkspace`, `createSession`, `runLoop`, `subscribeToEvents`), `stop()` rejects new ingress, and `close()` joins admitted route work.

## Examples

A plugin directory:

```text
acme-tools/
├── plugin.json
├── mcp.json
└── skills/notes-format/SKILL.md
```

`plugin.json`:

```json
{
    "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    "name": "acme-tools",
    "description": "Acme skills and MCP servers."
}
```

`mcp.json` (`$schema` and each server's `type` are required; stdio servers start in the plugin directory):

```json
{
    "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    "mcpServers": {
        "files": { "type": "stdio", "command": "node", "args": ["server.mjs"] }
    }
}
```

ACP v2 client (`@agentclientprotocol/sdk` over WebSocket at `/acp`):

```js
import { client, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";

const app = client()
    .onConnect((conn) => {
        void conn.agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            info: { name: "acme-client", version: "1.0.0" },
        });
    })
    .onRequest(methods.client.session.requestPermission, async ({ params }) => ({
        outcome: { outcome: "selected", optionId: params.options[0]?.optionId ?? "allow_once" },
    }))
    .onRequest(methods.client.elicitation.create, async () => ({ action: "cancel" }));

await app.connectWith(createWebSocketStream(acpWsUrl), async (ctx) => {
    await ctx.initialized;
    await ctx.buildSession("/path/to/project").withSession(async (session) => {
        await session.prompt("Hello.");
        const text = await session.readTextUntilIdle();
    });
});
```

First-party scheme package `package.json` (default export is the scheme handler):

```json
{
    "name": "@plurnk/plurnk-schemes-notes",
    "type": "module",
    "exports": { ".": "./dist/index.js" },
    "plurnk": { "kind": "scheme", "name": "notes" }
}
```

First-party `DaemonModule` `./module` export:

```js
export default () => {
    const work = new Set();
    let stopping = false;
    return {
        mounts: ["/events"],
        setup(seam) {},
        start(port) {
            port.registerHttpRoute("/events", (req, res) => {
                if (stopping) { res.writeHead(503).end(); return; }
                const run = (async () => {
                    const { workspaceId, sessionId } = await port.ensureSessionReference({
                        namespace: "events",
                        reference: req.headers["x-event-id"] ?? crypto.randomUUID(),
                    });
                    await port.runLoop({ workspaceId, sessionId, prompt: "Event received." });
                    res.writeHead(202).end();
                })();
                work.add(run);
                void run.finally(() => work.delete(run));
            });
        },
        stop() { stopping = true; },
        async close() { while (work.size > 0) await Promise.allSettled([...work]); },
    };
};
```

## Contracts

`skill://plurnk/packages/<package name>/SPEC.md` and sibling `dist/**/*.d.ts` declarations hold each installed `@plurnk/*` package's contract (`@plurnk/plurnk-contracts/dist/src/ApplicationPort.d.ts` declares `ApplicationPort`; `@plurnk/plurnk-acp/dist/client.d.ts` declares `_meta.plurnk` client metadata); `plurnk.find` searches headings and symbols across `skill://plurnk/packages/**`.
