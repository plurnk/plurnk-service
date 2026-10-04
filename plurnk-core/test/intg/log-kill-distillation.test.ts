// {§log-kill-distillation}
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, runLoopToTerminal } from "./_rpc.ts";
import { parseLogRecords } from "../LogRecords.ts";

const logSection = (packet: string): string => {
    const parsed = JSON.parse(packet) as { sections?: Array<{ name: string; content: string }> };
    return parsed.sections?.find((s) => s.name === "log")?.content ?? packet;
};
const rows = (log: string, op: string): Array<Record<string, unknown>> =>
    parseLogRecords(log).filter(({ logPath: path }) => typeof path === "string" && path.endsWith(`/${op}`));

const distillation = "wcs.py: _array_converter returns early on empty input; the fix is its return path.";

test("{§log-kill-distillation} a log KILL's body lands as the model's own NOTE row after the kill, named by what it distilled", async () => {
    const mock = new Mock({ contextWindow: 32768, responses: [
        "````EDIT (worker:///note)\nfirst line\nsecond line\n````\n\n````READ (worker:///note)````\n````NOTE\nwrote\n````",
        `\`\`\`\`KILL (log:///1/**/{READ,NOTE}) <!-- retire the read and the note; keep what they taught -->\n${distillation}\n\`\`\`\`\n\`\`\`\`KILL (log:///1/**/EDIT)\n   \n\`\`\`\`\n\`\`\`\`NOTE\ncurated\n\`\`\`\``,
        "````NOTE\nmoving on\n````",
        "````KILL\ndone\n````",
    ].map((content) => ({ assistant: { content, reasoning: null } })) });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "log-kill-distillation" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "curate", policy: { proposals: "accept" } });
            assert.equal(result.result.status, 200);
            const ids = result.turnIds ?? [];
            assert.ok(ids.length >= 5, `init + four model turns; got ${ids.length}`);
            const afterCuration = logSection((await db.test_get_packet.get<{ packet: string }>({ id: ids[3]! }))!.packet);
            const notes = rows(afterCuration, "NOTE");
            assert.deepEqual(notes.map(({ body }) => body), [`1:${distillation}\n`, "1:curated\n"],
                "the distillation is the next packet's first NOTE; the killed NOTE and READ are gone");
            assert.equal(rows(afterCuration, "KILL").length, 0, "both kills succeeded, so neither receipt renders");
            assert.equal(rows(afterCuration, "READ").length, 0);
            const history = await db.test_log_entries_by_loop.all<{
                op: string | null; pathname: string | null; sequence: number; turn_id: number; status_rx: number; rx: string; attrs: string | null; tx: string; origin: string;
            }>({ loop_id: result.loopId });
            // Sequence 1 of a model turn is the engine's ops:// echo of the emission; the model's rows follow it.
            const curation = history.filter(({ turn_id, origin }) => turn_id === ids[2] && origin === "model");
            assert.deepEqual(curation.map(({ op, pathname, sequence, status_rx }) => ({ op, pathname, sequence, status_rx })), [
                { op: "KILL", pathname: "/1/**/{READ,NOTE}", sequence: 2, status_rx: 200 },
                { op: "NOTE", pathname: null, sequence: 3, status_rx: 200 },
                { op: "KILL", pathname: "/1/**/EDIT", sequence: 4, status_rx: 200 },
                { op: "NOTE", pathname: null, sequence: 5, status_rx: 200 },
            ], "the distillation is written at the next sequence after its kill; a whitespace body is a plain KILL; later rows follow in order");
            const [kill, note, plainKill] = curation;
            assert.equal((JSON.parse(kill!.tx) as { body: string | null }).body, distillation, "the kill's own record keeps the body it was emitted with");
            assert.deepEqual(JSON.parse(note!.attrs ?? "{}"), { distilled: "log:///1/**/{READ,NOTE}" }, "the NOTE row names the selection it distilled");
            assert.equal((JSON.parse(note!.tx) as { op: string; body: string }).body, distillation);
            assert.equal((JSON.parse(plainKill!.tx) as { body: string | null }).body, null, "whitespace is no distillation");
            const programs = await db.test_turn_sources.all<{ kind: string; turn_id: number; content: string }>({ worker_id: result.modelWorkerId! });
            assert.ok(programs.some(({ kind, turn_id, content }) => kind === "note" && turn_id === ids[2] && content === distillation),
                "the distillation is retained as a note source exactly as a NOTE's body is");
        } finally { ws.close(); }
    });
});

test("{§log-kill-distillation} a failed log KILL keeps its body out of the log: nothing was retired, so nothing is distilled", async () => {
    const mock = new Mock({ contextWindow: 32768, responses: [
        "````NOTE\nwrote\n````",
        "````KILL (log:///9/9/9)\nnothing here\n````\n````NOTE\nchecked\n````",
        "````KILL\ndone\n````",
    ].map((content) => ({ assistant: { content, reasoning: null } })) });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "log-kill-distillation-miss" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "curate", policy: { proposals: "accept" } });
            assert.equal(result.result.status, 200);
            const ids = result.turnIds ?? [];
            const history = await db.test_log_entries_by_loop.all<{ op: string | null; pathname: string | null; sequence: number; turn_id: number; status_rx: number; origin: string }>({ loop_id: result.loopId });
            assert.deepEqual(history.filter(({ turn_id, origin }) => turn_id === ids[2] && origin === "model").map(({ op, pathname, sequence, status_rx }) => ({ op, pathname, sequence, status_rx })), [
                { op: "KILL", pathname: "/9/9/9", sequence: 2, status_rx: 404 },
                { op: "NOTE", pathname: null, sequence: 3, status_rx: 200 },
            ], "the miss is the receipt; the body does not become a NOTE");
        } finally { ws.close(); }
    });
});
