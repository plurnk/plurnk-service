# Extending Plurnk

## Summary

Integrate or extend Plurnk with configuration, personas, Agent Skills, MCP servers, Agent Plugins, ACP v2 clients, notification consumers, and first-party `@plurnk/*` framework packages or daemon modules.

## Choosing a surface

Surfaces run from least to most code and trust:

- **Configuration**: when a setting in the `.env` cascade or a root path in `PLURNK_SERVICE_ROOTS` suffices.
- **Operating policy** (`AGENTS.md` / `AGENTS.local.md`): when standing instructions apply across a user environment, project, or session (`session://<session>/AGENTS.md`).
- **A persona** (`persona://<name>/PERSONA.md`): when a reusable identity, optional model/effort route, and instruction body are selected per session or copied to `session://<session>/AGENTS.md`.
- **A skill** (`<root>/.agents/skills/<name>/SKILL.md`): when a task needs reference docs or scripts run with existing runtimes (`sh`, `js`, `python3`).
- **An MCP server** (`.agents/mcp.json` or `plurnk.mcp`): when a project or user integration exposes tools, resources, or prompts from a `stdio` process or `streamable-http` endpoint without modifying the daemon.
- **A plugin** (`.agents/plugins/<name>/plugin.json`): when a directory in `PLURNK_SERVICE_ROOTS` (including a project) bundles `skills/`, `personas/`, and `mcp.json` together.
- **An ACP v2 client** (`/acp`): when an external application, chat bridge, or webhook receiver drives sessions, prompts, and permission gates from outside the daemon.
- **A notification consumer** (`GET /notifications`): when an external subscriber reads `DaemonNotification` SSE events.
- **A `@plurnk/*` framework package** (`package.json#plurnk`): when adding a built-in runtime (`exec`), address scheme (`scheme`), media-type reader (`mimetype`), or model provider (`provider`) installed in the daemon's own `node_modules` at startup (never loaded from a project directory; `PLURNK_EXTENSIONS_TRUSTED_ONLY` restricts imports to `@plurnk/plurnk-service`'s root manifest).
- **A `DaemonModule`** (`@plurnk/plurnk-modules`): when composing a first-party functionality family, listener mount, or lifecycle observer statically into `@plurnk/plurnk-service`.

## Surfaces and wire shapes

| Surface | Location / wire shape | Model or client surface | In-daemon code |
| --- | --- | --- | --- |
| Persona | `<name>.md`, `<name>/PERSONA.md`, or `plurnk.personas` | `persona://<name>/PERSONA.md` | none |
| Skill | `<root>/.agents/skills/<name>/SKILL.md` or `plurnk.skills` | `skill://<name>/` | none |
| MCP server | `.agents/mcp.json` or `plurnk.mcp` (`stdio` / `streamable-http`) | `<server>.<tool>` and `<server>://` | none |
| Plugin | `<root>/.agents/plugins/<name>/plugin.json` + `skills/`, `personas/`, `mcp.json` | bundled skills, personas, MCP servers | none |
| ACP v2 client | WebSocket or Streamable HTTP JSON-RPC 2.0 at `/acp` (`PLURNK_HOST`:`PLURNK_PORT`); under `PLURNK_AUTH=1`, `POST /oauth/token` (`grant_type=client_credentials`, `scope=acp`, `PLURNK_AUTH_CLIENT_<id>`) issues `Authorization: Bearer <token>` | `initialize` (`protocolVersion: 2`), `session/new` / `session/resume` (`{ cwd }` or `_meta.plurnk.workspace` → `sessionId`), `session/prompt` / `session/cancel`, `session/update` (`agent_message_chunk`, `state_update` → `"idle"`), `session/request_permission` / `elicitation/create` | none |
| Notification stream | `GET /notifications[?event=...&workspace=...&session=...]` SSE (`acp` or `notifications` bearer scope) | `DaemonNotification` events | none |
| `@plurnk/*` package | `package.json#plurnk` in daemon `node_modules`: `kind: "exec"` (`runtimes` / `runtimesModule`), `"scheme"` (`schemes` / `name`), `"mimetype"` (`handlers`), or `"provider"` (`name`) | built-in runtime, scheme, media-type reader, or model provider | first-party |
| `DaemonModule` | `@plurnk/plurnk-modules` `./module` export: `mounts`, `setup(seam)`, `start(port)` (`ApplicationPort`: `registerHttpRoute`, `registerHttpUpgrade`, `ensureSessionReference`, `createWorkspace`, `createSession`, `runLoop`, `subscribeToEvents`), `stop()`, `close()` | daemon functionality family or listener mount | first-party |

## Examples

Plugin directory (`.agents/plugins/acme-tools/plugin.json` and `mcp.json`; `$schema` and server `type` are required, and `stdio` commands start in the plugin directory):

```json
{ "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", "name": "acme-tools", "description": "Acme skills and MCP servers." }
```

```json
{ "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", "mcpServers": { "files": { "type": "stdio", "command": "node", "args": ["server.mjs"] } } }
```

ACP v2 client (`@agentclientprotocol/sdk` over WebSocket at `/acp`; pass `WebSocket` from `ws` when sending Node upgrade `headers`, or use `createHttpStream` from `@agentclientprotocol/sdk/experimental/http-client`):

```js
import { WebSocket } from "ws";
import { client, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";

const app = client()
    .onConnect((conn) => void conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, info: { name: "acme-client", version: "1.0.0" } }))
    .onRequest(methods.client.session.requestPermission, async ({ params }) => ({ outcome: { outcome: "selected", optionId: params.options[0]?.optionId ?? "allow_once" } }))
    .onRequest(methods.client.elicitation.create, async () => ({ action: "cancel" }));

await app.connectWith(createWebSocketStream(acpWsUrl, { WebSocket, headers }), async (ctx) => {
    await ctx.initialized;
    await ctx.buildSession({ cwd: "/path/to/project" }).withSession(async (session) => {
        await session.prompt("Hello."); // session.nextUpdate() streams updates; readTextUntilIdle() collects text
        const text = await session.readTextUntilIdle();
    });
});
```

First-party `@plurnk/*` scheme `package.json` and `DaemonModule` `./module` export:

```json
{ "name": "@plurnk/plurnk-schemes-notes", "type": "module", "exports": { ".": "./dist/index.js" }, "plurnk": { "kind": "scheme", "name": "notes" } }
```

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
                    const { workspaceId, sessionId } = await port.ensureSessionReference({ namespace: "events", reference: req.headers["x-event-id"] ?? crypto.randomUUID() });
                    await port.runLoop({ workspaceId, sessionId, prompt: "Event received." });
                    res.writeHead(202).end();
                })();
                work.add(run); void run.finally(() => work.delete(run));
            });
        },
        stop() { stopping = true; },
        async close() { while (work.size > 0) await Promise.allSettled([...work]); },
    };
};
```

## Contracts

`skill://plurnk/packages/<package name>/SPEC.md` and sibling `dist/**/*.d.ts` hold each installed `@plurnk/*` package's contract (`@plurnk/plurnk-acp`, `@plurnk/plurnk-auth`, `@plurnk/plurnk-mcp`, `@plurnk/plurnk-modules`, `@plurnk/plurnk-execs`, `@plurnk/plurnk-schemes`, `@plurnk/plurnk-mimetypes`, `@plurnk/plurnk-providers`, and `@plurnk/plurnk-contracts/dist/src/ApplicationPort.d.ts`), and `skill://plurnk/packages/@agentclientprotocol/sdk/dist/**` (`v2/acp.d.ts`, `v2/unstable/schema/types.gen.d.ts`, `transports/ws-stream.d.ts`, `transports/http-stream.d.ts`) holds the ACP v2 SDK declarations; `plurnk.find` searches headings and symbols across `skill://plurnk/packages/**`.
