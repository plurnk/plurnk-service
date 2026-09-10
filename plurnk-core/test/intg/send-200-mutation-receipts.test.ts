// {§send-premature-terminate}: a successful same-turn mutation's receipt lands in the next packet,
// so completion over it is refused 409 — the model sees what it changed before it claims done.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, flush } from "./_rpc.ts";

for (const specimen of [
    { label: "EDIT", extra: "", names: "EDIT" },
    {
        label: "EDIT and repeated READ, followed by log curation and SEND",
        extra: "```READ (worker:///notes.md)```\n\n```READ (worker:///notes.md)```\n\n```KILL (log:///**/EDIT)```\n\n",
        names: "EDIT, READ",
    },
]) {
    test(`{§send-premature-terminate}: ${specimen.label} names only the actual observation blockers`, async () => {
        const mock = new Mock({ contextWindow: 16384, responses: [
            makeMockResponse(`\n\`\`\`EDIT (worker:///notes.md)\nhello\n\`\`\`\n\n${specimen.extra}\`\`\`SEND\ndone\n\`\`\`\n\`\`\`TASK\n[{"content":"Task completed.","status":"completed"}]\n\`\`\``, 10),
            makeMockResponse("\n```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 10),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "mutation-gate" });
                const { finalStatus, turnIds = [], loopId } = await runLoopToTerminal(ws, 2, { prompt: "go", policy: { proposals: "accept" } });
                assert.equal(finalStatus, 200, "the loop concluded on the SECOND turn, the edit observed");
                assert.equal(turnIds.length, 3, "initialization plus two model turns — the refusal forced one observation turn, no more");
                await flush();
                const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: loopId });
                const tasks = rows.filter((r) => r.op === "TASK" && r.origin === "model");
                assert.equal(tasks[0]?.status_rx, 409, "the first completion was refused over the unseen receipt");
                const problem = JSON.parse(tasks[0]?.rx ?? "{}") as { problem?: { detail?: string; pending?: string[]; recovery?: string } };
                assert.equal(problem.problem?.detail, `Completion preceded results: ${specimen.names}. Continuing to the next packet.`);
                assert.deepEqual(problem.problem?.pending, ["receipts"]);
                assert.equal(problem.problem?.recovery, undefined, "the receipt boundary needs no guessed workflow prescription");
                assert.equal(tasks[1]?.status_rx, 200);
            } finally { ws.close(); }
        });
    });
}
