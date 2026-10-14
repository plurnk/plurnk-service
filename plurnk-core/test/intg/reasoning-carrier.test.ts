import assert from "node:assert/strict";
import test from "node:test";
import { Mock, type MockResponse } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { makeMockResponse } from "./_mock.ts";
import { waitForDb, withDaemon } from "./_rpc.ts";

const reasoned = (dsl: string, reasoning: string): MockResponse => {
    const response = makeMockResponse(dsl);
    return { ...response, assistant: { ...response.assistant, reasoning } };
};

test("{§methods-readable-reasoning}: a turn's admitted reasoning rides its first model operation row, announced and read, and no other row repeats it", async () => {
    const provider = new Mock({ contextWindow: 100_000, responses: [
        reasoned([
            PlurnkParser.frame("READ (worker:///facts.txt)", null),
            PlurnkParser.frame("NOTE", "Answer from the facts."),
        ].join("\n\n"), "First turn reasoning."),
        reasoned(PlurnkParser.frame("SEND [200]", "Done."), "Second turn reasoning."),
    ] });
    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "reasoning-carrier", projectRoot: null });
        const { workerId } = await daemon.createConversationWorker({ workspaceId, name: "reasoner" });
        const announced = new Map<number, { op: unknown; reasoning?: unknown }>();
        const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => {
            if (method !== "log/entry") return;
            const { entry } = params as { entry: { id: number; worker_id: number; origin: string; op: unknown; reasoning?: unknown } };
            if (entry.worker_id === workerId && entry.origin === "model" && entry.op !== null && !announced.has(entry.id)) announced.set(entry.id, entry);
        });
        try {
            const accepted = await daemon.runLoop({ workspaceId, workerId, prompt: "Report the facts." });
            await waitForDb(() => daemon.listWorkerLoops({ workspaceId, workerId }),
                (rows) => rows.some((row) => row.id === accepted.loopId && row.status === 200));
            const rows = (await daemon.readLog({ workspaceId, workerId, loopId: accepted.loopId }))
                .filter((row) => row.origin === "model" && row.op !== null)
                .toSorted((left, right) => left.id - right.id);
            const carriers = [["READ", "First turn reasoning."], ["NOTE", null], ["SEND", "Second turn reasoning."]];
            assert.deepEqual(rows.map((row) => [row.op, row.reasoning ?? null]), carriers);
            assert.deepEqual(rows.map((row) => { const first = announced.get(row.id); return [first?.op, first?.reasoning ?? null]; }), carriers,
                "each row's first announcement already carries what a read returns");
        } finally {
            unsubscribe();
        }
    });
});
