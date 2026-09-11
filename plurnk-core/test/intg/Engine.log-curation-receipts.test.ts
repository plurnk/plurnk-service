// {§log-kill-meta-operation}
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
    parseLogRecords(log).filter(({ path }) => typeof path === "string" && path.endsWith(`/${op}`));
const row = (log: string, op: string): Record<string, unknown> | undefined => rows(log, op)[0];

test("{§log-kill-meta-operation} successful log KILL receipts never render; errors, resource KILLs, and forensic evidence remain", async () => {
    const mock = new Mock({ contextWindow: 32768, responses: [
        "```EDIT (worker:///note)\nfirst line\nsecond line\n```\n\n```READ (worker:///note)```\n```TASK\n[{\"content\":\"wrote\",\"status\":\"in_progress\"}]\n```",
        "```KILL (log:///1/**/READ) <2,-1>```\n```KILL (log:///1/**/EDIT)```\n```KILL (log:///9/9/9)```\n```TASK\n[{\"content\":\"curated\",\"status\":\"in_progress\"}]\n```",
        "```KILL (log:///1/**/EDIT)```\n```READ (log:///1/3/1/KILL)```\n```READ (worker:///note)```\n```KILL (worker:///note)```\n```TASK\n[{\"content\":\"verified\",\"status\":\"in_progress\"}]\n```",
        "```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```",
    ].map((content) => ({ assistant: { content, reasoning: null } })) });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "log-curation-receipts" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "curate", policy: { proposals: "accept" } });
            assert.equal(result.result.status, 200);
            const ids = result.turnIds ?? [];
            assert.ok(ids.length >= 5, `init + four model turns; got ${ids.length}`);
            const packetOf = async (index: number) => logSection((await db.test_get_packet.get<{ packet: string }>({ id: ids[index]! }))!.packet);
            const afterCuration = await packetOf(3);
            const kills = rows(afterCuration, "KILL");
            assert.deepEqual(kills.map(({ target, status }) => ({ target, status })), [
                { target: "log:///9/9/9", status: 404 },
            ], "the first packet after curation contains the failed KILL, not successful receipts");
            assert.ok(kills[0].problem, "the failed KILL retains its corrective Problem");
            assert.equal(row(afterCuration, "EDIT"), undefined, "the killed EDIT row is retired from the projection");
            const trimmed = rows(afterCuration, "READ").find(({ target }) => target === "worker:///note");
            assert.match(String(trimmed?.body), /first line/u, "scoped curation retains the untrimmed line");
            assert.doesNotMatch(String(trimmed?.body), /second line/u, "scoped curation removes the requested line");
            const afterRepeat = await packetOf(4);
            assert.deepEqual(rows(afterRepeat, "KILL").map(({ target, status }) => ({ target, status })), [
                { target: "log:///9/9/9", status: 404 },
                { target: "worker:///note", status: 200 },
            ], "the no-op receipt is also suppressed; the error and resource deletion stay visible");
            assert.ok(rows(afterRepeat, "READ").some(({ target }) => target === "log:///1/3/1/KILL"), "explicit READ of a suppressed receipt remains an ordinary visible operation");
            const history = await db.test_log_entries_by_loop.all<{
                op: string | null; pathname: string | null; scheme: string | null;
                status_rx: number; rx: string; active: number;
            }>({ loop_id: result.loopId });
            const recordedKills = history.filter(({ op }) => op === "KILL");
            assert.deepEqual(recordedKills.map(({ status_rx }) => status_rx), [200, 200, 404, 204, 200]);
            assert.ok(recordedKills.every(({ active }) => active === 1), "packet suppression does not retire or delete receipt history");
            assert.equal(JSON.parse(recordedKills[0].rx).matched, 2, "the broad sweep includes initialization's program READ and the file READ");
            const sourceReads = history.filter(({ op, scheme, pathname }) => op === "READ" && scheme === "worker" && pathname === "/note");
            assert.equal(sourceReads.length, 2);
            for (const read of sourceReads) {
                assert.equal(JSON.parse(read.rx).content, "first line\nsecond line", "log curation changes neither the original receipt evidence nor its source");
            }
            const receiptRead = history.find(({ op, scheme, pathname }) => op === "READ" && scheme === "log" && pathname === "/1/3/1/KILL");
            assert.ok(receiptRead);
            assert.equal(receiptRead.status_rx, 204, "the suppressed receipt remains addressable with its ordinary empty body, not a missing-entry error");
            assert.equal(JSON.parse(receiptRead.rx).content, "");
            assert.equal(history.filter(({ op }) => op === null).length, 0, "source retention does not add log rows");
            const programs = await db.test_turn_sources.all<{ kind: string }>({ worker_id: result.modelWorkerId! });
            assert.equal(programs.filter(({ kind }) => kind === "ops").length, 5, "initialization and every model program remain recorded");
        } finally { ws.close(); }
    });
});
