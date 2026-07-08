// The full bridge against a FIXTURE daemon speaking the plurnk JSON-RPC wire shapes: POST an
// AG-UI RunAgentInput, read the SSE stream, resolve a proposal mid-run. The fixture is honest —
// the bridge's contract IS the daemon wire, so a wire-shaped fixture tests exactly the seam.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import Server from "../../src/Server.ts";

const fixtureDaemon = async (): Promise<{ url: string; close: () => Promise<void>; resolved: Array<Record<string, unknown>>; created: Array<Record<string, unknown>>; ran: Array<Record<string, unknown>> }> => {
    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    const resolved: Array<Record<string, unknown>> = [];
    const created: Array<Record<string, unknown>> = [];
    const ran: Array<Record<string, unknown>> = [];
    wss.on("connection", (socket) => {
        const send = (msg: object): void => socket.send(JSON.stringify(msg));
        socket.on("message", (raw: Buffer) => {
            const msg = JSON.parse(raw.toString()) as { id: number; method: string; params: Record<string, unknown> };
            if (msg.method === "session.attach") { send({ jsonrpc: "2.0", id: msg.id, error: { code: -1, message: "no such session" } }); return; }
            if (msg.method === "session.list") { send({ jsonrpc: "2.0", id: msg.id, result: { sessions: [] } }); return; }
            if (msg.method === "session.create") { created.push(msg.params); send({ jsonrpc: "2.0", id: msg.id, result: { id: 1, name: msg.params.name, runId: 2, runName: "model-x" } }); return; }
            if (msg.method === "session.prompts") { send({ jsonrpc: "2.0", id: msg.id, result: { prompts: ["deploy the service"] } }); return; }
            if (msg.method === "loop.resolve") {
                resolved.push(msg.params);
                send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
                // The answered question resolves the world: the model concludes.
                send({ jsonrpc: "2.0", method: "log/entry", params: { entry: { id: 12, coordinate: "1/2/1/SEND", op: "SEND", origin: "model", signal: 200, status_rx: 200, turn_id: 2, tx: { op: "SEND", body: "Deploying to staging." } } } });
                send({ jsonrpc: "2.0", method: "loop/terminated", params: { loopId: 1, finalStatus: 200, hitMaxTurns: false, usage: { promptTokens: 100, completionTokens: 20, costPico: 0, contextTokens: 100, contextSize: 6848, meta: {} } } });
                return;
            }
            if (msg.method === "loop.run") {
                ran.push(msg.params);
                send({ jsonrpc: "2.0", id: msg.id, result: { loopId: 1, action: "enqueued_new_loop", finalStatus: 100 } });
                // The scripted run: PLAN → a READ with rx → a [300] question proposal (stop the world).
                send({ jsonrpc: "2.0", method: "log/entry", params: { entry: { id: 10, coordinate: "1/1/1/PLAN", op: "PLAN", origin: "model", turn_id: 1, tx: { op: "PLAN", body: "ask the operator" } } } });
                send({ jsonrpc: "2.0", method: "log/entry", params: { entry: { id: 11, coordinate: "1/1/2/READ", op: "READ", origin: "model", scheme: "known", pathname: "/notes.md", turn_id: 1, tx: { op: "READ", body: null }, rx: { status: 200, content: "notes" }, status_rx: 200 } } });
                // Phase-A coverage: telemetry/event (was dropped by a wrong subscription) and
                // stream/event (the start line, previously not forwarded) must both project.
                send({ jsonrpc: "2.0", method: "telemetry/event", params: { loopId: 1, event: { source: "engine:rail", kind: "note", level: "info", message: "orienting" } } });
                send({ jsonrpc: "2.0", method: "stream/event", params: { entryId: 20, target: "exec://python/1/1/3", channel: "stdout", state: "active", contentLength: 5, loop_seq: 1, turn_seq: 1, sequence: 3 } });
                send({ jsonrpc: "2.0", method: "loop/proposal", params: { logEntryId: 42, sessionId: 1, runId: 2, loopId: 1, turnId: 1, op: "SEND", target: { scheme: null, pathname: null }, body: "", attrs: { question: "Which environment?", choices: ["prod", "staging"] }, flags: { yolo: false } } });
                return;
            }
            send({ jsonrpc: "2.0", id: msg.id, result: {} });
        });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const addr = http.address() as { port: number };
    return {
        url: `ws://127.0.0.1:${addr.port}`,
        close: () => new Promise((resolve) => { wss.close(); http.close(() => resolve()); }),
        resolved,
        created,
        ran,
    };
};

test("[§agui-run-endpoint][§agui-thread-is-session][§agui-daemon-client][§agui-forwarded-props][§agui-management-plane] e2e: RunAgentInput → SSE projection → /resolve answers the question → RUN_FINISHED", async () => {
    const daemon = await fixtureDaemon();
    process.env.PLURNK_AGUI_DAEMON_URL = daemon.url;
    process.env.PLURNK_AGUI_PORT = "0";
    const bridge = new Server();
    const { port } = await bridge.listen();
    try {
        const events: Array<{ type: string; name?: string; value?: { logEntryId?: number } }> = [];
        const streamDone = (async () => {
            const res = await fetch(`http://127.0.0.1:${port}/`, {
                method: "POST",
                headers: { "content-type": "application/json", accept: "text/event-stream" },
                body: JSON.stringify({ threadId: "t1", runId: "r1", messages: [{ role: "user", content: "deploy the service" }], forwardedProps: { plurnk: { projectRoot: "/tmp/ws", settings: { questions: true }, alias: "opus", flags: { mode: "ask" } } } }),
            });
            assert.equal(res.headers.get("content-type"), "text/event-stream");
            const reader = res.body!.getReader();
            let buffer = "";
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += new TextDecoder().decode(value);
                let i;
                while ((i = buffer.indexOf("\n\n")) >= 0) {
                    const frame = buffer.slice(0, i); buffer = buffer.slice(i + 2);
                    if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)));
                }
            }
        })();

        // Wait for the stop-the-world proposal to reach the frontend, then answer it.
        for (let i = 0; i < 100 && !events.some((e) => e.name === "plurnk.proposal"); i++) await new Promise((r) => setTimeout(r, 50));
        const proposal = events.find((e) => e.name === "plurnk.proposal");
        assert.ok(proposal, "the [300] question surfaced as plurnk.proposal on the SSE stream");
        const resolveRes = await fetch(`http://127.0.0.1:${port}/resolve`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ threadId: "t1", logEntryId: proposal!.value!.logEntryId, decision: "accept", body: "staging" }),
        });
        assert.equal(resolveRes.status, 200);
        await streamDone;

        assert.equal(daemon.resolved[0]?.body, "staging", "the accept body reached the daemon's loop.resolve — the answer path");
        const types = events.map((e) => e.type);
        assert.equal(types[0], "RUN_STARTED");
        assert.ok(types.includes("THINKING_TEXT_MESSAGE_CONTENT"), "PLAN projected as thinking");
        assert.ok(types.includes("TOOL_CALL_RESULT"), "the READ's rx projected as a tool result");
        assert.ok(types.includes("TEXT_MESSAGE_CONTENT"), "the concluding SEND projected as assistant speech");
        assert.ok(types.includes("STATE_DELTA"), "the budget truth rode the stream");
        assert.ok(events.some((e) => e.name === "plurnk.telemetry" && (e.value as { source?: string })?.source === "engine:rail"), "telemetry/event projected UNWRAPPED — value is the TelemetryEvent, not the {loopId,event} envelope");
        assert.ok(events.some((e) => e.name === "plurnk.stream" && (e.value as { state?: string })?.state === "active"), "stream/event (the start line) projected to plurnk.stream");
        assert.equal(types[types.length - 1], "RUN_FINISHED", "the stream ends on the run's conclusion");
        // §agui-forwarded-props — the side-channel reached session.create verbatim.
        assert.equal(daemon.created[0]?.projectRoot, "/tmp/ws", "forwardedProps.plurnk.projectRoot rode the first run");
        assert.equal((daemon.created[0]?.settings as { questions?: boolean }).questions, true);
        // C0 — per-run knobs from forwardedProps.plurnk reach loop.run (the TUI's /model + mode).
        assert.equal(daemon.ran[0]?.alias, "opus", "forwardedProps.plurnk.alias → loop.run.alias");
        assert.equal((daemon.ran[0]?.flags as { mode?: string })?.mode, "ask", "forwardedProps.plurnk.flags → loop.run.flags");

        // §agui-management-plane — the ONE escape hatch round-trips on the thread's own connection.
        const rpc = await fetch(`http://127.0.0.1:${port}/plurnk/rpc`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ threadId: "t1", method: "session.prompts", params: {} }),
        });
        assert.equal(rpc.status, 200);
        const rpcBody = await rpc.json() as { result: { prompts: string[] } };
        assert.deepEqual(rpcBody.result.prompts, ["deploy the service"], "the daemon's response, verbatim");
    } finally {
        await bridge.close();
        await daemon.close();
    }
});

test("[§agui-auth] a set token gates every POST; empty means local trust", async () => {
    const daemon = await fixtureDaemon();
    process.env.PLURNK_AGUI_DAEMON_URL = daemon.url;
    process.env.PLURNK_AGUI_PORT = "0";
    process.env.PLURNK_AGUI_TOKEN = "s3cret";
    const bridge = new Server();
    const { port } = await bridge.listen();
    try {
        const denied = await fetch(`http://127.0.0.1:${port}/plurnk/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: "t", method: "ping" }) });
        assert.equal(denied.status, 401, "no bearer → 401 before any body work");
        const allowed = await fetch(`http://127.0.0.1:${port}/plurnk/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer s3cret" }, body: JSON.stringify({ threadId: "t", method: "session.prompts", params: {} }) });
        assert.equal(allowed.status, 200, "the bearer opens the door");
    } finally {
        delete process.env.PLURNK_AGUI_TOKEN;
        await bridge.close();
        await daemon.close();
    }
});
