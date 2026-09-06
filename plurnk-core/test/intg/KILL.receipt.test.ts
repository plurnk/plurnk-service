import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parsePath } from "@plurnk/plurnk-contracts";
import { chatMessageText, Mock } from "@plurnk/plurnk-providers";
import { parseLogRecords } from "../LogRecords.ts";
import { connect, makeMockResponse, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";

const source = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");

for (const scheme of ["file", "worker"]) for (const anchored of [false, true]) {
    test(`{§kill-scope-entry}: ${scheme} ${anchored ? "anchored" : "numeric"} deletion exposes its existing receipt through packet and log READ`, async () => {
        const root = await mkdtemp(join(tmpdir(), "plurnk-kill-receipt-"));
        const target = `${scheme}:///notes.md`;
        try {
            const mock = new Mock({ contextWindow: 32768, responses: [
                makeMockResponse(`### EDIT0 (${target})\n${source}\n### SEND0 (NEXT)`, 10),
                makeMockResponse(`### READ0 (${target}) <1,-1>\n### SEND0 (NEXT)`, 10),
                makeMockResponse("### SEND0 (NEXT)\ncontinue", 10),
                makeMockResponse("### SEND0 (TERM)\ndone", 10),
            ] });
            await withDaemon(mock, async (db, daemon, addr) => {
                const generate = mock.generate.bind(mock);
                let calls = 0;
                mock.generate = async (args) => {
                    if (++calls === 3) {
                        const packet = args.messages.map(chatMessageText).join("\n");
                        const start = packet.match(/^(@[A-Za-z0-9]{5}) +10:line 10$/m)?.[1];
                        const end = packet.match(/^(@[A-Za-z0-9]{5}) +11:line 11$/m)?.[1];
                        assert.ok(start && end, "the preceding READ published the coordinates used by KILL");
                        const scope = anchored ? `${start},${end}` : "10,11";
                        return new Mock({ contextWindow: 32768, responses: [makeMockResponse(`### KILL0 (${target}) <${scope}>\n### SEND0 (NEXT)`, 10)] }).generate(args);
                    }
                    return generate(args);
                };
                const ws = await connect(addr);
                try {
                    const created = await rpcCall(ws, 1, "workspace.create", { name: "kill-receipt", projectRoot: root });
                    const workspaceId = (created.result as { id: number }).id;
                    const run = await runLoopToTerminal(ws, 2, { prompt: "delete two lines", policy: { proposals: "accept" } });
                    assert.equal(run.finalStatus, 200);
                    const rows = await db.engine_render_log.all<{ id: number; op: string; origin: string; source: number | null; rx: string; weight: number }>({ worker_id: run.modelWorkerId! });
                    const kill = rows.find(({ op, origin, source }) => op === "KILL" && origin === "model" && source === null);
                    assert.ok(kill, "a later turn does not dissolve an entry mutation receipt");
                    const rx = JSON.parse(kill.rx);
                    assert.equal(rx.status, 200, JSON.stringify(rx));
                    assert.equal(rx.receipt.effect.removedText, "line 10\nline 11");
                    const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: run.turnIds!.at(-1)! }))!.packet);
                    const log = (packet.sections as Array<{ name: string; content: string }>).find(({ name }) => name === "log")!.content;
                    const receipt = parseLogRecords(log).find((row) => String(row.path).endsWith("/KILL"));
                    assert.ok(receipt, "the packet retains the KILL identity");
                    assert.equal(receipt.target, scheme === "file" ? "notes.md" : target);
                    assert.equal(receipt.extent, "lines 20->18");
                    assert.equal(receipt.change, "-2 +0");
                    assert.equal(receipt.removed, "line 10\nline 11");
                    assert.equal(receipt.range, `${rx.receipt.effect.requested} ${rx.receipt.effect.source}->${rx.receipt.effect.result}`);
                    assert.equal(receipt.body, `${rx.receipt.effect.context}\n`);
                    assert.equal(receipt.chunk, undefined, "bounded mutation context is not previewed again");
                    assert.ok(kill.weight > 0, "canonical receipt content participates in body accounting");
                    assert.ok(Number(receipt.tokensBody) > 0, "packet accounting includes the visible receipt body");
                    const recalled = await daemon.engine.look({
                        workspaceId, workerId: run.modelWorkerId!, loopId: run.loopId,
                        statement: { op: "READ", delimiter: "0", annotation: null, metadata: null, target: parsePath(String(receipt.path)), lineMarker: { marks: [1, -1] }, body: null, position: { line: 1, column: 0 } },
                    });
                    assert.equal(recalled.status, 200);
                    assert.equal(recalled.content, rx.receipt.effect.context, "log READ and packet share one canonical receipt body");
                } finally { ws.close(); }
            });
        } finally { await rm(root, { recursive: true, force: true }); }
    });
}

test("whole-entry KILL has a bodyless result, not an invented text mutation receipt", async () => {
    const mock = new Mock({ contextWindow: 32768, responses: [
        makeMockResponse("### EDIT0 (worker:///doomed)\ncontent\n### SEND0 (NEXT)", 10),
        makeMockResponse("### KILL0 (worker:///doomed)\n### SEND0 (NEXT)", 10),
        makeMockResponse("### SEND0 (TERM)\ndone", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "whole-kill" });
            const run = await runLoopToTerminal(ws, 2, { prompt: "remove the entry", policy: { proposals: "accept" } });
            assert.equal(run.finalStatus, 200);
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: run.turnIds!.at(-1)! }))!.packet);
            const log = (packet.sections as Array<{ name: string; content: string }>).find(({ name }) => name === "log")!.content;
            const receipt = parseLogRecords(log).find((row) => String(row.path).endsWith("/KILL"));
            assert.ok(receipt);
            assert.equal(receipt.status, 200);
            assert.equal(receipt.target, "worker:///doomed");
            for (const field of ["body", "extent", "change", "removed", "range", "tokensBody"]) {
                assert.equal(receipt[field], undefined, `whole-entry deletion has no ${field}`);
            }
        } finally { ws.close(); }
    });
});
