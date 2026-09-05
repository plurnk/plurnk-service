import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { SchemeManifest } from "../../src/core/scheme-types.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop } from "./_helpers.ts";

const turn = (operation: string, status = "NEXT") => ({
    assistant: { content: `## PLAN0\n[]\n${operation}\n### SEND0 (${status})\nContinue.`, reasoning: null },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});

for (const identical of [false, true]) {
    test(`{§engine-cycle-evidence} six ${identical ? "identical" : "distinct"} appends execute and conclude`, async () => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `cycles-${crypto.randomUUID()}`);
            const workerId = await insertWorker(db, workspaceId);
            const loopId = await insertLoop(db, workerId, 1, "Append six lines, then conclude.");
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const lines = Array.from({ length: 6 }, (_, index) => `completed step ${identical ? "same" : index + 1}`);
            const provider = new Mock({ contextWindow: 100000, responses: [
                ...lines.map((line) => turn(`### EDIT0 (worker:///journal) <-1>\n${line}`)),
                turn("", "TERM"),
            ] });
            const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [], maxTurns: 10 });
            assert.equal(result.result.status, 200, JSON.stringify(result.result));
            const rows = await db.test_log_entries_by_worker.all<{ op: string; status_rx: number }>({ worker_id: workerId });
            assert.deepEqual(rows.filter(({ op }) => op === "EDIT").map(({ status_rx }) => status_rx), [201, 200, 200, 200, 200, 200]);
            const entry = await db.test_get_entry_by_path.get<{ id: number }>({ workspace_id: workspaceId, scheme: "worker", pathname: "/journal" });
            assert.ok(entry);
            const channel = await db.test_get_channel.get<{ content: string }>({ entry_id: entry.id, name: "body" });
            assert.equal(channel?.content.trimEnd(), lines.join("\n"));
        } finally { await db.close(); }
    });
}

class ObservedContent {
    static manifest: SchemeManifest = {
        name: "observed-content", category: "control", channels: { body: "text/plain" }, defaultChannel: "body",
        writableBy: [], volatile: true, modelVisible: true,
    };
    calls = 0;
    readonly #changing: boolean;

    constructor(changing: boolean) { this.#changing = changing; }

    async read() {
        this.calls++;
        return { status: 200, channel: "body", mimetype: "text/plain", content: `observation ${this.#changing ? this.calls : 1}` };
    }
}

for (const changing of [false, true]) {
    test(`{§engine-cycle-evidence} repeated reads with ${changing ? "changing" : "unchanged"} results`, async () => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `cycles-${crypto.randomUUID()}`);
            const workerId = await insertWorker(db, workspaceId);
            const loopId = await insertLoop(db, workerId, 1, "Observe six results.");
            const schemes = new SchemeRegistry();
            const source = new ObservedContent(changing);
            schemes.register("observed-content", source);
            const engine = new Engine({ db, schemes });
            const provider = new Mock({ contextWindow: 100000, responses: [
                ...Array.from({ length: 6 }, () => turn("### READ0 (observed-content:///latest)")),
                turn("", "TERM"),
            ] });
            const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [], maxTurns: 10 });
            assert.equal(result.result.status, changing ? 200 : 508, JSON.stringify(result.result));
            assert.equal(source.calls, changing ? 6 : 5);
            const reads = (await db.test_log_entries_by_loop.all<{ op: string; scheme: string; rx: string }>({ loop_id: loopId }))
                .filter(({ op, scheme }) => op === "READ" && scheme === "observed-content");
            assert.deepEqual(reads.map(({ rx }) => JSON.parse(rx).content),
                Array.from({ length: source.calls }, (_, index) => `observation ${changing ? index + 1 : 1}`));
            if (!changing) assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/engine/rails/strike-threshold");
        } finally { await db.close(); }
    });
}

test("{§engine-cycle-evidence} repeated misses cycle despite unique Problem occurrence addresses", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `cycles-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Read a missing resource.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 100000, responses: Array.from({ length: 7 }, () => turn("### READ0 (worker:///missing)")) });
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [], maxTurns: 10 });
        assert.equal(result.result.status, 508, JSON.stringify(result.result));
        const misses = (await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; rx: string }>({ loop_id: loopId }))
            .filter(({ op, status_rx }) => op === "READ" && status_rx === 404);
        assert.equal(misses.length, 5);
        assert.equal(new Set(misses.map(({ rx }) => JSON.parse(rx).problem.instance)).size, 5);
    } finally { await db.close(); }
});
