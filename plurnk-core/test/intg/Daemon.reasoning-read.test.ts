// {§methods-reasoning-read} — a turn's readable reasoning is its `reasoning://<worker>/<loop>/<turn>` source, the very
// text the turn's first model operation row projects ({§methods-readable-reasoning}); a turn that reasoned none, or one
// that does not exist, reads null; another workspace's Worker and an unknown one are refused.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { OperationFailureError } from "../../src/core/results.ts";
import { makeMockResponse } from "./_mock.ts";
import { waitForDb, withDaemon } from "./_rpc.ts";
import { namedModelWorker } from "./_workers.ts";

const reasoned = (dsl: string, reasoning: string) => {
    const response = makeMockResponse(dsl);
    return { ...response, assistant: { ...response.assistant, reasoning } };
};

const refusedAs = (type: string) => (error: unknown): boolean =>
    error instanceof OperationFailureError && error.result.problem?.type === `https://problems.plurnk.xyz/daemon/worker/${type}`;

test("{§methods-reasoning-read}: a turn's reasoning is the text its first model operation row projects, and null without one", async () => {
    const thought = "Weighing the first answer.\nIt is short.";
    const provider = new Mock({ contextWindow: 32768, responses: [
        reasoned("````NOTE\nThinking it through.\n````", thought),
        makeMockResponse("````SEND [200]\nThe answer.\n````"),
    ] });
    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "reasoning-read" });
        const workerId = await namedModelWorker(daemon, workspaceId, "main");
        const terminated = new Set<number>();
        const off = daemon.subscribeToEvents((_workspaceId: number | null, method: string, params: unknown) => {
            if (method === "loop/terminated") terminated.add((params as { loopId: number }).loopId);
        });
        try {
            const { loopId } = await daemon.runLoop({ workspaceId, workerId, prompt: "Think, then answer." });
            await waitForDb(async () => terminated.has(loopId), (done) => done);
            const rows = await daemon.readLog({ workspaceId, workerId });
            const carrying = rows.find((row) => typeof row.reasoning === "string");
            assert.ok(carrying, "a row of the turn that reasoned carries its reasoning");
            const read = (loopSeq: number, turnSeq: number) => daemon.readReasoning({ workspaceId, workerId, loopSeq, turnSeq });
            assert.equal(await read(carrying.loop_seq, carrying.turn_seq), thought, "the reasoning source is the text the row projects");
            const silent = rows.find((row) => row.origin === "model" && row.turn_seq !== carrying.turn_seq);
            assert.ok(silent, "the answering turn reasoned none");
            assert.equal(await read(silent.loop_seq, silent.turn_seq), null, "a turn that reasoned none reads null");
            assert.equal(await read(carrying.loop_seq, 99), null, "a turn that does not exist reads null");

            const { workspaceId: elsewhere } = await daemon.createWorkspace({ name: "reasoning-read-elsewhere" });
            await assert.rejects(daemon.readReasoning({ workspaceId: elsewhere, workerId, loopSeq: carrying.loop_seq, turnSeq: carrying.turn_seq }),
                refusedAs("workspace-mismatch"), "another workspace reads none of this Worker's reasoning");
            await assert.rejects(daemon.readReasoning({ workspaceId, workerId: 999_999, loopSeq: 1, turnSeq: 1 }),
                refusedAs("worker-not-found"));
        } finally {
            off();
        }
    });
});
