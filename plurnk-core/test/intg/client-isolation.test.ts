// {§connection-lifecycle} / {§actor-boundary-isolation} — a person's client operations journal in the
// workspace's runtime session, end-to-end.
//
// A client `op.*` lands in the runtime session `_plurnk`; `loop.run` runs the model in its own model
// session; the packet renders the model session, so no client-origin row ever reaches the model's log —
// invisibility by session, no origin filter. This proves the server wiring (op.* → runtime session,
// loop.run → model session) that the engine-level {§actor-boundary-isolation} guarantee rests on.
//
// {§machine-processes-model-session-readable}: a client READS the model session by id —
// loop.run returns its modelSessionId and log.read({ sessionId }) targets it, ownership-gated.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, rpcProblem, connect, withDaemon, runLoopToTerminal } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";
import { insertWorkspace, insertSession } from "./_db.ts";
import SeamSocket from "./_seam.ts";

test("{§machine-processes} a client operation cannot SEND the runtime actor into model inference", async () => {
    const mock = new Mock({
        contextWindow: 8192,
        responses: [makeMockResponse("````SEND [200]\nthis must remain unused\n````", 50)],
    });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "client-runtime-send" });
            const response = await rpcCall(ws, 2, "op.send", {
                recipient: "session://_plurnk",
                body: "run a model in the runtime actor",
            });
            const problem = rpcProblem(response);
            assert.equal(problem.status, 409);
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/session/model-session-required");
            assert.equal(mock.remaining, 1, "the refused runtime actor consumes no model response");
        } finally { ws.close(); }
    });
});

test("{§connection-lifecycle} {§actor-boundary-isolation} a client op.* journals in the runtime session and never enters the model's packet", async () => {
    // The model just terminates; we only care where the client op landed.
    const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("````SEND [200]\ndone\n````", 50)] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "client-isolation" });
            const workspaceId = (created.result as { id: number }).id;
            // A client op — lands in the workspace's runtime session.
            await rpcCall(ws, 2, "op.edit", { target: "workspace:///secret", content: "client-only" });
            // The model works in its own session.
            const result = await runLoopToTerminal(ws, 3, { prompt: "go" });
            const loopId = (result as { loopId: number }).loopId;

            const modelSession = await db.test_get_session_id_by_loop.get<{ session_id: number }>({ loop_id: loopId });
            assert.ok(modelSession !== undefined, "the model loop has a session");

            // The model's packet is rendered from the model session alone.
            const modelLog = await db.engine_render_log.all<{ origin: string; pathname: string }>({ session_id: modelSession.session_id });
            assert.ok(modelLog.length > 0, "the model's packet carries its own log");
            assert.ok(
                modelLog.every((r) => r.origin !== "client"),
                "no client-origin op reaches the model's packet — the person's operation journals in the runtime session",
            );

            // The client still sees its own op: log.read reads the runtime session, where the op.edit lives.
            const own = await rpcCall(ws, 4, "log.read");
            const entries = (own.result as { entries: Array<{ origin: string; op: string }> }).entries;
            assert.ok(entries.some((e) => e.op === "EDIT" && e.origin === "client"), "the client reads its own op from the runtime session");
            const runtime = await daemon.readSession({ workspaceId, identity: { name: "_plurnk" } });
            assert.equal(runtime?.origin, "_plurnk");
            assert.notEqual(runtime?.id, modelSession.session_id, "the runtime session is distinct from the model session");
        } finally { ws.close(); }
    });
});

test("{§connection-lifecycle} a connection reads the model session by id — loop.run returns modelSessionId, log.read targets it, ownership-gated", async () => {
    const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("````SEND [200]\ndone\n````", 50)] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "model-session-readable" });
            const workspaceId = (created.result as { id: number }).id;
            // A client op lands in the workspace's runtime session.
            await rpcCall(ws, 2, "op.edit", { target: "workspace:///note", content: "client-only" });
            // Drive the model — it works in its own session, whose id loop.run returns.
            const result = await runLoopToTerminal(ws, 3, { prompt: "go" });
            const { loopId, modelSessionId } = result as { loopId: number; modelSessionId: number };
            assert.equal(typeof modelSessionId, "number", "loop.run returns the model session's id");
            assert.notEqual(modelSessionId, await daemon.ensureRuntimeSession(workspaceId), "the model session is distinct from the runtime session");
            const byLoop = await db.test_get_session_id_by_loop.get<{ session_id: number }>({ loop_id: loopId });
            assert.equal(byLoop!.session_id, modelSessionId, "the returned modelSessionId is the session the loop actually ran in");

            // Default log.read (no sessionId) → the runtime session: the op.edit.
            const own = await rpcCall(ws, 4, "log.read");
            const ownEntries = (own.result as { entries: Array<{ origin: string; op: string }> }).entries;
            assert.ok(ownEntries.some((e) => e.op === "EDIT" && e.origin === "client"), "default log.read reads the runtime session");

            // log.read({ sessionId }) → the MODEL session's log: readable by id,
            // and a DISTINCT session — the client's op is absent from it.
            const modelRead = await rpcCall(ws, 5, "log.read", { sessionId: modelSessionId });
            const modelEntries = (modelRead.result as { entries: Array<{ origin: string; op: string }> }).entries;
            assert.ok(modelEntries.length > 0, "the model session's log is readable by id");
            assert.ok(!modelEntries.some((e) => e.op === "EDIT" && e.origin === "client"), "the model session is distinct — the client's op is absent from it");

            // Ownership: a session in a DIFFERENT workspace is refused from this connection.
            const foreignWorkspace = await insertWorkspace(db, `foreign-${crypto.randomUUID()}`);
            const foreignSession = await insertSession(db, foreignWorkspace, null, undefined, "model");
            const denied = await rpcCall(ws, 6, "log.read", { sessionId: foreignSession });
            const problem = rpcProblem(denied);
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/session/workspace-mismatch");
            assert.equal(problem.sessionId, foreignSession);
            assert.equal(problem.actualWorkspaceId, foreignWorkspace);
        } finally { ws.close(); }
    });
});

test("{§connection-lifecycle} workspace.sessions tags each session with its actor — the model session is found by origin, not name", async () => {
    const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("````SEND [200]\ndone\n````", 50)] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "session-origin" });
            await rpcCall(ws, 2, "op.edit", { target: "workspace:///note", content: "x" });
            const result = await runLoopToTerminal(ws, 3, { prompt: "go" });
            const { modelSessionId } = result as { modelSessionId: number };

            const listed = (await rpcCall(ws, 4, "workspace.sessions")).result as { sessions: Array<{ id: number; name: string; origin: string }> };
            const model = listed.sessions.find((r) => r.id === modelSessionId);
            assert.equal(model?.origin, "model", "the model session is tagged origin=model");
            assert.equal(model?.name, SeamSocket.session);
            // A person's operations journal in the runtime session, the workspace's one `_plurnk` actor.
            assert.deepEqual(listed.sessions.filter((r) => r.origin !== "model").map(({ name, origin }) => ({ name, origin })),
                [{ name: "_plurnk", origin: "_plurnk" }], "the only other session is the runtime actor");
            // A client picks the model session by actor — no name parsing.
            assert.deepEqual(listed.sessions.filter((r) => r.origin === "model").map((r) => r.id), [modelSessionId], "exactly one model session, found by origin");
        } finally { ws.close(); }
    });
});
