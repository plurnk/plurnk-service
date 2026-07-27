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
import { PlurnkParser } from "@plurnk/plurnk-grammar";
import type { FindStatement, ReadStatement, EditStatement, PlurnkStatement } from "@plurnk/plurnk-grammar";
import type { Db } from "../../src/core/Db.ts";
import type { PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import File from "../../src/schemes/File.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import { MimetypeBinary } from "../../src/content/index.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, DEFAULT_MIMETYPES } from "./_helpers.ts";

// Parse one op the way production does, so a bare path carries its REAL parsed shape
// (LocalPath {kind:"local"}) — the exact thing the model emits, not a hand-built UrlPath.
const parseOp = <T extends PlurnkStatement>(dsl: string, op: T["op"]): T => {
    const found = PlurnkParser.parse(`<<PLAN::PLAN\n${dsl}`).items.find((i) => i.kind === "statement" && i.statement.op === op);
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
    await EntryCrud.writeEntry(`${pathname}`, { channels: { body: { content, mimetype } }, tags: [] }, ctx, "file");
};

const withWorkspaceRoot = async (fn: (root: string, ctx: PlurnkSchemeContext, db: Db) => Promise<void>): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-uri-"));
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `uri-${crypto.randomUUID()}`);
        await db.test_set_session_project_root.run({ id: workspaceId, project_root: root });
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

// ── Path resolution: every op normalizes a bare model path to the canonical member key ──

// CELL [FIND × bare local path]. The member is stored `/notes.md`; the model FINDs
// `notes.md`. FIND must canonicalize and select the member — exactly as READ does.
// RED until Stage 2 (File.find delegates raw → scope glob `notes.md*` misses `/notes.md`).
test("contract: FIND(bare path) resolves the canonical-stored member", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "notes.md"), "the codename is phoenix\n");
        await addMember(ctx, "notes.md");
        const stmt = parseOp<FindStatement>("<<FIND(notes.md)::FIND", "FIND");
        const result = await new File().find(stmt, ctx);
        assert.equal(result.status, 200, "FIND succeeds");
        assert.ok(result.results.some((r) => r.path === "notes.md"), `FIND must find the member (catalog renders it bare: notes.md); got: ${JSON.stringify(result.results.map((r) => r.path))}`);
    });
});

// CONTROL [READ × bare local path]. Same condition, the op that already canonicalizes —
// proves the harness reproduces the real path and isolates FIND as the drift (this passes today).
test("contract: READ(bare path) resolves the canonical-stored member (control — already correct)", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "notes.md"), "the codename is phoenix\n");
        await addMember(ctx, "notes.md");
        const stmt = parseOp<ReadStatement>("<<READ(notes.md)::READ", "READ");
        const result = await new File().read(stmt, ctx);
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
        const stmt = parseOp<EditStatement>("<<EDIT(notes.md)<1,-1>:the codename is dragon:EDIT", "EDIT");
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
        const stmt = parseOp<FindStatement>("<<FIND(/notes.md)::FIND", "FIND");
        const result = await new File().find(stmt, ctx);
        assert.ok(result.results.some((r) => r.path === "notes.md"), `the leading-slash form finds it; got: ${JSON.stringify(result.results.map((r) => r.path))}`);
    });
});

// ── §matcher-result: READ returns matching LINES, uniformly. A matcher SELECTS; READ
// returns the source line(s) at the match. regex matches (never extracts); glob, jsonpath,
// xpath all select lines. One shape across every dialect. ──

// {§matcher-result-read-returns-lines} — DEFERRED-RED until Stage 2. A regex SELECTS the
// lines it occurs in; READ returns the LINE, not the matched substring. Today the matcher
// renders `<line>:<matched-value>` (the token `phoenix`); the contract wants the line.
test("a regex READ returns the matching LINE, not the substring", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "notes.md"), "the codename is phoenix\n");
        await addMember(ctx, "notes.md");
        const stmt = parseOp<ReadStatement>("<<READ(notes.md):#phoenix#:READ", "READ");
        const result = await new File().read(stmt, ctx);
        assert.match(result.content ?? "", /the codename is phoenix/, `regex READ returns the whole LINE; got: ${JSON.stringify(result.content)}`);
    });
});

// COVERAGE — glob already meets the contract (proof the uniform line-return is achievable):
// it returns whole matching lines with their non-sequential source numbers. GREEN today.
test("contract: a glob READ returns whole matching lines with non-sequential source numbers ()", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "log.md"), "alpha\ntarget one\nbeta\ngamma\ntarget two\n");
        await addMember(ctx, "log.md");
        const stmt = parseOp<ReadStatement>("<<READ(log.md):*target*:READ", "READ");
        const result = await new File().read(stmt, ctx);
        const content = result.content ?? "";
        assert.match(content, /2:target one/, `glob returns line 2 whole; got: ${JSON.stringify(content)}`);
        assert.match(content, /5:target two/, `glob returns line 5 whole; got: ${JSON.stringify(content)}`);
    });
});

// CELL [READ × jsonpath] — GREEN: the plugin reports each structural hit's source-line
// provenance. Per §matcher-result, jsonpath SELECTS the line where the path resolves; READ
// returns that LINE (`  "host": "db.internal",`), not the bare value. Today it returns the
// value, and the structural match carries no source line — so this can't go green until the
// plugin reports the line span of each jsonpath hit (the coordination the owner flagged).
test("contract: a jsonpath READ returns the LINE where the path resolves", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "config.json"), '{\n  "host": "db.internal",\n  "pool": 5\n}\n');
        await addMember(ctx, "config.json");
        const stmt = parseOp<ReadStatement>("<<READ(config.json):$.host:READ", "READ");
        const result = await new File().read(stmt, ctx);
        assert.match(result.content ?? "", /"host": "db\.internal"/, `jsonpath READ returns the LINE; got: ${JSON.stringify(result.content)}`);
    });
});

// CELL [FIND × file scheme glob] — the tracked-file list. This is what the turn-0 catalog
// preview foists (FIND(file:///**)); confirm it lists every member, and that the bare FIND(**)
// (no scheme → file) is the same view. #287
test("contract: FIND(file:///**) and bare FIND(**) both list every tracked member", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "a.md"), "alpha");
        await mkdir(join(root, "docs"), { recursive: true });
        await writeFile(join(root, "docs/b.md"), "beta");
        await addMember(ctx, "a.md");
        await addMember(ctx, "docs/b.md");
        for (const dsl of ["<<FIND(file:///**)::FIND", "<<FIND(**)::FIND"]) {
            const r = await new File().find(parseOp<FindStatement>(dsl, "FIND"), ctx);
            assert.equal(r.status, 200, `${dsl} → 200`);
            assert.equal(r.results.length, 2, `${dsl} lists both tracked members`);
            const paths = r.results.map((x) => x.path).join(" ");
            assert.match(paths, /a\.md/, `${dsl} includes a.md`);
            assert.match(paths, /b\.md/, `${dsl} includes docs/b.md`);
        }
    });
});
