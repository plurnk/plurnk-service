// §prompt-auto-read (owner refactor): the User Prompts section is a PATHS-ONLY list at the
// system packet's bottom; the prompt's content reaches the model through a foisted auto-READ
// of its own entry — <1,12> for twelve-plus-line prompts, <1,-1> (whole) below that. Prior
// prompts stay listed and READable by address — never silently lost.

import test from "node:test";
import assert from "node:assert/strict";
import type { PrepMethod } from "../../src/core/Db.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

const mock = (): Mock => new Mock({ contextWindow: 100000, responses: [makeMockResponse("<<SEND[200]:done:SEND", 40)] });

type LogRow = { op: string; origin: string; pathname: string | null; lineMarker: string | null; rx: string | null; status_rx: number };

test("[§prompt-auto-read] a short prompt foists READ(prompt)<1,-1> — whole, the teaching form", async () => {
    await withDaemon(mock(), async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "par-short" });
            const resp = await runLoopToTerminal(ws, 2, { prompt: "three\nshort\nlines" });
            const { loopId } = resp as { loopId: number };
            const rows = await (db.test_log_entries_by_loop as PrepMethod).all<LogRow>({ loop_id: loopId });
            const autoRead = rows.find((r) => r.op === "READ" && r.origin === "plurnk" && /^\/prompt\/\d+\/1\/\d+$/.test(r.pathname ?? "")); // run-qualified loop-SEQ coordinates (§prompt-run-qualified)
            assert.ok(autoRead, "the auto-READ foisted");
            const marker = JSON.parse(autoRead!.lineMarker ?? "null") as { marks: number[] } | null;
            assert.deepEqual(marker?.marks, [1, -1], "fewer than 12 lines → whole-read <1,-1>");
            assert.match(autoRead!.rx ?? "", /three/, "the prompt body arrives through the READ");
        } finally { ws.close(); }
    });
});

test("[§prompt-auto-read] a 12+-line prompt foists READ(prompt)<1,12> and the section lists the PATH only", async () => {
    await withDaemon(mock(), async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "par-long" });
            const fat = Array.from({ length: 30 }, (_, i) => `prompt line ${i + 1}`).join("\n");
            const resp = await runLoopToTerminal(ws, 2, { prompt: fat });
            const { loopId, turnIds } = resp as { loopId: number; turnIds: number[] };
            const rows = await (db.test_log_entries_by_loop as PrepMethod).all<LogRow>({ loop_id: loopId });
            const autoRead = rows.find((r) => r.op === "READ" && r.origin === "plurnk" && /^\/prompt\/\d+\/1\/\d+$/.test(r.pathname ?? "")); // run-qualified loop-SEQ coordinates (§prompt-run-qualified)
            assert.ok(autoRead, "the auto-READ foisted");
            const marker = JSON.parse(autoRead!.lineMarker ?? "null") as { marks: number[] } | null;
            assert.deepEqual(marker?.marks, [1, 12], "twelve-plus lines → <1,12>");
            const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: turnIds[turnIds.length - 1] });
            const packet = JSON.parse(row!.packet) as { sections?: Array<{ name: string; slot: string; content: string }> };
            const promptSection = (packet.sections ?? []).find((sec) => sec.name === "prompt");
            assert.ok(promptSection, "the prompts section exists");
            assert.equal(promptSection!.slot, "system", "system slot — the very bottom of the system packet");
            assert.match(promptSection!.content, /^\* plurnk:\/\/prompt\/\d+\/1\/1$/m, "paths-only, run-qualified loop-SEQ coordinates — the first loop is <run>/1/1, never the db id (§prompt-run-qualified)");
            assert.doesNotMatch(promptSection!.content, /prompt line 5/, "no bodies in the section");
        } finally { ws.close(); }
    });
});
