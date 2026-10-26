// {§methods-log-read}, {§machine-processes-model-session-readable}: readLog selects one
// ownership-verified session without mixing sibling journal rows.
import test from "node:test";
import assert from "node:assert/strict";
import { rpcCall, connect, withDaemon } from "./_rpc.ts";
import Dsl from "./dsl.ts";
import { modelOperation, namedModelSession } from "./_sessions.ts";
import { TEST_OWNER } from "./_approval.ts";

test("{§methods-log-read}: readLog honors per-session journal isolation", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "r376" });
            const workspaceId = (created.result as { id: number }).id;
            const modelSession = await namedModelSession(daemon, workspaceId, "main");
            // Seed one row in each session: a person's operation journals in the runtime session
            // ({§connection-lifecycle}); the model's own operation in its session.
            await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: [Dsl.buildEdit({ target: "workspace:///client-note", content: "client row" })] });
            await modelOperation(daemon, db, { workspaceId, sessionId: modelSession, statement: Dsl.buildEdit({ target: "workspace:///model-note", content: "model row" }) });
            const runtimeSession = await daemon.ensureRuntimeSession(workspaceId);
            const runtimeRows = await daemon.readLog({ workspaceId, sessionId: runtimeSession });
            const modelRows = await daemon.readLog({ workspaceId, sessionId: modelSession });
            assert.ok(runtimeRows.length > 0 && modelRows.length > 0, "both sessions have rows");
            const runtimeSet = new Set(runtimeRows.map((r) => JSON.stringify(r)));
            assert.ok(!modelRows.every((r) => runtimeSet.has(JSON.stringify(r))), "the two sessions return DIFFERENT rows");
        } finally { ws.close(); }
    });
});

test("{§methods-log-read}: the panel is the page of a read that names no limit, and the ceiling of one that does", async () => {
    const prior = { page: process.env.PLURNK_SERVICE_LOG_READ_PAGE, max: process.env.PLURNK_SERVICE_LOG_READ_MAX };
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "readlog-page" });
            const workspaceId = (created.result as { id: number }).id;
            for (let n = 1; n <= 5; n += 1) {
                await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: [Dsl.buildEdit({ target: `workspace:///note-${n}`, content: `row ${n}` })] });
            }
            // A person's operations journal in the runtime session ({§connection-lifecycle}).
            const sessionId = await daemon.ensureRuntimeSession(workspaceId);
            process.env.PLURNK_SERVICE_LOG_READ_PAGE = "2";
            process.env.PLURNK_SERVICE_LOG_READ_MAX = "4";
            assert.equal((await daemon.readLog({ workspaceId, sessionId })).length, 2, "no limit named: the page");
            assert.equal((await daemon.readLog({ workspaceId, sessionId, limit: 3 })).length, 3, "a named limit beneath the ceiling stands");
            assert.equal((await daemon.readLog({ workspaceId, sessionId, limit: Number.MAX_SAFE_INTEGER })).length, 4, "as many as it likes: the ceiling");
        } finally {
            ws.close();
            for (const [name, value] of [["PLURNK_SERVICE_LOG_READ_PAGE", prior.page], ["PLURNK_SERVICE_LOG_READ_MAX", prior.max]] as const) {
                if (value === undefined) delete process.env[name]; else process.env[name] = value;
            }
        }
    });
});
