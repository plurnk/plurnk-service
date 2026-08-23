// Operation Semantics Contract — the coverage matrix (SCRATCH epic "Operation
// Semantics Contract"). Pins how each entry op resolves a model-typed path and how
// matchers render, so gemma can TRUST its mental model of the tooling. Tests assert
// the CORRECT contract behavior; ones that are red here name an exact, verified drift
// to fix in Stage 2 (centralize normalization + fix matcher rendering), not a guess.
//
// The condition that exposed the drift: a member is stored at its canonical key
// (`/notes.md`), but the model emits a BARE path (`notes.md`, a LocalPath). Each op
// must normalize to the canonical key before resolving. READ does (normalize-on-miss);
// EDIT does (#resolveTarget); FIND does NOT (delegates raw) — that asymmetry is the bug.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import type { FindStatement, ReadStatement, PlurnkStatement } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import type { Db } from "../../src/core/Db.ts";
import type { PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import File from "../../src/schemes/File.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import Owner from "../../src/core/Owner.ts";
import { MimetypeBinary } from "../../src/content/index.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, DEFAULT_MIMETYPES, lookThroughScheme } from "./_helpers.ts";
import { resourceGroups, resourcePaths } from "./_find.ts";

const readFileScheme = (statement: ReadStatement, ctx: PlurnkSchemeContext) =>
    lookThroughScheme("file", null, statement, ctx);

// Parse one op the way production does, so a bare path carries its REAL parsed shape
// (LocalPath {kind:"local"}) — the exact thing the model emits, not a hand-built UrlPath.
const parseOp = <T extends PlurnkStatement>(dsl: string, op: T["op"]): T => {
    const found = PlurnkParser.parse(`# PLAN0\n${dsl}`).items.find((i) => i.kind === "statement" && i.statement.op === op);
    if (found === undefined) throw new Error(`no ${op} parsed from: ${dsl}`);
    return (found as { kind: "statement"; statement: T }).statement;
};

// Materialize a file as a readable member — mirrors the git-membership pass: disk
// content into the entry's body channel under the namespace-absolute key `/${pathname}`.
const addMember = async (ctx: PlurnkSchemeContext, pathname: string): Promise<void> => {
    if (ctx.mimetypes === undefined) throw new Error("addMember: ctx.mimetypes required");
    const row = await ctx.db.envelope_get_workspace.get<{ project_root: string }>({ id: ctx.workspaceId });
    const canonical = join(row?.project_root ?? "", pathname);
    const mimetype = MimetypeBinary.normalizeAutoTextMimetype(await ctx.mimetypes.detect({ path: canonical }));
    const content = await readFile(canonical, "utf8");
    await EntryCrud.writeEntry({ authority: "", pathname: `${pathname}` }, { channels: { body: { content, mimetype } } }, ctx, "file", await Owner.commonsId(ctx.db, ctx.workspaceId));
};

const withWorkspaceRoot = async (fn: (root: string, ctx: PlurnkSchemeContext, db: Db) => Promise<void>): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-uri-"));
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `uri-${crypto.randomUUID()}`);
        await db.test_set_workspace_project_root.run({ id: workspaceId, project_root: root });
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const ctx: PlurnkSchemeContext = {
            db, workspaceId, workerId, functionalityWorkerId: workerId, loopId, turnId,
            writer: "model", signal: undefined, mimetypes: DEFAULT_MIMETYPES, weigh: (t: string) => Math.ceil(t.length / 4),
        };
        await fn(root, ctx, db);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
};

// ── Path resolution: every op normalizes a bare model path to the canonical member key ──

// CELL [FIND × bare local path]. The member is stored `/notes.md`; the model FINDs
// `notes.md`. FIND must canonicalize and select the member — exactly as READ does.
// RED until Stage 2 (File.find delegates raw → scope glob `notes.md*` misses `/notes.md`).
test("contract: FIND(bare path) resolves the canonical-stored member", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "notes.md"), "the codename is phoenix\n");
        await addMember(ctx, "notes.md");
        const stmt = parseOp<FindStatement>("## FIND0 (notes.md)", "FIND");
        const result = await new File().find(stmt, ctx);
        assert.equal(result.status, 200, "FIND succeeds");
        assert.ok(resourcePaths(result).includes("notes.md"), `FIND must find the member (catalog renders it bare: notes.md); got: ${JSON.stringify(resourcePaths(result))}`);
    });
});

// CONTROL [READ × bare local path]. Same condition, the op that already canonicalizes —
// proves the harness reproduces the real path and isolates FIND as the drift (this passes today).
test("contract: READ(bare path) resolves the canonical-stored member (control — already correct)", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "notes.md"), "the codename is phoenix\n");
        await addMember(ctx, "notes.md");
        const stmt = parseOp<ReadStatement>("## READ0 (notes.md)", "READ");
        const result = await readFileScheme(stmt, ctx);
        assert.equal(result.status, 200, "READ canonicalizes the bare path and resolves the member");
        assert.match(result.content ?? "", /phoenix/, "READ returns the member content");
    });
});

// CONTROL [EDIT × bare local path]. EDIT already canonicalizes (#resolveTarget) — a bare
// path resolves to the member and proposes (202). Confirms EDIT is not the drift.
test("contract: EDIT(bare path) resolves the canonical-stored member and proposes (control)", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "notes.md"), "the codename is phoenix\n");
        await addMember(ctx, "notes.md");
        // {§edit-marker-required-on-existing} — notes.md already exists; <1,-1> states the rewrite.
        const stmt = parseOp<ResolvedEditStatement>("## EDIT0 (notes.md) <1,-1>\nthe codename is dragon", "EDIT");
        const result = await new File().edit(stmt, ctx);
        assert.equal(result.status, 202, `EDIT canonicalizes the bare path → proposal; got ${result.status} ${result.problem?.detail ?? ""}`);
    });
});

// ISOLATOR [FIND × leading-slash path]. The SAME FIND that fails on `notes.md` succeeds
// on `/notes.md` — pinning the defect to the missing leading-slash canonicalization, not
// FIND's matcher or candidate logic. GREEN today: proves the one-character fix is the fix.
test("contract: FIND(/leading-slash) resolves the member — isolates the missing canonicalization", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "notes.md"), "the codename is phoenix\n");
        await addMember(ctx, "notes.md");
        const stmt = parseOp<FindStatement>("## FIND0 (/notes.md)", "FIND");
        const result = await new File().find(stmt, ctx);
        assert.ok(resourcePaths(result).includes("notes.md"), `the leading-slash form finds it; got: ${JSON.stringify(resourcePaths(result))}`);
    });
});

test("contract: a hash-shaped target addresses that literal path, never a pathname regex", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "#draft.*#i"), "literal hash path\n");
        await writeFile(join(root, "draft.md"), "would match the retired regex interpretation\n");
        await addMember(ctx, "#draft.*#i");
        await addMember(ctx, "draft.md");

        const stmt = parseOp<FindStatement>("## FIND0 (#draft.*#i)", "FIND");
        const result = await new File().find(stmt, ctx);

        assert.equal(result.status, 200);
        assert.deepEqual(resourcePaths(result), ["#draft.*#i"]);
    });
});

// {§find-result-projection}: exact matcher FIND exposes navigation locations.

test("an exact regex FIND returns its flat match location", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "notes.md"), "heading\nthe codename is phoenix\ncontext\n");
        await addMember(ctx, "notes.md");
        const stmt = parseOp<FindStatement>("## FIND0 (notes.md)\n/phoenix/", "FIND");
        const result = await new File().find(stmt, ctx);
        assert.equal(result.status, 200);
        assert.ok(result.results.length > 0);
    });
});

test("contract: an exact FIND returns every match as a flat location", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "log.md"), "alpha\ntarget one\nbeta\ngamma\ntarget two\n");
        await addMember(ctx, "log.md");
        const stmt = parseOp<FindStatement>("## FIND0 (log.md)\n*target*", "FIND");
        const result = await new File().find(stmt, ctx);
        assert.equal(result.status, 200);
        assert.ok(result.results.length > 0);
    });
});

test("contract: an exact jsonpath FIND returns flat structural locations", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "config.json"), '{\n  "host": "db.internal",\n  "pool": 5\n}\n');
        await addMember(ctx, "config.json");
        const stmt = parseOp<FindStatement>("## FIND0 (config.json)\n$.host", "FIND");
        const result = await new File().find(stmt, ctx);
        assert.equal(result.status, 200);
        assert.ok(result.results.length > 0);
    });
});

// CELL [FIND × file scheme glob] — the recursive tracked-file list. Confirm the explicit
// file URI and bare project-relative form expose the same view ({§path-syntax}).
test("contract: FIND(file:///**) and bare FIND(**) both list every tracked member", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "a.md"), "alpha");
        await mkdir(join(root, "docs"), { recursive: true });
        await writeFile(join(root, "docs/b.md"), "beta");
        await addMember(ctx, "a.md");
        await addMember(ctx, "docs/b.md");
        for (const dsl of ["## FIND0 (file:///**)", "## FIND0 (**)"]) {
            const r = await new File().find(parseOp<FindStatement>(dsl, "FIND"), ctx);
            assert.equal(r.status, 200, `${dsl} → 200`);
            assert.equal(r.results.length, 2, `${dsl} lists both tracked members`);
            const paths = resourcePaths(r).join(" ");
            assert.match(paths, /a\.md/, `${dsl} includes a.md`);
            assert.match(paths, /b\.md/, `${dsl} includes docs/b.md`);
        }
    });
});

test("contract: bare FIND(*) is a shallow project map; FIND(**) is recursive", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, ".env.defaults"), "defaults");
        await mkdir(join(root, ".github"), { recursive: true });
        await writeFile(join(root, ".github/settings.yml"), "settings");
        await writeFile(join(root, "README.md"), "root");
        await mkdir(join(root, "src", "nested"), { recursive: true });
        await writeFile(join(root, "src/index.ts"), "direct");
        await writeFile(join(root, "src/nested/deep.ts"), "deep");
        for (const path of [".env.defaults", ".github/settings.yml", "README.md", "src/index.ts", "src/nested/deep.ts"]) await addMember(ctx, path);

        const shallow = await new File().find(parseOp<FindStatement>("## FIND0 (*)", "FIND"), ctx);
        assert.deepEqual(resourcePaths(shallow), [".env.defaults", ".github/**", "README.md", "src/**"]);
        const scope = resourceGroups(shallow).find(([item]) => item.path === "src/**")?.[0];
        assert.ok(scope !== undefined && "items" in scope);
        assert.equal(scope.items, 2);

        const recursive = await new File().find(parseOp<FindStatement>("## FIND0 (**)", "FIND"), ctx);
        assert.deepEqual(resourcePaths(recursive), [".env.defaults", ".github/settings.yml", "README.md", "src/index.ts", "src/nested/deep.ts"]);
    });
});

test("contract: the explicit file-scheme root is a recursive collection scope", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await mkdir(join(root, "src"), { recursive: true });
        await writeFile(join(root, "src/a.ts"), "a");
        await addMember(ctx, "src/a.ts");

        const rootScope = await new File().find(parseOp<FindStatement>("## FIND0 (file:///)", "FIND"), ctx);
        assert.deepEqual(resourcePaths(rootScope), ["src/a.ts"]);
    });
});
