// Multi-file READ fan-out (SPEC §matcher-result — "the companion to FIND's survey", #278).
// A glob READ target resolves to many files; READ returns ONE log row per file that matches,
// each holding that file's matching lines. One model command, N log rows — each addressing
// its concrete file (foldable/killable/re-READable on its own).

import test from "node:test";
import assert from "node:assert/strict";
import type { MatcherBody, ParsedPath, ReadStatement, UrlPath } from "@plurnk/plurnk-grammar";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Known from "../../src/schemes/Known.ts";
import Log from "../../src/schemes/Log.ts";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, makeSchemeCtx } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const readStmt = (target: ParsedPath | null, body: MatcherBody | null = null): ReadStatement => ({
    op: "READ", suffix: "", signal: null, target,
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const seed = async (db: Db, sessionId: number, runId: number, mimetypes: Mimetypes, path: string, content: string): Promise<void> => {
    await new Known().edit(
        { op: "EDIT", suffix: "", signal: null, target: urlPath("known", path), lineMarker: null, body: content, position: { line: 1, column: 1 } },
        makeSchemeCtx({ db, sessionId, runId, mimetypes }),
    );
};

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `fanout-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1, "fanout");
    const turnId = await insertTurn(db, loopId, 1, 102);
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes });
    return { db, sessionId, runId, loopId, turnId, mimetypes, engine };
};

// Read a fanned log row's body by its turn coordinate (log:///1/1/<seq>).
const rowBody = async (db: Db, runId: number, mimetypes: Mimetypes, seq: number): Promise<{ status: number; content: string | null; startLine?: number | null }> => {
    const r = await new Log().read(readStmt(urlPath("log", `/1/1/${seq}`)), makeSchemeCtx({ db, runId, mimetypes }));
    return { status: r.status, content: r.content, startLine: r.startLine };
};

test("[§read-multi-file-fanout] a matcher READ fans out to one row per MATCH, each at its (file, span) (#286)", async () => {
    const { db, sessionId, runId, loopId, turnId, mimetypes, engine } = await setup();
    try {
        // france sits on a line of a (line 2) and b (line 1); c never matches.
        await seed(db, sessionId, runId, mimetypes, "/a", "intro\nfrance alpha\ntail");
        await seed(db, sessionId, runId, mimetypes, "/b", "france beta\nmore");
        await seed(db, sessionId, runId, mimetypes, "/c", "italy\nspain");

        const r = await engine.dispatch({
            statement: readStmt(urlPath("known", "/**"), { dialect: "glob", raw: "france*" } as MatcherBody),
            sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
        });

        assert.equal(r.status, 200);
        assert.equal(r.rowsWritten, 2, "two matches (one per file) → two log rows (c excluded)");
        assert.deepEqual(r.fannedStatuses, [200, 200]);

        // Each row stores its match's line RAW at its source startLine (in the rx); packet-wire
        // numbers it N:\t at render (#286 — no pre-numbering baked into the body). Read the stored
        // rx directly: Log.read re-resolves the body fresh and wouldn't surface the stored span.
        const rxOf = async (seq: number): Promise<{ content?: string; startLine?: number | null }> => {
            const row = await (db.log_read_by_coordinate as PrepMethod).get<{ rx: string }>({ run_id: runId, loop_seq: 1, turn_seq: 1, sequence: seq });
            return JSON.parse(row!.rx) as { content?: string; startLine?: number | null };
        };
        const stored = [await rxOf(1), await rxOf(2)];
        const numbered = stored.map((x) => `${x.startLine}:\t${x.content}`).toSorted();
        assert.deepEqual(numbered, ["1:\tfrance beta", "2:\tfrance alpha"], "each fanned row stores its match line at its source span — render numbers it");
    } finally { await db.close(); }
});

test("a glob READ with zero matches writes a single 204 row, not silence", async () => {
    const { db, sessionId, runId, loopId, turnId, mimetypes, engine } = await setup();
    try {
        await seed(db, sessionId, runId, mimetypes, "/a", "italy");
        await seed(db, sessionId, runId, mimetypes, "/b", "spain");
        const r = await engine.dispatch({
            statement: readStmt(urlPath("known", "/**"), { dialect: "glob", raw: "france*" } as MatcherBody),
            sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(r.status, 204);
        assert.equal(r.rowsWritten, 1, "no matches still mints one row the model can see");
    } finally { await db.close(); }
});

test("the running sequence counter advances past the fan-out — a later op lands after all N rows", async () => {
    const { db, sessionId, runId, loopId, turnId, mimetypes, engine } = await setup();
    try {
        await seed(db, sessionId, runId, mimetypes, "/a", "france one");
        await seed(db, sessionId, runId, mimetypes, "/b", "france two");
        // Dispatch the glob READ at sequence 1 → rows 1,2. A following single READ must land at 3.
        const fan = await engine.dispatch({
            statement: readStmt(urlPath("known", "/**"), { dialect: "glob", raw: "france*" } as MatcherBody),
            sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(fan.rowsWritten, 2);
        await engine.dispatch({
            statement: readStmt(urlPath("known", "/a")),
            sessionId, runId, loopId, turnId, sequence: 1 + (fan.rowsWritten as number), origin: "model",
        });
        // Row 3 exists and is the single-file READ of /a (its full content).
        const row3 = await rowBody(db, runId, mimetypes, 3);
        assert.equal(row3.status, 200);
        assert.match(row3.content ?? "", /france one/);
    } finally { await db.close(); }
});
