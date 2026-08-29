// {§send-premature-terminate} — a same-turn stream that CLOSED SUCCESSFULLY before the terminal's
// dispatch is banked, not pending: SEND[200] over it concludes in ONE turn on the stream's own
// success. A stream that closed in failure is an unseen failure: refused 409, the stream named.

import assert from "node:assert/strict";
import test from "node:test";
import { Mock } from "@plurnk/plurnk-providers";
import { connect, makeMockResponse, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";

const withSettlement = async (ms: string, fn: () => Promise<void>): Promise<void> => {
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = ms;
    try {
        await fn();
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
};

test("a successful same-turn stream does not gate SEND[200]: submit-and-conclude is one turn", async () => {
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [makeMockResponse("## EXEC0 [sh]\ntrue\n## SEND0 [200]\nsubmitted and concluding")],
    });
    await withSettlement("3000", () => withDaemon(provider, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "stream-success-terminal" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "submit, then conclude", policy: { proposals: "accept" } });
            assert.equal(result.finalStatus, 200);
            assert.equal(provider.remaining, 0, "the conclusion cost no extra provider turn");
            const rows = await db.test_log_entries_by_worker.all<{ op: string; status_rx: number }>({ worker_id: result.modelWorkerId });
            assert.ok(rows.some((r) => r.op === "EXEC"), "the stream ran");
            assert.equal(rows.filter((r) => r.op === "SEND" && r.status_rx === 409).length, 0, "no refusal was recorded");
        } finally {
            ws.close();
        }
    }));
});

test("a failed same-turn stream still refuses SEND[200] without echoing its command", async () => {
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse("## EXEC0 [sh]\nexit 3\n## SEND0 [200]\nconcluding blind"),
            makeMockResponse("## SEND0 [200]\nconcluding after reading the failure"),
        ],
    });
    await withSettlement("3000", () => withDaemon(provider, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "stream-failure-terminal" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "submit, then conclude", policy: { proposals: "accept" } });
            assert.equal(result.finalStatus, 200);
            assert.equal(provider.remaining, 0, "the refusal cost exactly one more provider turn");
            const rows = await db.test_log_entries_by_worker.all<{ id: number; op: string; status_rx: number }>({ worker_id: result.modelWorkerId });
            const refused = rows.find((r) => r.op === "SEND" && r.status_rx === 409);
            assert.ok(refused, "the blind conclusion was refused 409");
            const entry = await db.test_get_log_entry_by_id.get<{ rx: string | null }>({ id: refused.id });
            const problem = (JSON.parse(entry?.rx ?? "{}") as { problem?: Record<string, unknown> }).problem;
            assert.deepEqual(problem?.pending, ["failed-stream-results"]);
            assert.equal(problem?.detail, "Completion encountered pending work or results.");
            assert.doesNotMatch(entry?.rx ?? "", /exit 3|sh:/, "the command is already owned by the EXEC row");
        } finally {
            ws.close();
        }
    }));
});
