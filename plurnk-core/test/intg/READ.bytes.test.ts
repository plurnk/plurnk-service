// {§read-bytes} {§find-bytes} — a binary member reads and searches as its bytes: one hexadecimal
// octet per line, the text coordinate algebra unchanged, evidence that pastes into a READ.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LineMarker, ReadStatement, UrlPath } from "@plurnk/plurnk-contracts";
import File from "../../src/schemes/File.ts";
import ByteView from "../../src/content/byte-view.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import Owner from "../../src/core/Owner.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx, DEFAULT_MIMETYPES, rootWorkspace, lookThroughScheme } from "./_helpers.ts";

process.env.PLURNK_MIMETYPES_BINARY_INPUT_MAX_BYTES ??= "104857600";

const fileUrl = (pathname: string, fragment: string | null = null): UrlPath => ({
    kind: "url", raw: `file://${pathname}${fragment === null ? "" : `#${fragment}`}`, scheme: "file",
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment,
});
const readStmt = (pathname: string, lineMarker: LineMarker | null = null, fragment: string | null = null): ReadStatement => ({
    metadata: null, op: "READ", annotation: null, delimiter: "", target: fileUrl(pathname, fragment), lineMarker, body: null, position: { line: 1, column: 1 },
});
const findStmt = (pathname: string, pattern: string) => ({
    op: "FIND", annotation: null, delimiter: "", lineMarker: null, metadata: null, position: { line: 1, column: 1 },
    target: { kind: "local", raw: pathname }, body: { dialect: "regex", raw: `/${pattern}/`, pattern, flags: "" },
}) as never;

// A PNG signature, a word, a NUL, and a tail: 40 bytes with a text line break inside them.
const BLOB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from("testword02\x00tail-of-the-blob-1234")]);
assert.equal(BLOB.length, 40);

const setup = async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-bytes-"));
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `bytes-${crypto.randomUUID()}`);
    await rootWorkspace(db, workspaceId, root);
    const workerId = await insertWorker(db, workspaceId);
    const ctx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes: DEFAULT_MIMETYPES });
    const owner = await Owner.commonsId(db, workspaceId);
    // The materializer's shape for a binary member with no readable projection: an empty body
    // under the source mimetype; the bytes live on disk only.
    await writeFile(join(root, "blob.bin"), BLOB);
    await EntryCrud.writeEntry({ authority: "", pathname: "blob.bin" }, { channels: { body: { content: "", mimetype: "application/octet-stream" } } }, ctx, "file", owner);
    await writeFile(join(root, "notes.md"), "hello\nworld\n");
    await EntryCrud.writeEntry({ authority: "", pathname: "notes.md" }, { channels: { body: { content: "hello\nworld\n", mimetype: "text/markdown" } } }, ctx, "file", owner);
    return { root, db, ctx };
};

test("{§read-bytes} a binary member reads as hex lines under the same <1,16> default, ranges, and 416", async () => {
    const { root, db, ctx } = await setup();
    try {
        const head = await lookThroughScheme("file", null, readStmt("blob.bin"), ctx);
        assert.equal(head.status, 200, JSON.stringify(head.problem));
        assert.equal(head.content, ByteView.hexLines(BLOB.subarray(0, 16)), "the markerless default is the first sixteen bytes");
        assert.equal(head.startLine, 1);
        assert.equal(head.mimetype, "application/octet-stream", "the source mimetype is never relabelled");
        assert.deepEqual(head.range, { unit: "byte", total: 40, requested: [1, 16], returned: [1, 16] });
        assert.equal((head as { projection?: string }).projection, "hex");

        const tail = await lookThroughScheme("file", null, readStmt("blob.bin", { marks: [17, -1] }), ctx);
        assert.equal(tail.status, 200);
        assert.equal(tail.startLine, 17);
        assert.equal(tail.content, ByteView.hexLines(BLOB.subarray(16)));
        assert.deepEqual(tail.range?.returned, [17, 40]);

        const all = await lookThroughScheme("file", null, readStmt("blob.bin", { marks: [1, -1] }), ctx);
        assert.equal(all.content?.split("\n").length, 40, "<1,-1> is the whole resource");

        const word = await lookThroughScheme("file", null, readStmt("blob.bin", { marks: [9, 18] }), ctx);
        assert.equal(word.content, ByteView.hexLines(Buffer.from("testword02")), "a byte window pastes straight from FIND evidence");

        const beyond = await lookThroughScheme("file", null, readStmt("blob.bin", { marks: [41, 50] }), ctx);
        assert.equal(beyond.status, 416, "past the last byte is not satisfiable");
        assert.equal(beyond.range?.total, 40);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§read-bytes} #bytes is the raw view of any member the scheme can supply, text included", async () => {
    const { root, db, ctx } = await setup();
    try {
        const raw = await lookThroughScheme("file", null, readStmt("notes.md", { marks: [1, 5] }, "bytes"), ctx);
        assert.equal(raw.status, 200, JSON.stringify(raw.problem));
        assert.equal(raw.channel, "bytes");
        assert.equal(raw.content, ByteView.hexLines(Buffer.from("hello")));
        assert.equal(raw.mimetype, "text/markdown");
        const body = await lookThroughScheme("file", null, readStmt("notes.md"), ctx);
        assert.equal(body.content, "hello\nworld\n", "the text body is untouched by the byte view");
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§find-bytes} a FIND over a binary member matches bytes and reports byte coordinates", async () => {
    const { root, db, ctx } = await setup();
    try {
        const file = new File();
        const word = await file.find(findStmt("blob.bin", "testword\\d+"), ctx);
        assert.equal(word.status, 200, JSON.stringify(word.problem));
        const rendered = JSON.stringify(word.results);
        assert.match(rendered, /"startLine":9/, `the word starts at byte 9: ${rendered.slice(0, 400)}`);
        assert.match(rendered, /"endLine":18/, "and ends at byte 18");
        assert.match(rendered, new RegExp(`"matched":"${ByteView.hex(Buffer.from("testword02"))}"`), "the matched bytes ride as hex");

        const signature = await file.find(findStmt("blob.bin", "\\x89PNG"), ctx);
        assert.equal(signature.status, 200, JSON.stringify(signature.problem));
        assert.match(JSON.stringify(signature.results), /"startLine":1,"startColumn":1,"endLine":4,"endColumn":3/, "a byte-escape pattern locates the signature");

        const miss = await file.find(findStmt("blob.bin", "absent-string"), ctx);
        assert.equal(miss.status, 204, "no hit over a present resource is 204, the text contract");
        assert.equal(miss.matchLocationCount, 0);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
