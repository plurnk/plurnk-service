// §exec-entry-sink (#340) — the executor's entry() materialization request: the consumer creates
// the entry (upsert, tags UNIONED), and the AMBIENCE announces it — one EDIT row in the reserved
// plurnk run's log (the fs-fiction pattern) that env-delta folds into every run's next packet.
// A stub runtime drives the REAL dispatch path; nothing is mocked below the executor.

import test from "node:test";
import assert from "node:assert/strict";
import type { ExecStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, testExecutors, DEFAULT_MIMETYPES } from "./_helpers.ts";

const execStmt = (runtime: string, body: string): ExecStatement => ({
    op: "EXEC", suffix: "", signal: runtime, target: null,
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const wire = async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    engine.setExecutors(await testExecutors());
    schemes.registerRuntimeSchemes(await testExecutors());
    // The stub runtime: fetches nothing — materializes two "pages" through the sink, one of
    // which fails (pruned executor-side), then returns clean. Effect 'pure' so no proposal gate.
    engine.hotloadRuntime("stubsearch", {
        executor: {
            runtime: "stubsearch",
            glyph: "?",
            get manifest() { return { name: "stubsearch", protocol: "stubsearch:", channels: {}, defaultChannel: "results", category: "action", scope: "run", writableBy: ["model"], volatile: true, modelVisible: true } as never; },
            get defaultChannel() { return "results"; },
            get channels() { return {}; },
            effect: () => "pure" as const,
            probe: async () => ({ available: true as const, detail: undefined }),
            run: async (args) => {
                await args.entry?.("https://example.org/turkeys", "wild turkeys are large birds", { tags: ["turkeys_query"], mimetype: "text/html" });
                await args.entry?.("https://example.org/turkeys", "wild turkeys are large birds, revised", { tags: ["second_query"], mimetype: "text/html" });
                let pruned = false;
                try { await args.entry?.("not a url at all", "junk", { tags: ["x"], mimetype: "text/html" }); } catch { pruned = true; }
                args.write("results", JSON.stringify([{ title: "Turkeys", url: "https://example.org/turkeys", pruned }]), "application/json");
                args.setState("results", "closed");
                return { status: 200, exitCode: 0 };
            },
        },
        glyph: "?", example: "", documentation: "", available: true, detail: undefined,
    });
    const sessionId = await insertSession(db, `sink-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1, "sink test");
    const turnId = await insertTurn(db, loopId, 1, 102);
    return { db, engine, sessionId, runId, loopId, turnId };
};

test("[§exec-entry-sink] entry() materializes a tagged https entry (upsert UNIONS tags) and the plurnk run narrates it", async () => {
    const { db, engine, sessionId, runId, loopId, turnId } = await wire();
    try {
        const result = await engine.dispatch({
            statement: execStmt("stubsearch", "turkeys"),
            sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.ok(result.status < 400, `the stub spawn resolved; got ${result.status}`);
        // The spawn streams — run() completes in the background. Await the SECOND narration row
        // (the last substrate write) before asserting anything.
        const plurnkRunEarly = async () => (await (db.envelope_get_run_by_name as PrepMethod).get<{ id: number }>({ session_id: sessionId, name: "plurnk" }));
        for (let i = 0; i < 100; i++) {
            const r = await plurnkRunEarly();
            if (r !== undefined) {
                const n = await (db.test_log_entries_by_run_op as PrepMethod).all<{ pathname: string }>({ run_id: r.id, op: "EDIT" });
                if (n.filter((x) => x.pathname === "/example.org/turkeys").length >= 2) break;
            }
            await new Promise((res) => setTimeout(res, 50));
        }
        // The entry exists, with the SECOND write's content and BOTH tags (union, not replace).
        const entry = await (db.test_entries_by_pathname as PrepMethod).get<{ id: number; scheme: string }>({ pathname: "/example.org/turkeys" });
        assert.ok(entry !== undefined, "the https entry materialized (authority folded into the pathname)");
        assert.equal(entry.scheme, "https");
        const tags = await (db.crud_read_tags as PrepMethod).all<{ tag: string }>({ entry_id: entry.id });
        assert.deepEqual(tags.map((t) => t.tag).sort(), ["second_query", "turkeys_query"], "the upsert UNIONED the slug tags across both writes");
        // The ambience: the reserved plurnk run carries ONE narration row per write (2 here), the
        // fs-fiction shape — origin plurnk, source = the calling run, tokens on the meta line.
        const plurnkRun = await (db.envelope_get_run_by_name as PrepMethod).get<{ id: number }>({ session_id: sessionId, name: "plurnk" });
        assert.ok(plurnkRun !== undefined, "the reserved plurnk run exists");
        const rows = await (db.test_log_entries_by_run_op as PrepMethod).all<{ pathname: string; source: string; tokens: number; attrs: string }>({ run_id: plurnkRun.id, op: "EDIT" });
        const narrations = rows.filter((r) => r.pathname === "/example.org/turkeys");
        assert.equal(narrations.length, 2, "one narration row per entry() write");
        assert.equal(narrations[0]?.source, String(runId), "source attributes the CALLING run");
        assert.ok((narrations[0]?.tokens ?? 0) > 0, "the row carries tokens — the folded meta line shows size without a byte of body");
        assert.ok(/turkeys_query/.test(narrations[0]?.attrs ?? ""), "attrs carry the slug tags for the meta line");
    } finally { await db.close(); }
});
