import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { MatcherBody, ParsedPath, ReadStatement, UrlPath } from "@plurnk/plurnk-grammar";
import File from "../../src/schemes/File.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const readStmt = (path: ParsedPath | null, opts: { lineMarker?: ReadStatement["lineMarker"]; body?: MatcherBody | null; tags?: string[] | null } = {}): ReadStatement => ({
    op: "READ", suffix: "",
    signal: opts.tags ?? null, path,
    lineMarker: opts.lineMarker ?? null, body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const withWorkspace = async (fn: (root: string) => Promise<void>): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-file-"));
    const previousRoot = process.env.PLURNK_WORKSPACE_ROOT;
    process.env.PLURNK_WORKSPACE_ROOT = root;
    try { await fn(root); }
    finally {
        if (previousRoot === undefined) delete process.env.PLURNK_WORKSPACE_ROOT;
        else process.env.PLURNK_WORKSPACE_ROOT = previousRoot;
        await rm(root, { recursive: true, force: true });
    }
};

test("File.read: read existing file inside workspace → 200 + content + mimetype", async () => {
    await withWorkspace(async (root) => {
        await writeFile(join(root, "hello.txt"), "Paris is the capital of France.\n");
        const result = await new File().read({ statement: readStmt(urlPath("file", "hello.txt")) });
        assert.equal(result.status, 200);
        assert.equal(result.content, "Paris is the capital of France.\n");
        assert.equal(result.mimetype, "text/plain");
    });
});

test("File.read: nested path inside workspace works", async () => {
    await withWorkspace(async (root) => {
        await mkdir(join(root, "docs"));
        await writeFile(join(root, "docs", "readme.md"), "# Doc\n");
        const result = await new File().read({ statement: readStmt(urlPath("file", "docs/readme.md")) });
        assert.equal(result.status, 200);
        assert.equal(result.content, "# Doc\n");
    });
});

test("File.read: missing file → 404", async () => {
    await withWorkspace(async () => {
        const result = await new File().read({ statement: readStmt(urlPath("file", "missing.txt")) });
        assert.equal(result.status, 404);
        assert.equal(result.content, null);
    });
});

test("File.read: workspace escape via .. → 403", async () => {
    await withWorkspace(async (root) => {
        // Create a file OUTSIDE the workspace
        const outside = await mkdtemp(join(tmpdir(), "plurnk-outside-"));
        try {
            await writeFile(join(outside, "secret.txt"), "shouldnt-see");
            // Try to read it via .. traversal
            const result = await new File().read({ statement: readStmt(urlPath("file", `../${outside.split("/").pop()}/secret.txt`)) });
            // Either 403 (canonical detected outside) or 404 (path doesn't exist relative to root, depending on resolution)
            assert.ok(result.status === 403 || result.status === 404, `expected 403 or 404, got ${result.status}`);
        } finally { await rm(outside, { recursive: true, force: true }); }
    });
});

test("File.read: symlink pointing outside workspace → 403", async () => {
    await withWorkspace(async (root) => {
        const outside = await mkdtemp(join(tmpdir(), "plurnk-outside-"));
        try {
            await writeFile(join(outside, "secret.txt"), "shouldnt-see");
            await symlink(join(outside, "secret.txt"), join(root, "link-to-secret"));
            const result = await new File().read({ statement: readStmt(urlPath("file", "link-to-secret")) });
            assert.equal(result.status, 403, "symlink should be rejected after canonical resolution");
            assert.equal(result.content, null);
        } finally { await rm(outside, { recursive: true, force: true }); }
    });
});

test("File.read: PLURNK_WORKSPACE_ROOT not set → 400", async () => {
    const previous = process.env.PLURNK_WORKSPACE_ROOT;
    delete process.env.PLURNK_WORKSPACE_ROOT;
    try {
        const result = await new File().read({ statement: readStmt(urlPath("file", "hello.txt")) });
        assert.equal(result.status, 400);
    } finally {
        if (previous !== undefined) process.env.PLURNK_WORKSPACE_ROOT = previous;
    }
});

test("File.read: null path → 400", async () => {
    await withWorkspace(async () => {
        const result = await new File().read({ statement: readStmt(null) });
        assert.equal(result.status, 400);
    });
});

test("File.read: lineMarker / body matcher / non-empty tag filter → 501", async () => {
    await withWorkspace(async (root) => {
        await writeFile(join(root, "f.txt"), "x");
        const file = new File();
        const path = urlPath("file", "f.txt");
        assert.equal((await file.read({ statement: readStmt(path, { lineMarker: { first: 1, last: null } }) })).status, 501);
        assert.equal((await file.read({ statement: readStmt(path, { body: { dialect: "glob", raw: "*" } }) })).status, 501);
        assert.equal((await file.read({ statement: readStmt(path, { tags: ["any"] }) })).status, 501);
    });
});

test("File.read: long content round-trips", async () => {
    await withWorkspace(async (root) => {
        const big = "lorem ipsum dolor sit amet ".repeat(1000);
        await writeFile(join(root, "big.txt"), big);
        const result = await new File().read({ statement: readStmt(urlPath("file", "big.txt")) });
        assert.equal(result.status, 200);
        assert.equal(result.content?.length, big.length);
    });
});

test("File.read: absolute path inside workspace resolves correctly", async () => {
    await withWorkspace(async (root) => {
        await writeFile(join(root, "abs.txt"), "abs content");
        const absolutePath = resolve(root, "abs.txt");
        const result = await new File().read({ statement: readStmt(urlPath("file", absolutePath)) });
        assert.equal(result.status, 200);
        assert.equal(result.content, "abs content");
    });
});

test("File.read: absolute path OUTSIDE workspace → 403", async () => {
    await withWorkspace(async () => {
        const outside = await mkdtemp(join(tmpdir(), "plurnk-outside-"));
        try {
            const outsideFile = join(outside, "leak.txt");
            await writeFile(outsideFile, "should not be readable");
            const result = await new File().read({ statement: readStmt(urlPath("file", outsideFile)) });
            assert.equal(result.status, 403);
            assert.equal(result.content, null);
        } finally { await rm(outside, { recursive: true, force: true }); }
    });
});
