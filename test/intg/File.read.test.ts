import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { MatcherBody, ParsedPath, ReadStatement, UrlPath } from "@plurnk/plurnk-grammar";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import type { PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import File from "../../src/schemes/File.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import { MimetypeBinary } from "../../src/content/index.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, DEFAULT_MIMETYPES } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const readStmt = (target: ParsedPath | null, opts: { lineMarker?: ReadStatement["lineMarker"]; body?: MatcherBody | null; tags?: string[] | null } = {}): ReadStatement => ({
    op: "READ", suffix: "",
    signal: opts.tags ?? null, target,
    lineMarker: opts.lineMarker ?? null, body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

// Materialize a file as a readable member — mirrors what the git-membership pass
// does in production: read disk content into the entry's body channel via
// writeEntry (the entry-write paradigm). Entry-backed File.read serves THIS entry,
// never a disk read. Root comes from the session's project_root, like production.
const addMember = async (ctx: PlurnkSchemeContext, pathname: string): Promise<void> => {
    if (ctx.mimetypes === undefined) throw new Error("addMember: ctx.mimetypes required");
    const row = await (ctx.db.envelope_get_session as PrepMethod).get<{ project_root: string }>({ id: ctx.sessionId });
    const canonical = join(row?.project_root ?? "", pathname);
    const mimetype = MimetypeBinary.normalizeAutoTextMimetype(await ctx.mimetypes.detect({ path: canonical }));
    const content = await readFile(canonical, "utf8");
    // Entry key is namespace-absolute (`/notes.md`), mirroring production's
    // git-membership pass — the disk path (canonical) stays workspace-relative.
    await EntryCrud.writeEntry(`/${pathname}`, { channels: { body: { content, mimetype } }, tags: [] }, ctx, null);
};

// Set up a session whose project_root points at a fresh temp directory,
// build a real PlurnkSchemeContext against it, run the test, clean up.
// Workspace root is now per-session (F.1 + F.5) — sourced from
// sessions.project_root, not an env var.
const withSessionWorkspace = async (fn: (root: string, ctx: PlurnkSchemeContext, db: Db) => Promise<void>): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-file-"));
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `file-test-${crypto.randomUUID()}`);
        await (db.test_set_session_project_root as PrepMethod).run({ id: sessionId, project_root: root });
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const ctx: PlurnkSchemeContext = {
            db, sessionId, runId, loopId, turnId,
            writer: "model", signal: undefined, mimetypes: DEFAULT_MIMETYPES, tokenize: (t: string) => Math.ceil(t.length / 4),
        };
        await fn(root, ctx, db);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
};

// Build a ctx whose session has NULL project_root, to exercise the
// "headless / no workspace" branch.
const withHeadlessSession = async (fn: (ctx: PlurnkSchemeContext, db: Db) => Promise<void>): Promise<void> => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `headless-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const ctx: PlurnkSchemeContext = {
            db, sessionId, runId, loopId, turnId,
            writer: "model", signal: undefined, mimetypes: DEFAULT_MIMETYPES, tokenize: (t: string) => Math.ceil(t.length / 4),
        };
        await fn(ctx, db);
    } finally { await db.close(); }
};

test("File.read: read existing file inside workspace → 200 + content + text/markdown", async () => {
    // plurnk-service's text primitive is text/markdown — File.read of a
    // .txt with no specific handler falls back to it (any plain text is
    // valid markdown; auto-derived text mimetype is never text/plain).
    await withSessionWorkspace(async (root, ctx) => {
        await writeFile(join(root, "hello.txt"), "Paris is the capital of France.\n");
        await addMember(ctx, "hello.txt");
        const result = await new File().read(readStmt(urlPath("file", "/hello.txt")), ctx);
        assert.equal(result.status, 200);
        assert.equal(result.content, "Paris is the capital of France.\n");
        assert.equal(result.mimetype, "text/markdown");
    });
});

test("File.read: nested path inside workspace works", async () => {
    await withSessionWorkspace(async (root, ctx) => {
        await mkdir(join(root, "docs"));
        await writeFile(join(root, "docs", "readme.md"), "# Doc\n");
        await addMember(ctx, "docs/readme.md");
        const result = await new File().read(readStmt(urlPath("file", "/docs/readme.md")), ctx);
        assert.equal(result.status, 200);
        assert.equal(result.content, "# Doc\n");
    });
});

test("File.read: missing file → 404", async () => {
    await withSessionWorkspace(async (_root, ctx) => {
        const result = await new File().read(readStmt(urlPath("file", "/missing.txt")), ctx);
        assert.equal(result.status, 404);
        assert.equal(result.content, null);
    });
});

test("File.read: workspace escape via .. → 403 or 404", async () => {
    await withSessionWorkspace(async (_root, ctx) => {
        const outside = await mkdtemp(join(tmpdir(), "plurnk-outside-"));
        try {
            await writeFile(join(outside, "secret.txt"), "shouldnt-see");
            const result = await new File().read(readStmt(urlPath("file", `../${outside.split("/").pop()}/secret.txt`)), ctx);
            assert.ok(result.status === 403 || result.status === 404, `expected 403 or 404, got ${result.status}`);
        } finally { await rm(outside, { recursive: true, force: true }); }
    });
});

test("File.read: symlink pointing outside workspace → 404 (never a member)", async () => {
    await withSessionWorkspace(async (root, ctx) => {
        const outside = await mkdtemp(join(tmpdir(), "plurnk-outside-"));
        try {
            await writeFile(join(outside, "secret.txt"), "shouldnt-see");
            await symlink(join(outside, "secret.txt"), join(root, "link-to-secret"));
            const result = await new File().read(readStmt(urlPath("file", "/link-to-secret")), ctx);
            // Containment moved to the materialize/edit disk edges: an outside-root
            // symlink is never materialized → no entry → 404 (not a read-path 403).
            assert.equal(result.status, 404, "non-member (outside-root symlink) → no entry → 404");
            assert.equal(result.content, null);
        } finally { await rm(outside, { recursive: true, force: true }); }
    });
});

test("File.read: headless session (no entries) → 404", async () => {
    await withHeadlessSession(async (ctx) => {
        // Entry-backed read: a headless session materializes no file entries, so
        // any file read finds nothing → 404 (uniform with Known; the old
        // project_root precondition lived on the deleted disk-read path).
        const result = await new File().read(readStmt(urlPath("file", "/hello.txt")), ctx);
        assert.equal(result.status, 404);
    });
});

test("File.read: null path → 400", async () => {
    await withSessionWorkspace(async (_root, ctx) => {
        const result = await new File().read(readStmt(null), ctx);
        assert.equal(result.status, 400);
    });
});

test("File.read: lineMarker <N> selects line N as raw content with startLine=N", async () => {
    await withSessionWorkspace(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "alpha\nbeta\ngamma\n");
        await addMember(ctx, "f.txt");
        const r = await new File().read(readStmt(urlPath("file", "/f.txt"), { lineMarker: { first: 2, last: null } }), ctx);
        assert.equal(r.status, 200);
        assert.equal(r.content, "beta");
        assert.equal((r as { startLine?: number }).startLine, 2);
    });
});

test("File.read: lineMarker <N,M> selects inclusive range as raw content with startLine=N", async () => {
    await withSessionWorkspace(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "a\nb\nc\nd\n");
        await addMember(ctx, "f.txt");
        const r = await new File().read(readStmt(urlPath("file", "/f.txt"), { lineMarker: { first: 2, last: 3 } }), ctx);
        assert.equal(r.status, 200);
        assert.equal(r.content, "b\nc");
        assert.equal((r as { startLine?: number }).startLine, 2);
    });
});

test("File.read: lineMarker out of range returns 416", async () => {
    await withSessionWorkspace(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "one\ntwo\n");
        await addMember(ctx, "f.txt");
        const r = await new File().read(readStmt(urlPath("file", "/f.txt"), { lineMarker: { first: 99, last: null } }), ctx);
        assert.equal(r.status, 416);
    });
});

test("File.read: regex body matcher returns N:\\t<value> rows", async () => {
    await withSessionWorkspace(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "foo\nbar foo");
        await addMember(ctx, "f.txt");
        const r = await new File().read(
            readStmt(urlPath("file", "/f.txt"), { body: { dialect: "regex", raw: "/foo/g", pattern: "foo", flags: "g" } }),
            ctx,
        );
        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "text/markdown");
        assert.equal(r.content, "1:\tfoo\n2:\tfoo");
    });
});

test("File.read: <L> + body matcher composes — slice first, match within, source lines preserved", async () => {
    await withSessionWorkspace(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "alpha\nfoo bar foo\ngamma\n");
        await addMember(ctx, "f.txt");
        const r = await new File().read(
            readStmt(urlPath("file", "/f.txt"), {
                lineMarker: { first: 2, last: 2 },
                body: { dialect: "regex", raw: "/foo/g", pattern: "foo", flags: "g" },
            }),
            ctx,
        );
        assert.equal(r.status, 200);
        // Both matches on source line 2 (after slice); baseLine=2 preserved.
        assert.equal(r.content, "2:\tfoo\n2:\tfoo");
    });
});

test("File.read: non-empty tag filter on file:/// returns 404 (no tag concept)", async () => {
    await withSessionWorkspace(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "x");
        await addMember(ctx, "f.txt");
        // Entry exists, but file entries carry no tags → a tag-filtered read 404s
        // via the EntryOps tag gate, same as Known.
        const r = await new File().read(readStmt(urlPath("file", "/f.txt"), { tags: ["any"] }), ctx);
        assert.equal(r.status, 404);
    });
});

test("File.read: long content round-trips", async () => {
    await withSessionWorkspace(async (root, ctx) => {
        const big = "lorem ipsum dolor sit amet ".repeat(1000);
        await writeFile(join(root, "big.txt"), big);
        await addMember(ctx, "big.txt");
        const result = await new File().read(readStmt(urlPath("file", "/big.txt")), ctx);
        assert.equal(result.status, 200);
        assert.equal(result.content?.length, big.length);
    });
});

test("File.read: absolute path → 404 (entries are relative-keyed, uniform with Known)", async () => {
    await withSessionWorkspace(async (root, ctx) => {
        await writeFile(join(root, "abs.txt"), "abs content");
        const absolutePath = resolve(root, "abs.txt");
        await addMember(ctx, "abs.txt");
        // The entry is keyed by its workspace-relative pathname ("abs.txt"); an
        // absolute-path READ is a different key → no entry → 404. File does no
        // scheme-specific absolute→relative resolution (that was the disk path).
        const result = await new File().read(readStmt(urlPath("file", absolutePath)), ctx);
        assert.equal(result.status, 404);
    });
});

test("File.read: absolute path OUTSIDE workspace → 404 (never a member)", async () => {
    await withSessionWorkspace(async (_root, ctx) => {
        const outside = await mkdtemp(join(tmpdir(), "plurnk-outside-"));
        try {
            const outsideFile = join(outside, "leak.txt");
            await writeFile(outsideFile, "should not be readable");
            const result = await new File().read(readStmt(urlPath("file", outsideFile)), ctx);
            // An outside-root path can never be materialized → no entry → 404.
            assert.equal(result.status, 404);
            assert.equal(result.content, null);
        } finally { await rm(outside, { recursive: true, force: true }); }
    });
});
