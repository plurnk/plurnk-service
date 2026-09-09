// {§send-premature-terminate} {§loop-response-messages}

import assert from "node:assert/strict";
import test from "node:test";
import { hostname } from "node:os";
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

for (const command of ["true", "hostname"]) {
    test(`a successful ${command} cannot complete before the model receives its result`, async () => {
        const answer = command === "hostname" ? hostname() : "The command completed successfully.";
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [
                makeMockResponse(`\`\`\`sh\n${command}\n\`\`\`\n\`\`\`SEND\nThe hostname is plurnk-sandbox.\n\`\`\`\n\`\`\`TASK\n[{"content":"Address the prompt.","status":"completed"}]\n\`\`\``),
                makeMockResponse(`\`\`\`SEND\n${answer}\n\`\`\`\n\`\`\`TASK\n[{"content":"Address the prompt.","status":"completed"}]\n\`\`\``),
            ],
        });
        await withSettlement("3000", () => withDaemon(provider, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "stream-success-terminal" });
                const result = await runLoopToTerminal(ws, 2, { prompt: "submit, then conclude", policy: { proposals: "accept" } });
                assert.equal(result.finalStatus, 200);
                assert.equal(provider.remaining, 0, "the model gets exactly one observation turn before completing");
                assert.equal(provider.received.length, 2);
                assert.equal(result.result.content, `The hostname is plurnk-sandbox.\n\n${answer}`, "continuation cannot retract the deliberate first SEND");
                const observedPacket = JSON.stringify(provider.received[1]);
                assert.match(observedPacket, /terminal/, "the next packet contains the stream conclusion");
                if (command === "hostname") assert.ok(observedPacket.includes(hostname()), "the actual hostname reaches the model");
                const rows = await db.test_log_entries_by_worker.all<{ op: string; status_rx: number }>({ worker_id: result.modelWorkerId });
                assert.ok(rows.some((r) => r.op === "EXEC"), "the stream ran");
                assert.equal(rows.filter((r) => r.op === "TASK" && r.status_rx === 409).length, 1, "the blind completion was refused");
            } finally {
                ws.close();
            }
        }));
    });
}

test("{§send-final-strike-retrieval}: successful EXEC receipts retain the complete-rather-than-fail escape hatch", async (t) => {
    const previous = process.env.PLURNK_SERVICE_MAX_STRIKES;
    process.env.PLURNK_SERVICE_MAX_STRIKES = "3";
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_MAX_STRIKES;
        else process.env.PLURNK_SERVICE_MAX_STRIKES = previous;
    });
    const provider = new Mock({
        contextWindow: 100_000,
        responses: Array.from({ length: 4 }, () => makeMockResponse("```sh\ntrue\n```\n```SEND\nCompleted.\n```\n```TASK\n[{\"content\":\"Address the prompt.\",\"status\":\"completed\"}]\n```")),
    });
    await withSettlement("3000", () => withDaemon(provider, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "stream-final-strike" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "run the command", policy: { proposals: "accept" } });
            assert.equal(result.finalStatus, 200, "the final refusal becomes completion, not a strike-threshold failure");
            assert.equal(provider.received.length, 3);
            assert.equal(provider.remaining, 1, "the allowance requires no additional inference");
            const rows = await db.test_log_entries_by_worker.all<{ op: string; origin: string; status_rx: number }>({ worker_id: result.modelWorkerId });
            assert.deepEqual(rows.filter(({ op, origin }) => op === "TASK" && origin === "model").map(({ status_rx }) => status_rx), [409, 409, 200]);
            assert.equal(rows.filter(({ op, origin }) => op === "EXEC" && origin === "model").length, 3, "every submitted command was executed");
        } finally {
            ws.close();
        }
    }));
});

test("a failed same-turn stream still refuses DONE without echoing its command", async () => {
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse("```EXEC\nexit 3\n```\n```SEND\nconcluding blind\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```"),
            makeMockResponse("```SEND\nconcluding after reading the failure\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```"),
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
            const refused = rows.find((r) => r.op === "TASK" && r.status_rx === 409);
            assert.ok(refused, "the blind conclusion was refused 409");
            const entry = await db.test_get_log_entry_by_id.get<{ rx: string | null }>({ id: refused.id });
            const problem = (JSON.parse(entry?.rx ?? "{}") as { problem?: Record<string, unknown> }).problem;
            assert.deepEqual(problem?.pending, ["receipts", "failed-stream-results"]);
            assert.equal(problem?.detail, "Completion encountered pending work or results.");
            assert.doesNotMatch(entry?.rx ?? "", /exit 3|sh:/, "the command is already owned by the EXEC row");
        } finally {
            ws.close();
        }
    }));
});
