// {§binary-parity} — a binary is not a second-class resource. COPY/MOVE transfers its bytes exactly —
// whole, by byte range, or spliced into a destination range — between files and through a worker:// DB
// entry (stored base64 in content), byte-for-byte; a MOVE deletes the source. The refusals are narrow: a
// textual anchor on a binary region, authoring bytes from a text EDIT body, a scheme that keeps no bytes.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadStatement, FindStatement } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import { viableWindow, openMigrated, insertWorkspace, insertWorker, seedEntryWithChannel, makeSchemeCtx, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { rpcCall, connect, withDaemon, waitForDb } from "./_rpc.ts";
import { resourcePaths } from "./_find.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import EntryOps from "../../src/schemes/_entry-ops.ts";
import EntryFind from "../../src/schemes/_entry-find.ts";
import Worker from "../../src/schemes/Worker.ts";
import Owner from "../../src/core/Owner.ts";

// The task tree is a plain directory: admit its files as members, as the harness does.
process.env.PLURNK_MEMBERS_TASK = "**";
process.env.PLURNK_MEMBERS_ENABLED = "[\"task\"]";
process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";

// A complete, valid 1×1 PNG (signature, IHDR, IDAT, IEND).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const mockTurn = (dsl: string) => ({
    assistant: { content: `# PLAN0\n${dsl}`, reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 } },
    assistantRaw: null,
});

const runCopy = async (seed: Record<string, Buffer>, dsl: string) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-binparity-"));
    for (const [name, bytes] of Object.entries(seed)) await writeFile(join(root, name), bytes);
    const mock = new Mock({ contextWindow: viableWindow(), responses: [mockTurn(`${dsl}\n\n## SEND0 (NEXT)\nworking`), mockTurn("## SEND0 (TERM)\ndone")] });
    let status = 0;
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `binparity-${Date.now()}`, projectRoot: root });
            const run = await rpcCall(ws, 2, "loop.run", { prompt: "relocate the binary", policy: { proposals: "accept" } });
            const loopId = (run.result as { loopId: number }).loopId;
            await waitForDb(
                () => db.engine_loop_status.get<{ status: number }>({ loop_id: loopId }),
                (r) => r?.status === 200,
                { timeoutMs: 20000 },
            );
            status = 200;
        } finally { ws.close(); }
    });
    return { root, status };
};

const gone = async (path: string): Promise<boolean> => access(path).then(() => false, () => true);

test("{§binary-parity} COPY of a whole binary file reproduces its bytes exactly", async () => {
    const { root } = await runCopy({ "logo.png": PNG }, "## COPY0 (logo.png) (copy.png)");
    try {
        assert.ok(Buffer.from(await readFile(join(root, "copy.png"))).equals(PNG), "the copy is byte-identical");
        assert.ok(Buffer.from(await readFile(join(root, "logo.png"))).equals(PNG), "the source is untouched by COPY");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§binary-parity} MOVE of a whole binary file relocates the bytes and deletes the source", async () => {
    const { root } = await runCopy({ "a.png": PNG }, "## MOVE0 (a.png) (b.png)");
    try {
        assert.ok(Buffer.from(await readFile(join(root, "b.png"))).equals(PNG), "the destination has the bytes");
        assert.ok(await gone(join(root, "a.png")), "the source is gone after MOVE");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§binary-parity} <1,-1> is the whole resource, identical to unscoped", async () => {
    const { root } = await runCopy({ "logo.png": PNG }, "## COPY0 (logo.png) <1,-1> (whole.png)");
    try {
        assert.ok(Buffer.from(await readFile(join(root, "whole.png"))).equals(PNG), "<1,-1> copies every byte");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§binary-parity} a byte range copies exactly those bytes (coordinate = byte)", async () => {
    const { root } = await runCopy({ "logo.png": PNG }, "## COPY0 (logo.png) <1,8> (head.png)");
    try {
        // The 8-byte PNG signature, 1-indexed bytes 1..8 inclusive.
        assert.ok(Buffer.from(await readFile(join(root, "head.png"))).equals(PNG.subarray(0, 8)), "bytes 1..8 are the PNG signature");
    } finally { await rm(root, { recursive: true, force: true }); }
});

// Distinct, unambiguously-binary fixtures for the region splice (extension drives mimetype).
const BIN16 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
const PATCH = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);

test("{§binary-parity} a destination byte range is spliced: <c,d> becomes the source bytes, the rest untouched", async () => {
    const { root } = await runCopy({ "target.png": BIN16, "patch.png": PATCH }, "## COPY0 (patch.png) <1,4> (target.png) <5,8>");
    try {
        const expected = Buffer.concat([BIN16.subarray(0, 4), PATCH, BIN16.subarray(8)]);
        assert.ok(Buffer.from(await readFile(join(root, "target.png"))).equals(expected), "bytes 5..8 became the patch, every other byte kept");
        assert.ok(Buffer.from(await readFile(join(root, "patch.png"))).equals(PATCH), "the source is untouched by the splice");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§binary-parity} a single destination byte position inserts the source bytes before it", async () => {
    const { root } = await runCopy({ "target.png": BIN16, "patch.png": PATCH }, "## COPY0 (patch.png) <1,2> (target.png) <3>");
    try {
        const expected = Buffer.concat([BIN16.subarray(0, 2), PATCH.subarray(0, 2), BIN16.subarray(2)]);
        assert.ok(Buffer.from(await readFile(join(root, "target.png"))).equals(expected), "the two patch bytes were inserted before byte 3");
    } finally { await rm(root, { recursive: true, force: true }); }
});

// A binary is not confined to the filesystem: it may live in a worker:// DB entry and come back out
// byte-for-byte. Two turns — stash the file into an entry, then copy the entry back to a new file.
const runRoundTrip = async (dsl0: string, dsl1: string) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-binentry-"));
    await writeFile(join(root, "logo.png"), PNG);
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        mockTurn(`${dsl0}\n\n## SEND0 (NEXT)\nstashed`),
        mockTurn(`${dsl1}\n\n## SEND0 (NEXT)\ncopied`),
        mockTurn("## SEND0 (TERM)\ndone"),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `binentry-${Date.now()}`, projectRoot: root });
            const run = await rpcCall(ws, 2, "loop.run", { prompt: "round-trip the binary", policy: { proposals: "accept" } });
            const loopId = (run.result as { loopId: number }).loopId;
            await waitForDb(
                () => db.engine_loop_status.get<{ status: number }>({ loop_id: loopId }),
                (r) => r?.status === 200,
                { timeoutMs: 20000 },
            );
        } finally { ws.close(); }
    });
    return root;
};

test("{§binary-parity} a binary lives in a worker:// entry and round-trips to a file byte-for-byte", async () => {
    const root = await runRoundTrip("## COPY0 (logo.png) (worker:///stash.png)", "## COPY0 (worker:///stash.png) (out.png)");
    try {
        assert.ok(Buffer.from(await readFile(join(root, "out.png"))).equals(PNG), "the binary survived a worker:// round-trip byte-for-byte");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§binary-parity} a byte range copies out of a worker:// entry exactly (coordinate = byte)", async () => {
    const root = await runRoundTrip("## COPY0 (logo.png) (worker:///stash.png)", "## COPY0 (worker:///stash.png) <1,8> (head.png)");
    try {
        assert.ok(Buffer.from(await readFile(join(root, "head.png"))).equals(PNG.subarray(0, 8)), "bytes 1..8 out of the entry are the PNG signature");
    } finally { await rm(root, { recursive: true, force: true }); }
});

// The read side of the entry story, exercised directly: a binary channel stored in a DB entry keeps its
// bytes base64 in TEXT content, and a default READ recovers them as the hex byte view — no byte source
// handed in, synthesized from the stored content — exactly as a File member's #bytes reads.
const readStmt = (pathname: string): ReadStatement => ({
    metadata: null, op: "READ", annotation: null, delimiter: "",
    target: { kind: "url", raw: `worker:///${pathname}`, scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: `/${pathname}`, query: null, fragment: null },
    lineMarker: null, body: null, position: { line: 1, column: 1 },
});

test("{§binary-parity} a binary entry stores its bytes base64 and READs back as the hex byte view", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `binentry-read-${crypto.randomUUID()}`);
        const ctx = makeSchemeCtx({ db, workspaceId, mimetypes: DEFAULT_MIMETYPES, weigh: (t: string) => Math.ceil(t.length / 4) });
        const ownerId = await Owner.commonsId(db, workspaceId);

        const written = await EntryCrud.writeEntry({ authority: "", pathname: "/stash.png" }, { channels: { body: { content: "", bytes: PNG, mimetype: "image/png" } } }, ctx, "worker", ownerId);
        assert.equal(written.status, 201);
        const rows = await db.entry_read_channels.all<{ name: string; content: string; mimetype: string }>({ entry_id: written.entryId });
        assert.equal(rows[0].mimetype, "image/png", "the binary mimetype is preserved");
        assert.equal(rows[0].content, PNG.toString("base64"), "the bytes are stored base64 in TEXT content");

        const read = await EntryOps.readWorkspaceEntry(readStmt("stash.png"), ctx, Worker.manifest, { ownerId });
        assert.equal(read.status, 200, "a default READ of the binary entry succeeds");
        assert.equal(read.mimetype, "image/png", "the byte view never relabels the source mimetype");
        assert.equal(read.projection, "hex", "it projects as the hex byte view");
        assert.equal(read.startLine, 1, "the byte window starts at byte 1");
        assert.match(read.content ?? "", /^89\n50\n4e\n47\n/, "one hex octet per line, opening on the PNG signature 89 50 4e 47");
    } finally { await db.close(); }
});

// FIND treats a binary entry as bytes, never as its base64 text: a byte run in the entry's bytes is
// found, and a text search over the workspace is never poisoned into matching a binary's base64.
const findBody = (raw: string, pattern: string): FindStatement => ({
    metadata: null, op: "FIND", annotation: null, delimiter: "",
    target: { kind: "url", raw: "worker:///**", scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: "/**", query: null, fragment: null },
    lineMarker: null, body: { dialect: "regex", raw, pattern, flags: "" }, position: { line: 1, column: 1 },
});

test("{§binary-parity} FIND searches a binary entry as its bytes, never its base64 text", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `binfind-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes: DEFAULT_MIMETYPES });
        const ownerId = await Owner.commonsId(db, workspaceId);
        await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/stash.png", channel: "body", content: PNG.toString("base64"), mimetype: "image/png" });
        await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/notes.md", channel: "body", content: "the needle is here", mimetype: "text/markdown" });

        // "IHDR" is a literal byte run in every PNG header — findable in the decoded bytes, not in the note.
        const png = await EntryFind.findWorkspaceEntries(findBody("/IHDR/", "IHDR"), ctx, Worker.manifest, { ownerId });
        assert.equal(png.status, 200);
        assert.equal(resourcePaths(png).filter((p) => p.includes("stash.png")).length, 1, "the byte run is found inside the binary entry");
        assert.equal(resourcePaths(png).some((p) => p.includes("notes.md")), false, "the text note has no such bytes");

        // A text needle matches the note only — a binary channel is never text-searched over its base64.
        const needle = await EntryFind.findWorkspaceEntries(findBody("/needle/", "needle"), ctx, Worker.manifest, { ownerId });
        assert.equal(needle.status, 200);
        assert.equal(resourcePaths(needle).filter((p) => p.includes("notes.md")).length, 1, "the text note matches");
        assert.equal(resourcePaths(needle).some((p) => p.includes("stash.png")), false, "the binary entry is never poisoned into a text match");
    } finally { await db.close(); }
});
