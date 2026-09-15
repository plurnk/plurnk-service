// {§op-look} — a look resolves as its perspective worker while the closed observation
// segment stays on the acting worker: a client sees the conversation's private scratch as
// the model does, and the conversation gains no loop from being looked at (plurnk#68).
import test from "node:test";
import assert from "node:assert/strict";
import { rpcCall, connect, withDaemon } from "./_rpc.ts";
import Dsl from "./dsl.ts";

const parseOne = (text: string) => Dsl.parseSingleStatement(text);

test("{§op-look}: a look reads as the perspective worker and leaves the conversation's loops alone", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "look-perspective" })).result as { id: number };
            const clientWorker = (await db.test_get_client_worker_by_workspace.get<{ id: number }>({ workspace_id: created.id }))!;
            const model = await daemon.ensureModelWorker(created.id);
            // A row in the conversation's log: a coordinate that exists only from its perspective.
            const written = await daemon.dispatchAsClient({ workspaceId: created.id, workerId: model, statement: Dsl.buildEdit({ target: "worker:///seed.md", content: "seeded for the look" }) });
            assert.ok(written.status < 300, `seed write: ${JSON.stringify(written)}`);
            const rows = await daemon.readLog({ workspaceId: created.id, workerId: model });
            const seeded = rows.at(-1) as { loop_seq: number; turn_seq: number; sequence: number } | undefined;
            assert.ok(seeded !== undefined, "the seed landed in the conversation's log");
            const coordinate = `log:///${seeded.loop_seq}/${seeded.turn_seq}/${seeded.sequence}`;
            const loopsBefore = (await db.test_count_loops_by_worker.get<{ n: number }>({ worker_id: model }))!.n;
            const segmentsBefore = (await db.test_count_loops_by_worker.get<{ n: number }>({ worker_id: clientWorker.id }))!.n;

            const asConnection = await daemon.look({ workspaceId: created.id, workerId: clientWorker.id, statement: parseOne(`\`\`\`READ (${coordinate})\`\`\``) });
            assert.equal(asConnection.status, 404, `as the connection's own worker the coordinate names nothing: ${JSON.stringify(asConnection)}`);

            const asConversation = await daemon.look({ workspaceId: created.id, workerId: clientWorker.id, perspectiveWorkerId: model, statement: parseOne(`\`\`\`READ (${coordinate})\`\`\``) });
            assert.equal(asConversation.status, 200, `as the conversation: ${JSON.stringify(asConversation)}`);
            assert.equal(typeof asConversation.content, "string", "the look reads the row as the model would");

            assert.equal((await db.test_count_loops_by_worker.get<{ n: number }>({ worker_id: model }))!.n, loopsBefore, "the conversation gains no loop from being looked at");
            assert.equal((await db.test_count_loops_by_worker.get<{ n: number }>({ worker_id: clientWorker.id }))!.n, segmentsBefore + 2, "each look leaves one closed segment on the acting worker");
            const status = await daemon.readWorker({ workspaceId: created.id, identity: { id: model } });
            assert.equal(status?.lifecycle, "completed", "the conversation's lifecycle is its own loop's, untouched by inspection");

            await assert.rejects(
                () => daemon.look({ workspaceId: created.id, workerId: clientWorker.id, perspectiveWorkerId: 999999, statement: parseOne("```READ (worker:///x)```") }),
                /does not exist/,
                "a perspective must be a workspace worker",
            );
        } finally { ws.close(); }
    });
});
