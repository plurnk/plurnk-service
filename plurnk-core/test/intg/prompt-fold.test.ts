// User Note 6 / §prompt-fold — the foisted prompt EDIT (prompt:///<loop>/<seq>, owner-keyed)
// duplicates packet.user.prompt, so its LOG ROW is folded by default (expanded=0):
// kept for forensics, collapsed in the model's log, re-OPENable. A normal model op in
// the SAME turn stays open — that control distinguishes this targeted fold from the
// grinder's uniform prior-turn fold (which would collapse the SEND too).

import test from "node:test";
import { viableWindow } from "./_helpers.ts";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

type LogRow = { op: string; pathname: string; scheme: string; expanded: number; turn_id: number };
const mock = () => new Mock({ contextWindow: viableWindow(), responses: [makeMockResponse("<<SEND[200]:done:SEND", 50)] });

test("[§prompt-fold] the foisted prompt EDIT log row is folded by default; a normal op in the same turn stays open", async () => {
    await withDaemon(mock(), async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "prompt-fold" });
            const resp = await runLoopToTerminal(ws, 2, { prompt: "hello there" });
            const { loopId } = resp as { loopId: number };
            const rows = await (db.test_log_entries_by_loop as PrepMethod).all<LogRow>({ loop_id: loopId });
            const prompt = rows.find((r) => r.op === "EDIT" && r.scheme === "prompt");
            assert.ok(prompt !== undefined, "the prompt EDIT is logged (forensics)");
            assert.equal(prompt!.expanded, 0, "the prompt EDIT log row is FOLDed by default — its body lives in packet.user.prompt");
            const send = rows.find((r) => r.op === "SEND" && r.turn_id === prompt!.turn_id);
            assert.ok(send !== undefined, "the model's own op shares the turn");
            assert.equal(send!.expanded, 1, "a normal op in the same turn stays OPEN — only the prompt foist is folded, not a grinder sweep");
        } finally { ws.close(); }
    });
});
