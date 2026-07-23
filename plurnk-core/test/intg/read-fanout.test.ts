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
import Worker from "../../src/schemes/Worker.ts";
import Log from "../../src/schemes/Log.ts";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, makeSchemeCtx } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const readStmt = (target: ParsedPath | null, body: MatcherBody | null = null): ReadStatement => ({
    op: "READ", suffix: "", signal: null, target,
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const seed = async (db: Db, workspaceId: number, workerId: number, mimetypes: Mimetypes, path: string, content: string): Promise<void> => {
    await new Worker().edit(
        { op: "EDIT", suffix: "", signal: null, target: urlPath("worker", path), lineMarker: null, body: content, position: { line: 1, column: 1 } },
        makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
    );
};

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `fanout-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "fanout");
    const turnId = await insertTurn(db, loopId, 1, 102);
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes });
    return { db, workspaceId, workerId, loopId, turnId, mimetypes, engine };
};

// Read a fanned log row's body by its turn coordinate (log:///1/1/<seq>).
const rowBody = async (db: Db, workerId: number, mimetypes: Mimetypes, seq: number): Promise<{ status: number; content: string | null; startLine?: number | null }> => {
    const r = await new Log().read(readStmt(urlPath("log", `/1/1/${seq}`)), makeSchemeCtx({ db, workerId, mimetypes }));
    return { status: r.status, content: r.content, startLine: r.startLine };
};

test("a matcher READ fans out to one row per MATCH, each at its (file, span) (#286)", async () => {
    const { db, workspaceId, workerId, loopId, turnId, mimetypes, engine } = await setup();
    try {
        // france sits on a line of a (line 2) and b (line 1); c never matches.
        await seed(db, workspaceId, workerId, mimetypes, "/a", "intro\nfrance alpha\ntail");
        await seed(db, workspaceId, workerId, mimetypes, "/b", "france beta\nmore");
        await seed(db, workspaceId, workerId, mimetypes, "/c", "italy\nspain");

        const r = await engine.dispatch({
            statement: readStmt(urlPath("worker", "/**"), { dialect: "glob", raw: "france*" } as MatcherBody),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });

        assert.equal(r.status, 200);
        assert.equal(r.rowsWritten, 3, "the FIND selection-summary row + two matches (one per file; c excluded)");
        assert.deepEqual(r.fannedStatuses, [200, 200]);

        // Each row stores its match's line RAW at its source startLine (in the rx); packet-wire
        // numbers it N: at render (#286 — no pre-numbering baked into the body). Read the stored
        // rx directly: Log.read re-resolves the body fresh and wouldn't surface the stored span.
        const rxOf = async (seq: number): Promise<{ content?: string; startLine?: number | null }> => {
            const row = await (db.log_read_by_coordinate as PrepMethod).get<{ rx: string }>({ worker_id: workerId, loop_seq: 1, turn_seq: 1, sequence: seq });
            return JSON.parse(row!.rx) as { content?: string; startLine?: number | null };
        };
        // Sequence 1 is the FIND selection-summary row (§matcher-selection-signal); deliveries follow.
        const stored = [await rxOf(2), await rxOf(3)];
        const numbered = stored.map((x) => `${x.startLine}:${x.content}`).toSorted();
        assert.deepEqual(numbered, ["1:france beta", "2:france alpha"], "each fanned row stores its match line at its source span — render numbers it");
    } finally { await db.close(); }
});

test("a glob READ with zero matches writes a single 204 row, not silence", async () => {
    const { db, workspaceId, workerId, loopId, turnId, mimetypes, engine } = await setup();
    try {
        await seed(db, workspaceId, workerId, mimetypes, "/a", "italy");
        await seed(db, workspaceId, workerId, mimetypes, "/b", "spain");
        const r = await engine.dispatch({
            statement: readStmt(urlPath("worker", "/**"), { dialect: "glob", raw: "france*" } as MatcherBody),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(r.status, 204);
        assert.equal(r.rowsWritten, 1, "no matches still mints one row the model can see");
    } finally { await db.close(); }
});

test("the running sequence counter advances past the fan-out — a later op lands after all N rows", async () => {
    const { db, workspaceId, workerId, loopId, turnId, mimetypes, engine } = await setup();
    try {
        await seed(db, workspaceId, workerId, mimetypes, "/a", "france one");
        await seed(db, workspaceId, workerId, mimetypes, "/b", "france two");
        // Dispatch the glob READ at sequence 1 → rows 1,2. A following single READ must land at 3.
        const fan = await engine.dispatch({
            statement: readStmt(urlPath("worker", "/**"), { dialect: "glob", raw: "france*" } as MatcherBody),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(fan.rowsWritten, 3, "the FIND summary + one delivery per file");
        await engine.dispatch({
            statement: readStmt(urlPath("worker", "/a")),
            workspaceId, workerId, loopId, turnId, sequence: 1 + (fan.rowsWritten as number), origin: "model",
        });
        // Row 4 (after summary + 2 deliveries) is the single-file READ of /a (its full content).
        const row3 = await rowBody(db, workerId, mimetypes, 4);
        assert.equal(row3.status, 200);
        assert.match(row3.content ?? "", /france one/);
    } finally { await db.close(); }
});
