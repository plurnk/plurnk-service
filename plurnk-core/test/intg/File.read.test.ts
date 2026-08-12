import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FindStatement, MatcherBody, ParsedPath, ReadStatement, UrlPath } from "@plurnk/plurnk-contracts";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import type { Db } from "../../src/core/Db.ts";
import type { PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import File from "../../src/schemes/File.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import { MimetypeBinary } from "../../src/content/index.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, DEFAULT_MIMETYPES, lookThroughScheme } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});

const readStmt = (target: ParsedPath | null, opts: { lineMarker?: ReadStatement["lineMarker"]; tags?: string[] | null } = {}): ReadStatement => ({
    op: "READ", suffix: "",
    signal: opts.tags ?? null, target,
    lineMarker: opts.lineMarker ?? null, body: null,
    position: { line: 1, column: 1 },
});

const findStmt = (target: ParsedPath | null, body: MatcherBody | null = null): FindStatement => ({
    op: "FIND", suffix: "", signal: null, target, lineMarker: null, body, position: { line: 1, column: 1 },
});

const readFileScheme = (statement: ReadStatement, ctx: PlurnkSchemeContext) =>
    lookThroughScheme("file", null, statement, ctx);

// Parse a single op the way production does, so a bare path carries its REAL parsed shape
// (a LocalPath {kind:"local"}), not a hand-built UrlPath that hides the kind the model emits.
const parseRead = (dsl: string): ReadStatement => {
    const found = PlurnkParser.parse(`# PLAN1\n${dsl}`).items
        .find((i) => i.kind === "statement" && i.statement.op === "READ");
    if (found === undefined) throw new Error(`no READ parsed from: ${dsl}`);
    return (found as { kind: "statement"; statement: ReadStatement }).statement;
};

const parseFind = (dsl: string): FindStatement => {
    const found = PlurnkParser.parse(`# PLAN1\n${dsl}`).items
        .find((i) => i.kind === "statement" && i.statement.op === "FIND");
    if (found === undefined) throw new Error(`no FIND parsed from: ${dsl}`);
    return (found as { kind: "statement"; statement: FindStatement }).statement;
};

// Materialize a file as a readable member — mirrors what the git-membership pass
// does in production: read disk content into the entry's body channel via
// writeEntry (the entry-write paradigm). Entry-backed File.read serves THIS entry,
// never a disk read. Root comes from the workspace's project_root, like production.
const addMember = async (ctx: PlurnkSchemeContext, pathname: string): Promise<void> => {
    if (ctx.mimetypes === undefined) throw new Error("addMember: ctx.mimetypes required");
    const row = await ctx.db.envelope_get_workspace.get<{ project_root: string }>({ id: ctx.workspaceId });
    const canonical = join(row?.project_root ?? "", pathname);
    const mimetype = MimetypeBinary.normalizeAutoTextMimetype(await ctx.mimetypes.detect({ path: canonical }));
    const content = await readFile(canonical, "utf8");
    // Entry key is namespace-absolute (`/notes.md`), mirroring production's
    // git-membership pass — the disk path (canonical) stays workspace-relative.
    await EntryCrud.writeEntry(`${pathname}`, { channels: { body: { content, mimetype } }, tags: [] }, ctx, "file");
};

// Set up a workspace whose project_root points at a fresh temp directory,
// build a real PlurnkSchemeContext against it, run the test, clean up.
// Workspace root is now per-workspace (F.1 + F.5) — sourced from
// workspaces.project_root, not an env var.
const withWorkspaceRoot = async (fn: (root: string, ctx: PlurnkSchemeContext, db: Db) => Promise<void>): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-file-"));
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `file-test-${crypto.randomUUID()}`);
        await db.test_set_workspace_project_root.run({ id: workspaceId, project_root: root });
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const ctx: PlurnkSchemeContext = {
            db, workspaceId, workerId, loopId, turnId,
            writer: "model", signal: undefined, mimetypes: DEFAULT_MIMETYPES, tokenize: (t: string) => Math.ceil(t.length / 4),
        };
        await fn(root, ctx, db);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
};

// Build a ctx whose workspace has NULL project_root, to exercise the
// "headless / no workspace" branch.
const withHeadlessWorkspace = async (fn: (ctx: PlurnkSchemeContext, db: Db) => Promise<void>): Promise<void> => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `headless-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const ctx: PlurnkSchemeContext = {
            db, workspaceId, workerId, loopId, turnId,
            writer: "model", signal: undefined, mimetypes: DEFAULT_MIMETYPES, tokenize: (t: string) => Math.ceil(t.length / 4),
        };
        await fn(ctx, db);
    } finally { await db.close(); }
};

test("File.read: read existing file inside workspace → 200 + content + text/markdown", async () => {
    // plurnk-service's text primitive is text/markdown — File.read of a
    // .txt with no specific handler falls back to it (any plain text is
    // valid markdown; auto-derived text mimetype is never text/plain).
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "hello.txt"), "Paris is the capital of France.\n");
        await addMember(ctx, "hello.txt");
        const result = await readFileScheme(readStmt(urlPath("file", "/hello.txt")), ctx);
        assert.equal(result.status, 200);
        assert.equal(result.content, "Paris is the capital of France.\n");
        assert.equal(result.mimetype, "text/markdown");
    });
});

test("File.read: nested path inside workspace works", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await mkdir(join(root, "docs"));
        await writeFile(join(root, "docs", "readme.md"), "# Doc\n");
        await addMember(ctx, "docs/readme.md");
        const result = await readFileScheme(readStmt(urlPath("file", "/docs/readme.md")), ctx);
        assert.equal(result.status, 200);
        assert.equal(result.content, "# Doc\n");
    });
});

test("File.read: missing file → 404", async () => {
    await withWorkspaceRoot(async (_root, ctx) => {
        const result = await readFileScheme(readStmt(urlPath("file", "/missing.txt")), ctx);
        assert.equal(result.status, 404);
        assert.equal(result.content, null);
    });
});

test("File.read: workspace escape via .. → 403 or 404", async () => {
    await withWorkspaceRoot(async (_root, ctx) => {
        const outside = await mkdtemp(join(tmpdir(), "plurnk-outside-"));
        try {
            await writeFile(join(outside, "secret.txt"), "shouldnt-see");
            const result = await readFileScheme(readStmt(urlPath("file", `../${outside.split("/").pop()}/secret.txt`)), ctx);
            assert.ok(result.status === 403 || result.status === 404, `expected 403 or 404, got ${result.status}`);
        } finally { await rm(outside, { recursive: true, force: true }); }
    });
});

test("File.read: symlink pointing outside workspace → 404 (never a member)", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const outside = await mkdtemp(join(tmpdir(), "plurnk-outside-"));
        try {
            await writeFile(join(outside, "secret.txt"), "shouldnt-see");
            await symlink(join(outside, "secret.txt"), join(root, "link-to-secret"));
            const result = await readFileScheme(readStmt(urlPath("file", "/link-to-secret")), ctx);
            // Containment moved to the materialize/edit disk edges: an outside-root
            // symlink is never materialized → no entry → 404 (not a read-path 403).
            assert.equal(result.status, 404, "non-member (outside-root symlink) → no entry → 404");
            assert.equal(result.content, null);
        } finally { await rm(outside, { recursive: true, force: true }); }
    });
});

test("File.read: headless workspace (no entries) → 404", async () => {
    await withHeadlessWorkspace(async (ctx) => {
        // Entry-backed read: a headless workspace materializes no file entries, so
        // any file read finds nothing → 404 (uniform with stored entries; the old
        // project_root precondition lived on the deleted disk-read path).
        const result = await readFileScheme(readStmt(urlPath("file", "/hello.txt")), ctx);
        assert.equal(result.status, 404);
    });
});

test("File.read: null path → 400", async () => {
    await withWorkspaceRoot(async (_root, ctx) => {
        const result = await readFileScheme(readStmt(null), ctx);
        assert.equal(result.status, 400);
    });
});

test("File.read: lineMarker <N> selects line N as raw content with startLine=N", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "alpha\nbeta\ngamma\n");
        await addMember(ctx, "f.txt");
        const r = await readFileScheme(readStmt(urlPath("file", "/f.txt"), { lineMarker: { marks: [2] } }), ctx);
        assert.equal(r.status, 200);
        assert.equal(r.content, "beta");
        assert.equal((r as { startLine?: number }).startLine, 2);
    });
});

test("File.read: lineMarker <N,M> selects inclusive range as raw content with startLine=N", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "a\nb\nc\nd\n");
        await addMember(ctx, "f.txt");
        const r = await readFileScheme(readStmt(urlPath("file", "/f.txt"), { lineMarker: { marks: [2, 3] } }), ctx);
        assert.equal(r.status, 200);
        assert.equal(r.content, "b\nc");
        assert.equal((r as { startLine?: number }).startLine, 2);
    });
});

test("File.read: lineMarker out of range returns 416", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "one\ntwo\n");
        await addMember(ctx, "f.txt");
        const r = await readFileScheme(readStmt(urlPath("file", "/f.txt"), { lineMarker: { marks: [99] } }), ctx);
        assert.equal(r.status, 416);
        assert.deepEqual(r.problem?.range, {
            unit: "line",
            total: 2,
            requested: [99, 99],
        });
        assert.equal(r.content, null);
    });
});

test("File.read: an invalid exact region remains a composed 416 result", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "one\ntwo\n");
        await addMember(ctx, "f.txt");
        const r = await readFileScheme(readStmt(urlPath("file", "/f.txt"), {
            lineMarker: { marks: [2, 1, 2, -1] },
        }), ctx);
        assert.equal(r.status, 416);
        assert.deepEqual(r.problem?.requestedCoordinates, [2, 1, 2, -1]);
        assert.equal(Object.hasOwn(r, "range"), false);
        assert.equal(r.content, null);
    });
});

test("File.find: an exact matcher returns flat match locations", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "foo\nbar foo");
        await addMember(ctx, "f.txt");
        const r = await new File().find(
            findStmt(urlPath("file", "/f.txt"), { dialect: "regex", raw: "/foo/g", pattern: "foo", flags: "g" }),
            ctx,
        );
        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "application/json");
        assert.ok(r.results.length > 0);
        assert.equal(r.matchingPathCount, 1);
    });
});

test("File.find: a binary member does not poison a body search across readable members", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "readme.md"), "the needle is here\n");
        await addMember(ctx, "readme.md");
        await EntryCrud.writeEntry(
            "blob.bin",
            { channels: { body: { content: "", mimetype: "application/octet-stream" } }, tags: [] },
            ctx,
            "file",
        );

        const result = await new File().find(parseFind("## FIND1 (**)\n/needle/"), ctx);
        assert.equal(result.status, 200);
        assert.deepEqual(result.results.map(({ path }) => path), ["readme.md"]);
    });
});

test("File.find: an invalid matcher preserves the matcher Problem", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "alpha\nbeta\n");
        await addMember(ctx, "f.txt");
        const r = await new File().find(
            findStmt(urlPath("file", "/f.txt"), { dialect: "regex", raw: "/[/", pattern: "[", flags: "" }),
            ctx,
        );
        assert.equal(r.status, 400);
        assert.equal(r.problem?.type, "https://problems.plurnk.dev/schemes/matcher/invalid-expression");
        assert.equal(r.problem?.stage, "matcher");
        assert.equal(r.problem?.dialect, "regex");
        assert.equal(r.problem?.recovery, "Correct or remove the matcher.");
        assert.equal(r.problem?.retryable, false);
        assert.equal(r.content, null);
    });
});

test("File.find: an invalid matcher exposes stable cause and recovery facts", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "f.json"), "{\"answer\":42}\n");
        await addMember(ctx, "f.json");
        const r = await new File().find(
            findStmt(urlPath("file", "/f.json"), { dialect: "jsonpath", raw: "$.[" }),
            ctx,
        );
        assert.equal(r.status, 400);
        assert.equal(r.problem?.stage, "matcher");
        assert.equal(r.problem?.dialect, "jsonpath");
        assert.equal(r.problem?.detail, "The jsonpath matcher expression is invalid.");
        assert.equal(r.problem?.recovery, "Correct or remove the matcher.");
        assert.equal(r.problem?.retryable, false);
        assert.equal("expression" in (r.problem ?? {}), false);
    });
});

test("File.find: matcher evaluates the full resource before <L> pages locations", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "alpha\nprojected\nfoo later\n");
        await addMember(ctx, "f.txt");
        const r = await new File().find(
            findStmt(urlPath("file", "/f.txt"), { dialect: "regex", raw: "/foo/g", pattern: "foo", flags: "g" }),
            ctx,
        );
        assert.equal(r.status, 200);
        assert.ok(r.results.length > 0);
        assert.equal(r.range?.unit, "matchLocation");
    });
});

test("File.find: a zero-match selector returns 204", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "alpha\nbeta\n");
        await addMember(ctx, "f.txt");
        const r = await new File().find(
            findStmt(urlPath("file", "/f.txt"), { dialect: "regex", raw: "/EVALUATOR_FUNCTIONS/", pattern: "EVALUATOR_FUNCTIONS", flags: "" }),
            ctx,
        );
        assert.equal(r.status, 204);
        assert.equal(r.problem, undefined);
    });
});

test("File.read: non-empty tag filter on file:/// returns 404 (no tag concept)", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "x");
        await addMember(ctx, "f.txt");
        // Entry exists, but file entries carry no tags → a tag-filtered read 404s
        // via the shared EntryOps tag gate.
        const r = await readFileScheme(readStmt(urlPath("file", "/f.txt"), { tags: ["any"] }), ctx);
        assert.equal(r.status, 404);
    });
});

test("File.read: long content round-trips", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const big = "lorem ipsum dolor sit amet ".repeat(1000);
        await writeFile(join(root, "big.txt"), big);
        await addMember(ctx, "big.txt");
        const result = await readFileScheme(readStmt(urlPath("file", "/big.txt")), ctx);
        assert.equal(result.status, 200);
        assert.equal(result.content?.length, big.length);
    });
});

test("File.read: a host-absolute spelling does not exist in the jail — no fold, deterministic 404", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "abs.txt"), "abs content");
        const absolutePath = resolve(root, "abs.txt");
        await addMember(ctx, "abs.txt");
        // {§fs-namespace} — chroot semantics: the host path /tmp/.../abs.txt canonicalizes to
        // the bare key tmp/.../abs.txt, which is not a member. The old exec-echo fold was
        // run59-class existence-dependent resolution; the model uses the catalog's key.
        const result = await readFileScheme(readStmt(urlPath("file", absolutePath)), ctx);
        assert.equal(result.status, 404, "host paths are not addresses inside the namespace");
    });
});

test("File.read: bare relative path (no leading slash) normalizes to the member key and resolves", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "notes.md"), "Codename: Bluejay\n");
        await addMember(ctx, "notes.md");
        // The member is keyed "/notes.md", but the model naturally types the bare "notes.md"
        // it copies from the catalog. READ must resolve it the way WRITE does — the regression
        // that 404'd "read the codename from notes.md" against the live model.
        const result = await readFileScheme(parseRead("## READ1 (notes.md)"), ctx);
        assert.equal(result.status, 200, "bare relative READ resolves to the /notes.md member, not 404");
        assert.equal(result.content, "Codename: Bluejay\n");
    });
});

test("File.read: markerless exact READ returns 16 lines and explicit <1,-1> returns all", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const content = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
        await writeFile(join(root, "bounded.txt"), content);
        await addMember(ctx, "bounded.txt");

        const bounded = await readFileScheme(parseRead("## READ1 (bounded.txt)"), ctx);
        assert.equal(bounded.status, 200);
        assert.equal(bounded.content, Array.from({ length: 16 }, (_, index) => `line ${index + 1}`).join("\n"));
        assert.equal(bounded.range?.total, 20);
        assert.deepEqual(bounded.range?.returned, [1, 16]);

        const all = await readFileScheme(parseRead("## READ1 (bounded.txt) <1,-1>"), ctx);
        assert.equal(all.status, 200);
        assert.equal(all.content, content);
        assert.deepEqual(all.range?.returned, [1, 20]);
    });
});

test("File.read: bare nested relative path resolves to its member key too", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await mkdir(join(root, "src"));
        await writeFile(join(root, "src", "app.js"), "// TODO: rename\n");
        await addMember(ctx, "src/app.js");
        const result = await readFileScheme(parseRead("## READ1 (src/app.js)"), ctx);
        assert.equal(result.status, 200, "bare nested relative READ resolves");
        assert.equal(result.content, "// TODO: rename\n");
    });
});

test("File.read: absolute path OUTSIDE workspace → 404 (never a member)", async () => {
    await withWorkspaceRoot(async (_root, ctx) => {
        const outside = await mkdtemp(join(tmpdir(), "plurnk-outside-"));
        try {
            const outsideFile = join(outside, "leak.txt");
            await writeFile(outsideFile, "should not be readable");
            const result = await readFileScheme(readStmt(urlPath("file", outsideFile)), ctx);
            // An outside-root path can never be materialized → no entry → 404.
            assert.equal(result.status, 404);
            assert.equal(result.content, null);
        } finally { await rm(outside, { recursive: true, force: true }); }
    });
});

// {§membership-change-gated-sync} — rematerialization refreshes both content and extent.
test("{§membership-change-gated-sync}: a grown file exposes newly valid lines and its current extent", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "grow.txt"), "l1\nl2\nl3\n");
        await addMember(ctx, "grow.txt");
        // A read at line 6 is out of range NOW (3 lines) — the pre-growth 416.
        const before = await readFileScheme(readStmt(urlPath("file", "/grow.txt"), { lineMarker: { marks: [6] } }), ctx);
        assert.equal(before.status, 416, "line 6 is out of range on the 3-line file");

        // Grow the file to 8 lines and re-materialize.
        await writeFile(join(root, "grow.txt"), "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n");
        await addMember(ctx, "grow.txt");

        // The same read now succeeds against the refreshed snapshot.
        const after = await readFileScheme(readStmt(urlPath("file", "/grow.txt"), { lineMarker: { marks: [6] } }), ctx);
        assert.equal(after.status, 200, "line 6 reads after the growth — the entry's length tracks disk, not a stale duplicate row");
        assert.equal(after.content, "l6");

        // An over-EOF read names the refreshed line count per {§fs-errno}.
        // A trailing newline is a terminator, not a ninth addressable line; the
        // advertised extent and the slicer's actual address space are identical.
        const over = await readFileScheme(readStmt(urlPath("file", "/grow.txt"), { lineMarker: { marks: [99] } }), ctx);
        assert.equal(over.status, 416);
        const range = over.problem?.range as { total?: number };
        assert.equal(range.total, 8, "the range fact carries the refreshed line count");
    });
});
