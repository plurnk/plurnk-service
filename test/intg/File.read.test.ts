import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { MatcherBody, ParsedPath, ReadStatement, UrlPath } from "@plurnk/plurnk-grammar";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import type { PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import File from "../../src/schemes/File.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn } from "./_helpers.ts";

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
            writer: "model", signal: undefined,
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
            writer: "model", signal: undefined,
        };
        await fn(ctx, db);
    } finally { await db.close(); }
};

test("File.read: read existing file inside workspace → 200 + content + mimetype", async () => {
    await withSessionWorkspace(async (root, ctx) => {
        await writeFile(join(root, "hello.txt"), "Paris is the capital of France.\n");
        const result = await new File().read(readStmt(urlPath("file", "hello.txt")), ctx);
        assert.equal(result.status, 200);
        assert.equal(result.content, "Paris is the capital of France.\n");
        assert.equal(result.mimetype, "text/plain");
    });
});

test("File.read: nested path inside workspace works", async () => {
    await withSessionWorkspace(async (root, ctx) => {
        await mkdir(join(root, "docs"));
        await writeFile(join(root, "docs", "readme.md"), "# Doc\n");
        const result = await new File().read(readStmt(urlPath("file", "docs/readme.md")), ctx);
        assert.equal(result.status, 200);
        assert.equal(result.content, "# Doc\n");
    });
});

test("File.read: missing file → 404", async () => {
    await withSessionWorkspace(async (_root, ctx) => {
        const result = await new File().read(readStmt(urlPath("file", "missing.txt")), ctx);
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

test("File.read: symlink pointing outside workspace → 403", async () => {
    await withSessionWorkspace(async (root, ctx) => {
        const outside = await mkdtemp(join(tmpdir(), "plurnk-outside-"));
        try {
            await writeFile(join(outside, "secret.txt"), "shouldnt-see");
            await symlink(join(outside, "secret.txt"), join(root, "link-to-secret"));
            const result = await new File().read(readStmt(urlPath("file", "link-to-secret")), ctx);
            assert.equal(result.status, 403, "symlink should be rejected after canonical resolution");
            assert.equal(result.content, null);
        } finally { await rm(outside, { recursive: true, force: true }); }
    });
});

test("File.read: headless session (no project_root) → 400", async () => {
    await withHeadlessSession(async (ctx) => {
        const result = await new File().read(readStmt(urlPath("file", "hello.txt")), ctx);
        assert.equal(result.status, 400);
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
        const r = await new File().read(readStmt(urlPath("file", "f.txt"), { lineMarker: { first: 2, last: null } }), ctx);
        assert.equal(r.status, 200);
        assert.equal(r.content, "beta");
        assert.equal((r as { startLine?: number }).startLine, 2);
    });
});

test("File.read: lineMarker <N,M> selects inclusive range as raw content with startLine=N", async () => {
    await withSessionWorkspace(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "a\nb\nc\nd\n");
        const r = await new File().read(readStmt(urlPath("file", "f.txt"), { lineMarker: { first: 2, last: 3 } }), ctx);
        assert.equal(r.status, 200);
        assert.equal(r.content, "b\nc");
        assert.equal((r as { startLine?: number }).startLine, 2);
    });
});

test("File.read: lineMarker out of range returns 416", async () => {
    await withSessionWorkspace(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "one\ntwo\n");
        const r = await new File().read(readStmt(urlPath("file", "f.txt"), { lineMarker: { first: 99, last: null } }), ctx);
        assert.equal(r.status, 416);
    });
});

test("File.read: regex body matcher returns matches", async () => {
    await withSessionWorkspace(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "foo bar foo baz");
        const r = await new File().read(
            readStmt(urlPath("file", "f.txt"), { body: { dialect: "regex", raw: "/foo/g", pattern: "foo", flags: "g" } }),
            ctx,
        );
        assert.equal(r.status, 200);
        assert.equal(r.content, "foo\nfoo");
    });
});

test("File.read: <L> + body matcher composes — slice first, match within", async () => {
    await withSessionWorkspace(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "alpha\nfoo bar foo\ngamma\n");
        const r = await new File().read(
            readStmt(urlPath("file", "f.txt"), {
                lineMarker: { first: 2, last: 2 },
                body: { dialect: "regex", raw: "/foo/g", pattern: "foo", flags: "g" },
            }),
            ctx,
        );
        assert.equal(r.status, 200);
        assert.equal(r.content, "foo\nfoo");
    });
});

test("File.read: non-empty tag filter on file:// returns 404 (no tag concept)", async () => {
    await withSessionWorkspace(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "x");
        const r = await new File().read(readStmt(urlPath("file", "f.txt"), { tags: ["any"] }), ctx);
        assert.equal(r.status, 404);
    });
});

test("File.read: long content round-trips", async () => {
    await withSessionWorkspace(async (root, ctx) => {
        const big = "lorem ipsum dolor sit amet ".repeat(1000);
        await writeFile(join(root, "big.txt"), big);
        const result = await new File().read(readStmt(urlPath("file", "big.txt")), ctx);
        assert.equal(result.status, 200);
        assert.equal(result.content?.length, big.length);
    });
});

test("File.read: absolute path inside workspace resolves correctly", async () => {
    await withSessionWorkspace(async (root, ctx) => {
        await writeFile(join(root, "abs.txt"), "abs content");
        const absolutePath = resolve(root, "abs.txt");
        const result = await new File().read(readStmt(urlPath("file", absolutePath)), ctx);
        assert.equal(result.status, 200);
        assert.equal(result.content, "abs content");
    });
});

test("File.read: absolute path OUTSIDE workspace → 403", async () => {
    await withSessionWorkspace(async (_root, ctx) => {
        const outside = await mkdtemp(join(tmpdir(), "plurnk-outside-"));
        try {
            const outsideFile = join(outside, "leak.txt");
            await writeFile(outsideFile, "should not be readable");
            const result = await new File().read(readStmt(urlPath("file", outsideFile)), ctx);
            assert.equal(result.status, 403);
            assert.equal(result.content, null);
        } finally { await rm(outside, { recursive: true, force: true }); }
    });
});
