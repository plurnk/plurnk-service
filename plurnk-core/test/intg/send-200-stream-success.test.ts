import { lastReply } from "./_helpers.ts";
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
    for (const earlyReply of [false, true]) test(`a successful ${command} reaches the next packet, early reply=${earlyReply}`, async () => {
        const answer = command === "hostname" ? hostname() : "The command completed successfully.";
        const reply = earlyReply ? "\n````SEND\nThe hostname is plurnk-sandbox.\n````" : "";
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [
                makeMockResponse(`\`\`\`\`sh\n${command}\n\`\`\`\`${reply}`),
                makeMockResponse(`\`\`\`\`SEND\n${answer}\n\`\`\`\``),
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
                assert.equal(result.result.content, undefined);
        assert.equal(await lastReply(db, result.loopId), answer, "the corrected answer is the response; the blind first SEND stays a log row");
                const observedPacket = JSON.stringify(provider.received[1]);
                assert.match(observedPacket, /terminal/, "the next packet contains the stream conclusion");
                if (command === "hostname") assert.ok(observedPacket.includes(hostname()), "the actual hostname reaches the model");
                const rows = await db.test_log_entries_by_worker.all<{ op: string; origin: string; status_rx: number }>({ worker_id: result.modelWorkerId });
                assert.ok(rows.some((r) => isExecutionOp(r.op)), "the stream ran");
                assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op }) => op),
                    ["sh", ...(earlyReply ? ["SEND"] : []), "SEND"], "no synthetic completion operation");
                assert.equal(rows.filter((r) => r.op === "SEND" && r.origin === "model" && r.status_rx === 200).length,
                    earlyReply ? 2 : 1, "only the authored replies were delivered");
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
            makeMockResponse("````sh\ntrue\n````\n````SEND\nCompleted.\n````"),
            makeMockResponse("````NOTE\nThe observed command succeeded; the delivered answer remains correct.\n````"),
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
            assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op }) => op), ["sh", "SEND", "NOTE"]);
            assert.equal(result.result.content, undefined);
        assert.equal(await lastReply(db, result.loopId), "Completed.", "observation alone can complete an answered assignment without repeating the answer");
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
            makeMockResponse("````sh\nexit 3\n````\n````SEND\nconcluding blind\n````"),
            makeMockResponse("````SEND\nconcluding after reading the failure\n````"),
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
            assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op }) => op), ["sh", "SEND", "SEND"]);
            assert.ok(rows.some(({ op, status_rx }) => op === "READ" && status_rx === 500), "the terminal stream observation retains its failure");
            assert.match(JSON.stringify(provider.received[1]), /exit 3/, "the failed execution reaches the observation packet");
            assert.equal(result.result.content, undefined);
        assert.equal(await lastReply(db, result.loopId), "concluding after reading the failure");
            assert.ok(rows.filter(({ origin, op }) => origin === "model" && op === "SEND").every(({ status_rx }) => status_rx === 200),
                "both replies succeeded independently of the failed execution");
        } finally {
            ws.close();
        }
    }));
});
