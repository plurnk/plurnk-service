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

type IndexEntry = { scheme: string; pathname: string; channels: Record<string, { content: string }> };
const manifestOf = (packetJson: string): IndexEntry | undefined => {
    const packet = JSON.parse(packetJson) as { system: { index: IndexEntry[] } };
    return packet.system.index.find((e) => e.scheme === "plurnk" && e.pathname === "manifest.json");
};

const runOnce = async (db: Awaited<ReturnType<typeof openMigrated>>, sessionId: number): Promise<string> => {
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1, "go");
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    const provider = new Mock({ contextSize: 8192, responses: [response([sendStmt(200, "done")])] });
    const result = await engine.runTurn({
        provider, sessionId, runId, loopId,
        messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
    });
    const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: result.turnId });
    if (row === undefined) throw new Error("packet not found");
    return row.packet;
};

test("manifest: workspace session lists file members with depth + addressable extent", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
        await (db.test_set_session_project_root as PrepMethod).run({ id: sessionId, project_root: "/tmp/ws" });
        // Seed a file member (entry + body channel) — what a client `add` lands.
        const e = await (db.crud_insert_session_entry as PrepMethod).get<{ id: number }>({ session_id: sessionId, scheme: null, pathname: "notes.md" });
        await (db.crud_write_channel as PrepMethod).run({ entry_id: e!.id, name: "body", content: "line one\nline two\nline three\n", mimetype: "text/markdown", tokens: 7, state: "static" });

        const manifest = manifestOf(await runOnce(db, sessionId));
        assert.ok(manifest, "manifest entry present in the index");
        const data = JSON.parse(manifest!.channels.content.content) as { files: Array<{ path: string; mimetype: string; tokens: number; lines: number }> };
        assert.equal(data.files.length, 1);
        assert.equal(data.files[0].path, "notes.md");
        assert.equal(data.files[0].tokens, 7, "depth carried from entry_channels.tokens");
        assert.ok(data.files[0].lines >= 3, `addressable extent from mimetypes totalLines (got ${data.files[0].lines})`);
    } finally { await db.close(); }
});

test("manifest: present even at zero members — empty list, not absence", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
        await (db.test_set_session_project_root as PrepMethod).run({ id: sessionId, project_root: "/tmp/ws" });

        const manifest = manifestOf(await runOnce(db, sessionId));
        assert.ok(manifest, "manifest present with no members — the surface exists");
        const data = JSON.parse(manifest!.channels.content.content) as { files: unknown[] };
        assert.deepEqual(data.files, [], "zero members → empty list");
    } finally { await db.close(); }
});

test("manifest: headless session (no project_root) → no manifest (file TOC is meaningless)", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `headless-${crypto.randomUUID()}`);
        const manifest = manifestOf(await runOnce(db, sessionId));
        assert.equal(manifest, undefined, "no workspace → no file manifest");
    } finally { await db.close(); }
});
