import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import type { PlurnkStatement, SendStatement } from "@plurnk/plurnk-grammar";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, DEFAULT_MIMETYPES } from "./_helpers.ts";

const sendStmt = (status: number, body: string): SendStatement => ({
    op: "SEND", suffix: "", signal: status, target: null,
    lineMarker: null, body: { raw: body, json: null }, position: { line: 1, column: 1 },
});
const response = (ops: PlurnkStatement[]): MockResponse => ({
    assistant: { content: "", ops, reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 } },
});

type IndexEntry = { pathname: string; channels: Record<string, { content: string; mimetype: string }> };
// The manifest is a normal indexed entry — found by path like any other. Its
// index tile carries the application/json handler's PREVIEW (not raw JSON), so
// tests read the full catalog from the stored body (what READ returns), below.
const manifestTile = (packetJson: string): IndexEntry | undefined => {
    const packet = JSON.parse(packetJson) as { system: { index: IndexEntry[] } };
    return packet.system.index.find((e) => e.pathname === "manifest.json");
};
type CatalogEntry = { path: string; channels: Record<string, { mimetype: string; tokens: number; lines: number }> };

// The full catalog as stored on the plurnk://manifest.json entry's body — the
// same content engine_list_session_entries (the catalog's own source) reads.
const storedCatalog = async (db: Awaited<ReturnType<typeof openMigrated>>, sessionId: number): Promise<{ mimetype: string; catalog: CatalogEntry[] } | null> => {
    const rows = await (db.engine_list_session_entries as PrepMethod).all<{ scheme: string | null; pathname: string; content: string; mimetype: string }>({ session_id: sessionId });
    const m = rows.find((r) => r.scheme === "plurnk" && r.pathname === "manifest.json");
    return m === undefined ? null : { mimetype: m.mimetype, catalog: JSON.parse(m.content) as CatalogEntry[] };
};

const seedChannel = async (db: Awaited<ReturnType<typeof openMigrated>>, sessionId: number, scheme: string | null, pathname: string, channel: string, content: string, mimetype: string, tokens: number): Promise<void> => {
    const e = await (db.crud_insert_session_entry as PrepMethod).get<{ id: number }>({ session_id: sessionId, scheme, pathname });
    await (db.crud_write_channel as PrepMethod).run({ entry_id: e!.id, name: channel, content, mimetype, tokens, state: "static" });
};

// Run n turns in one run/loop; return the LAST turn's packet json.
const runTurns = async (db: Awaited<ReturnType<typeof openMigrated>>, sessionId: number, n: number): Promise<string> => {
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1, "go");
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    const provider = new Mock({ contextSize: 8192, responses: Array.from({ length: n }, () => response([sendStmt(200, "done")])) });
    let packet = "";
    for (let i = 0; i < n; i++) {
        const result = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: result.turnId });
        if (row === undefined) throw new Error("packet not found");
        packet = row.packet;
    }
    return packet;
};

test("manifest: a real plurnk://manifest.json entry — flat catalog of every entry across schemes, application/json, in the index", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `cat-${crypto.randomUUID()}`);
        await seedChannel(db, sessionId, "known", "plan", "content", "- [ ] ship\n- [ ] demo\n", "text/markdown", 6);
        await seedChannel(db, sessionId, null, "notes.md", "body", "one\ntwo\nthree\n", "text/markdown", 4);

        const tile = manifestTile(await runTurns(db, sessionId, 1));
        assert.ok(tile, "manifest is a real indexed entry (appears in the index)");
        assert.equal(tile!.channels.body.mimetype, "application/json", "json mimetype — same preview plumbing as any json entry");

        const stored = await storedCatalog(db, sessionId);
        assert.ok(stored, "manifest is a real session entry");
        assert.equal(stored!.mimetype, "application/json");
        const paths = stored!.catalog.map((e) => e.path);
        assert.ok(Array.isArray(stored!.catalog), "catalog is a flat array");
        assert.ok(paths.includes("known://plan"), `lists known:// entries; got ${paths.join(", ")}`);
        assert.ok(paths.includes("notes.md"), "lists file entries (bare path)");
        assert.ok(paths.some((p) => p.startsWith("plurnk://prompt/")), "lists the foisted prompt");
        const known = stored!.catalog.find((e) => e.path === "known://plan")!;
        assert.equal(known.channels.content.tokens, 6, "depth carried from entry_channels.tokens");
        assert.ok(known.channels.content.lines >= 2, `extent from mimetypes totalLines (got ${known.channels.content.lines})`);
    } finally { await db.close(); }
});

test("manifest: lists itself — an entry in the DB like any other (one turn's lag on its own row)", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `self-${crypto.randomUUID()}`);
        // Turn 1 writes the manifest; turn 2's catalog (built from the DB before
        // its own write) therefore carries the manifest entry from turn 1.
        await runTurns(db, sessionId, 2);
        const stored = await storedCatalog(db, sessionId);
        const paths = stored!.catalog.map((e) => e.path);
        assert.ok(paths.includes("plurnk://manifest.json"), `catalog lists itself; got ${paths.join(", ")}`);
    } finally { await db.close(); }
});
