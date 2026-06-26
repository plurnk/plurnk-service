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
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import type { PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import File from "../../src/schemes/File.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import { MimetypeBinary } from "../../src/content/index.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, DEFAULT_MIMETYPES } from "./_helpers.ts";

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
    const row = await (ctx.db.envelope_get_session as PrepMethod).get<{ project_root: string }>({ id: ctx.sessionId });
    const canonical = join(row?.project_root ?? "", pathname);
    const mimetype = MimetypeBinary.normalizeAutoTextMimetype(await ctx.mimetypes.detect({ path: canonical }));
    const content = await readFile(canonical, "utf8");
    await EntryCrud.writeEntry(`/${pathname}`, { channels: { body: { content, mimetype } }, tags: [] }, ctx, null);
};

const withSessionWorkspace = async (fn: (root: string, ctx: PlurnkSchemeContext, db: Db) => Promise<void>): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-uri-"));
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `uri-${crypto.randomUUID()}`);
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

// ── Path resolution: every op normalizes a bare model path to the canonical member key ──

// CELL [FIND × bare local path]. The member is stored `/notes.md`; the model FINDs
// `notes.md`. FIND must canonicalize and select the member — exactly as READ does.
// RED until Stage 2 (File.find delegates raw → scope glob `notes.md*` misses `/notes.md`).
test("contract: FIND(bare path) resolves the canonical-stored member", async () => {
    await withSessionWorkspace(async (root, ctx) => {
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
    await withSessionWorkspace(async (root, ctx) => {
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
    await withSessionWorkspace(async (root, ctx) => {
        await writeFile(join(root, "notes.md"), "the codename is phoenix\n");
        await addMember(ctx, "notes.md");
        const stmt = parseOp<EditStatement>("<<EDIT(notes.md):the codename is dragon:EDIT", "EDIT");
        const result = await new File().edit(stmt, ctx);
        assert.equal(result.status, 202, `EDIT canonicalizes the bare path → proposal; got ${result.status} ${"error" in result ? result.error : ""}`);
    });
});

// ISOLATOR [FIND × leading-slash path]. The SAME FIND that fails on `notes.md` succeeds
// on `/notes.md` — pinning the defect to the missing leading-slash canonicalization, not
// FIND's matcher or candidate logic. GREEN today: proves the one-character fix is the fix.
test("contract: FIND(/leading-slash) resolves the member — isolates the missing canonicalization", async () => {
    await withSessionWorkspace(async (root, ctx) => {
        await writeFile(join(root, "notes.md"), "the codename is phoenix\n");
        await addMember(ctx, "notes.md");
        const stmt = parseOp<FindStatement>("<<FIND(/notes.md)::FIND", "FIND");
        const result = await new File().find(stmt, ctx);
        assert.ok(result.results.some((r) => r.path === "notes.md"), `the leading-slash form finds it; got: ${JSON.stringify(result.results.map((r) => r.path))}`);
    });
});

// ── Matcher rendering: a regex match returns the matching LINE, numbered once ──

// CONTROL [READ × regex]. Per §matcher-result, a bare regex extracts the matched VALUE
// (substring) — NOT the line. This is the contract; gemma's demo failure was choosing
// regex for a "find the lines" task when glob is the line dialect. Passes today.
test("contract: a regex READ extracts the matched value/substring (control — §matcher-result)", async () => {
    await withSessionWorkspace(async (root, ctx) => {
        await writeFile(join(root, "notes.md"), "the codename is phoenix\n");
        await addMember(ctx, "notes.md");
        const stmt = parseOp<ReadStatement>("<<READ(notes.md):#phoenix#:READ", "READ");
        const result = await new File().read(stmt, ctx);
        assert.match(result.content ?? "", /phoenix/, `regex extracts the matched value; got: ${JSON.stringify(result.content)}`);
    });
});

// CELL [READ × glob, multiple matches]. Per §matcher-result, glob returns the WHOLE matching
// lines with their original (non-sequential) source line numbers — the "matching lines" the
// model wants. Pattern hits lines 2 and 5; expect `2:\ttarget one` and `5:\ttarget two`.
test("contract: a glob READ returns whole matching lines with non-sequential source numbers (§matcher-result)", async () => {
    await withSessionWorkspace(async (root, ctx) => {
        await writeFile(join(root, "log.md"), "alpha\ntarget one\nbeta\ngamma\ntarget two\n");
        await addMember(ctx, "log.md");
        const stmt = parseOp<ReadStatement>("<<READ(log.md):*target*:READ", "READ");
        const result = await new File().read(stmt, ctx);
        const content = result.content ?? "";
        assert.match(content, /2:\ttarget one/, `glob returns line 2 whole; got: ${JSON.stringify(content)}`);
        assert.match(content, /5:\ttarget two/, `glob returns line 5 whole; got: ${JSON.stringify(content)}`);
    });
});

// CONTROL [READ × jsonpath]. For a STRUCTURED matcher the value is what you want —
// `$.host` → `db.internal`. The `<line>:\t<value>` form is correct here (passes today),
// which is exactly why it's wrong to reuse it verbatim for regex.
test("contract: a jsonpath READ returns the extracted value (control — value is correct for structured)", async () => {
    await withSessionWorkspace(async (root, ctx) => {
        await writeFile(join(root, "config.json"), JSON.stringify({ host: "db.internal", pool: 5 }));
        await addMember(ctx, "config.json");
        const stmt = parseOp<ReadStatement>("<<READ(config.json):$.host:READ", "READ");
        const result = await new File().read(stmt, ctx);
        assert.match(result.content ?? "", /db\.internal/, `jsonpath returns the value; got: ${JSON.stringify(result.content)}`);
    });
});
