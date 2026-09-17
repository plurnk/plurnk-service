// {§completion-defers-to-results}: a successful same-turn mutation's receipt lands in the next
// packet, so completion over it defers one packet — the model sees what it changed before it
// claims done, and pays no strike for the engine's own delivery order.
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
    test(`{§completion-defers-to-results}: ${specimen.label} names only the actual observation blockers`, async () => {
        const mock = new Mock({ contextWindow: 16384, responses: [
            makeMockResponse(`\n\`\`\`EDIT (worker:///notes.md)\nhello\n\`\`\`\n\n${specimen.extra}\`\`\`SEND
done
\`\`\`
\`\`\`DONE
\`\`\``, 10),
            makeMockResponse("\n```SEND\ndone\n```\n```DONE\n```", 10),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "mutation-gate" });
                const { finalStatus, turnIds = [], loopId } = await runLoopToTerminal(ws, 2, { prompt: "go", policy: { proposals: "accept" } });
                assert.equal(finalStatus, 200, "the loop concluded on the SECOND turn, the edit observed");
                assert.equal(turnIds.length, 3, "initialization plus two model turns — the deferral cost one observation turn, no more");
                await flush();
                const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: loopId });
                const tasks = rows.filter((r) => ["WAIT", "DONE", "FAIL"].includes(r.op ?? "") && r.origin === "model");
                assert.equal(tasks[0]?.status_rx, 102, "the first completion was deferred over the unseen receipt");
                const deferral = JSON.parse(tasks[0]?.rx ?? "{}") as { problem?: unknown; detail?: string; attrs?: { pending?: string[] }; recovery?: unknown };
                assert.equal(deferral.detail, `Completion deferred until ${specimen.names} reached a packet. ${specimen.names.includes(",") ? "They are" : "It is"} in this packet. If your final response has already been sent and these results require no further work or response revision, submit only DONE without repeating the response.`);
                assert.deepEqual(deferral.attrs?.pending, ["receipts"]);
                assert.equal(deferral.problem, undefined, "a deferral carries no Problem and no strike");
                assert.equal(deferral.recovery, undefined, "the receipt boundary needs no guessed workflow prescription");
                assert.equal(tasks[1]?.status_rx, 200);
            } finally { ws.close(); }
        });
    });
}
