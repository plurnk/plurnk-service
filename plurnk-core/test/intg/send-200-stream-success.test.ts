// {§send-premature-terminate} {§loop-response-messages}

import assert from "node:assert/strict";
import test from "node:test";
import { hostname } from "node:os";
import { Mock } from "@plurnk/plurnk-providers";
import { connect, makeMockResponse, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";
import { isExecutionOp } from "@plurnk/plurnk-contracts";

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
    for (const hasTask of [false, true]) test(`a successful ${command} settles before the next packet, TASK=${hasTask ? "completed" : "omitted"}`, async () => {
        const answer = command === "hostname" ? hostname() : "The command completed successfully.";
        const inventory = hasTask ? "\n```TASK\n[{\"content\":\"Address the prompt.\",\"status\":\"completed\"}]\n```" : "";
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [
                makeMockResponse(`\`\`\`sh\n${command}\n\`\`\`\n\`\`\`SEND\nThe hostname is plurnk-sandbox.\n\`\`\`${inventory}`),
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
                assert.equal(result.result.content, answer, "the corrected answer is the response; the blind first SEND stays a log row");
                const observedPacket = JSON.stringify(provider.received[1]);
                assert.match(observedPacket, /terminal/, "the next packet contains the stream conclusion");
                if (command === "hostname") assert.ok(observedPacket.includes(hostname()), "the actual hostname reaches the model");
                const rows = await db.test_log_entries_by_worker.all<{ op: string; origin: string; status_rx: number }>({ worker_id: result.modelWorkerId });
                assert.ok(rows.some((r) => isExecutionOp(r.op)), "the stream ran");
                assert.equal(rows.filter((r) => r.op === "SEND" && r.origin === "model" && r.status_rx === 200).length, 2, "both messages were delivered");
                assert.equal(rows.filter((r) => r.op === "TASK" && r.origin === "model" && r.status_rx === 102).length, hasTask ? 1 : 0,
                    "an explicit blind completion is deferred; omission continues silently");
            } finally {
                ws.close();
            }
        }));
    });
}

test("{§completion-defers-to-results}: a successful execution receipt defers completion one packet without a strike", async (t) => {
    const previous = process.env.PLURNK_SERVICE_MAX_STRIKES;
    process.env.PLURNK_SERVICE_MAX_STRIKES = "1";
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_MAX_STRIKES;
        else process.env.PLURNK_SERVICE_MAX_STRIKES = previous;
    });
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse("```sh\ntrue\n```\n```SEND\nCompleted.\n```\n```TASK\n[{\"content\":\"Address the prompt.\",\"status\":\"completed\"}]\n```"),
            makeMockResponse("```SEND\nCompleted.\n```\n```TASK\n[{\"content\":\"Address the prompt.\",\"status\":\"completed\"}]\n```"),
        ],
    });
    await withSettlement("3000", () => withDaemon(provider, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "stream-final-strike" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "run the command", policy: { proposals: "accept" } });
            assert.equal(result.finalStatus, 200, "the deferred completion concludes on the next packet; at MAX_STRIKES 1 a strike would have ended the loop");
            assert.equal(provider.received.length, 2);
            assert.equal(provider.remaining, 0);
            const rows = await db.test_log_entries_by_worker.all<{ op: string; origin: string; status_rx: number }>({ worker_id: result.modelWorkerId });
            assert.deepEqual(rows.filter(({ op, origin }) => op === "TASK" && origin === "model").map(({ status_rx }) => status_rx), [102, 200]);
            assert.equal(rows.filter(({ op, origin }) => isExecutionOp(op) && origin === "model").length, 1, "the submitted command was executed");
        } finally {
            ws.close();
        }
    }));
});

test("{§completion-defers-to-results}: a failed same-turn stream defers completion without echoing its command", async () => {
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse("```sh\nexit 3\n```\n```SEND\nconcluding blind\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```"),
            makeMockResponse("```SEND\nconcluding after reading the failure\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```"),
        ],
    });
    await withSettlement("3000", () => withDaemon(provider, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "stream-failure-terminal" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "submit, then conclude", policy: { proposals: "accept" } });
            assert.equal(result.finalStatus, 200);
            assert.equal(provider.remaining, 0, "the deferral cost exactly one more provider turn");
            const rows = await db.test_log_entries_by_worker.all<{ id: number; op: string; origin: string; status_rx: number }>({ worker_id: result.modelWorkerId });
            const deferred = rows.find((r) => r.op === "TASK" && r.origin === "model" && r.status_rx === 102);
            assert.ok(deferred, "the blind conclusion was deferred");
            const entry = await db.test_get_log_entry_by_id.get<{ rx: string | null }>({ id: deferred.id });
            const deferral = JSON.parse(entry?.rx ?? "{}") as { problem?: unknown; detail?: string; attrs?: { pending?: string[] } };
            assert.equal(deferral.problem, undefined, "a deferral carries no Problem and no strike");
            assert.deepEqual(deferral.attrs?.pending, ["receipts", "failed-stream-results"]);
            assert.equal(deferral.detail, "Completion deferred until a failed execution result and operation receipts reached a packet. They are in this packet. If your final response has already been sent and these results require no further work or response revision, submit only TASK.");
            assert.doesNotMatch(entry?.rx ?? "", /exit 3|sh:/, "the command is already owned by the execution row");
        } finally {
            ws.close();
        }
    }));
});
