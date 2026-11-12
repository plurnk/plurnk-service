# Extending Plurnk

## Summary

Plurnk integrates and extends through configuration, personas, Agent Skills, MCP servers, Agent Plugins, ACP v2 clients, notification consumers, and first-party `@plurnk/*` framework packages or daemon modules.

## Choosing a surface

Surfaces run from least to most code and trust:

- **Configuration**: when a setting in the `.env` cascade or a root path in `PLURNK_SERVICE_ROOTS` suffices.
- **Operating policy** (`AGENTS.md` / `AGENTS.local.md`): when standing instructions apply across a user environment, project, or session (`session://<session>/AGENTS.md`).
- **A persona** (`persona://<name>/PERSONA.md`): when a reusable identity, optional model/effort route, and instruction body are selected per session or copied to `session://<session>/AGENTS.md`.
- **A skill** (`<root>/.agents/skills/<name>/SKILL.md`): when a task needs reference docs or scripts run with existing runtimes (`sh`, `js`, `python3`).
- **An MCP server** (`.agents/mcp.json` or `plurnk.mcp`): when Plurnk calls external tools, resources, or prompts from a `stdio` process or `streamable-http` endpoint without modifying the daemon.
- **A plugin** (`.agents/plugins/<name>/plugin.json`): when a directory in `PLURNK_SERVICE_ROOTS` (including a project) bundles `skills/`, `personas/`, and `mcp.json` together.
- **An ACP v2 client** (`/acp`): when an external application, chat bridge, or webhook receiver drives sessions, prompts, and permission gates from outside the daemon.
- **A notification consumer** (`GET /notifications`): when an external watcher subscribes to `DaemonNotification` SSE events (`loop/terminated`, `loop/interaction`, `notice/event`, ...).
- **A `@plurnk/*` framework package** (`package.json#plurnk`): when adding a built-in runtime (`exec`), address scheme (`scheme`), media-type reader (`mimetype`), or model provider (`provider`) installed in the daemon's own `node_modules` at startup (never loaded from a project directory; `PLURNK_EXTENSIONS_TRUSTED_ONLY` restricts imports to `@plurnk/plurnk-service`'s root manifest).
- **A `DaemonModule`** (`@plurnk/plurnk-modules`): when composing a first-party functionality family, listener mount, or lifecycle observer statically in `@plurnk/plurnk-service` (`ServiceModules`; never discovered dynamically from a project directory or `node_modules`).

## Surfaces and wire shapes

| Surface | Location / wire shape | Model or client surface | In-daemon code |
| --- | --- | --- | --- |
| Persona | `<name>.md`, `<name>/PERSONA.md`, or `plurnk.personas` | `persona://<name>/PERSONA.md` | none |
| Skill | `<root>/.agents/skills/<name>/SKILL.md` or `plurnk.skills` | `skill://<name>/` | none |
| MCP server | `.agents/mcp.json` or `plurnk.mcp` (`stdio` newline-delimited JSON-RPC 2.0 `initialize` / `tools/list` / `tools/call`, or `streamable-http`) | `<server>.<tool>` and `<server>://` | none |
| Plugin | `<root>/.agents/plugins/<name>/plugin.json` + `skills/`, `personas/`, `mcp.json` (plugin MCP servers enable via `plurnk.mcp({ name, enabled: true })`) | bundled skills, personas, MCP servers | none |
| ACP v2 client | WebSocket or Streamable HTTP JSON-RPC 2.0 at `/acp` (`PLURNK_HOST`:`PLURNK_PORT`); under `PLURNK_AUTH=1`, `POST /oauth/token` (`grant_type=client_credentials`, Basic `<id>:<secret>` for `PLURNK_AUTH_CLIENT_<id>='{"secret":"<secret>","scopes":["acp"]}'` or `operator`:`PLURNK_SECRET`, `scope=acp`) issues `{ access_token }` for `Authorization: Bearer <token>` | `conn.agent.request`: `initialize` (`{ protocolVersion: 2, info }`), `session/new` / `session/resume` (`{ cwd, mcpServers }` or `_meta.plurnk.workspace` → `{ sessionId: "<workspaceId>#<name>" }`), `session/prompt` (`{ sessionId, prompt: [{ type: "text", text }] }` → `{ stopReason }`), `session/close`; `conn.agent.notify`: `session/cancel` (`{ sessionId }`); client handlers: `session/update` (`{ sessionId, update }` with `agent_message_chunk` `{ messageId, content: { type: "text", text } }`, `agent_thought_chunk`, `tool_call_update` `{ toolCallId, title, status }`, `state_update` `{ state: "running" \| "idle", stopReason? }`), `session/request_permission` (`{ sessionId, title, description?, subject?, options: [{ optionId, name, kind }] }` → `{ outcome: { outcome: "selected", optionId } \| { outcome: "cancelled" } }`), `elicitation/create` (`{ mode: "form" \| "url", sessionId, message, requestedSchema?, url? }` → `{ action: "accept", content? } \| { action: "decline" } \| { action: "cancel" }`) | none |
| Notification stream | `GET /notifications[?event=...&workspace=...&session=...]` SSE (`Authorization: Bearer <token>` or `?access_token=<token>`, `acp` or `notifications` scope; `: heartbeat` every `PLURNK_SERVICE_NOTIFICATIONS_HEARTBEAT_MS`) | `event: <DaemonNotificationEvent>` (`loop/terminated`, `loop/proposal`, `loop/interaction`, `session/created`, `notice/event`, ...), `data: <DaemonNotification JSON>` (`{ id, event, timestamp, workspaceId, sessionId, data }`) | none |
| `@plurnk/*` package | `package.json#plurnk` in daemon `node_modules`: `kind: "exec"` (`runtimes` / `runtimesModule`), `"scheme"` (`schemes` / `name`), `"mimetype"` (`handlers`), or `"provider"` (`name`) | built-in runtime, scheme, media-type reader, or model provider | first-party |
| `DaemonModule` | `@plurnk/plurnk-modules` `./module` export composed statically in `ServiceModules`: `mounts`, `setup(seam)`, `start(port)`, `stop()`, `close()` | daemon functionality family or listener mount | first-party |

## Examples

Plugin directory (`.agents/plugins/acme-tools/plugin.json` and `mcp.json`; `$schema` and server `type` are required, and `stdio` commands start in the plugin directory):

```json
{ "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", "name": "acme-tools", "description": "Acme skills and MCP servers." }
```

```json
{ "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", "mcpServers": { "files": { "type": "stdio", "command": "node", "args": ["server.mjs"] } } }
```

ACP v2 client (`@agentclientprotocol/sdk` over WebSocket at `/acp`; `createWebSocketStream` takes `WebSocket` from `ws` for Node upgrade `headers`, `createHttpStream` from `@agentclientprotocol/sdk/experimental/http-client` connects over HTTP, and `app.connect(agent())` connects in-process without a daemon):

```js
import { WebSocket } from "ws";
import { client, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
const tokenRes = clientSecret && await fetch(`${httpOrigin}/oauth/token`, {
    method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}` },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "acp" }),
});
const headers = tokenRes ? { Authorization: `Bearer ${(await tokenRes.json()).access_token}` } : {};
const app = client()
    .onNotification(methods.client.session.update, ({ params: { sessionId, update } }) => {
        // sessionId is "<workspaceId>#<name>"; update.sessionUpdate is "agent_message_chunk" | "state_update" | ...
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") onChunk(sessionId, update.content.text);
        if (update.sessionUpdate === "state_update" && update.state === "idle") onIdle(sessionId, update.stopReason);
    })
    .onRequest(methods.client.session.requestPermission, async ({ params }) => ({ outcome: { outcome: "selected", optionId: params.options[0]?.optionId ?? "allow_once" } }))
    .onRequest(methods.client.elicitation.create, async () => ({ action: "cancel" }));
const conn = app.connect(createWebSocketStream(acpWsUrl, { WebSocket, headers }));
await conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, info: { name: "acme-client", version: "1.0.0" } });
const { sessionId } = await conn.agent.request(methods.agent.session.new, { cwd: "/path/to/project", mcpServers: [] }); // or session.resume({ sessionId, cwd })
const { stopReason } = await conn.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "Hello." }] }); // cancel via conn.agent.notify(methods.agent.session.cancel, { sessionId })
```

Notification SSE consumer (`GET /notifications?event=loop/terminated`; `data` is a `DaemonNotification` envelope `{ id, event, timestamp, workspaceId, sessionId, data }` where `loop/terminated` carries `data.result` `{ status, body, problem }` and `data.hitMaxTurns`):

```js
const res = await fetch(`${httpOrigin}/notifications?event=loop/terminated`, { headers });
let buffer = "";
for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    for (let idx; (idx = buffer.indexOf("\n\n")) !== -1; buffer = buffer.slice(idx + 2)) {
        const dataLine = buffer.slice(0, idx).split("\n").find((line) => line.startsWith("data: "));
        if (!dataLine) continue; // ignores ": heartbeat" comments
        const { workspaceId, sessionId, data } = JSON.parse(dataLine.slice(6));
        onLoopTerminated({ workspaceId, sessionId, status: data.result.status, problem: data.result.problem });
    }
}
```

First-party `@plurnk/*` scheme `package.json` and static `DaemonModule` `./module` export:

```json
{ "name": "@plurnk/plurnk-schemes-notes", "type": "module", "exports": { ".": "./dist/index.js" }, "plurnk": { "kind": "scheme", "name": "notes" } }
```

```js
export default () => ({ mounts: ["/events"], setup(seam) {}, start(port) { port.registerHttpRoute("/events", (req, res) => res.writeHead(202).end()); }, stop() {}, async close() {} });
```

## Contracts

`skill://plurnk/packages/<package name>/SPEC.md` and sibling `dist/**/*.d.ts` hold each installed `@plurnk/*` package's contract (`@plurnk/plurnk-acp`, `@plurnk/plurnk-auth`, `@plurnk/plurnk-mcp`, `@plurnk/plurnk-modules`, `@plurnk/plurnk-execs`, `@plurnk/plurnk-schemes`, `@plurnk/plurnk-mimetypes`, `@plurnk/plurnk-providers`, and `@plurnk/plurnk-contracts/dist/src/{ApplicationNotifications,ApplicationPort}.d.ts`), and `skill://plurnk/packages/@agentclientprotocol/sdk/{package.json,dist/**}` (`package.json` `exports`, `dist/v2/acp.d.ts`, `dist/v2/unstable/schema/types.gen.d.ts`, `dist/transports/ws-stream.d.ts`, `dist/transports/http-stream.d.ts`) holds the ACP v2 SDK surface; `plurnk.find` searches headings and symbols across `skill://plurnk/packages/**`.
