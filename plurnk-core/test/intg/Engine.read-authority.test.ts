import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePath, PlurnkParser, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import { Results, type SchemeHandler } from "@plurnk/plurnk-schemes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import LineAnchors from "../../src/content/line-anchors.ts";
import type { AnchoredReadResult } from "../../src/content/read-projector.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import Worker from "../../src/schemes/Worker.ts";
import { editStmt } from "./_dsl.ts";
import { DEFAULT_MIMETYPES, insertOperationTurn, insertWorker, makeSchemeCtx, openMigrated, rootWorkspace, seedEntryWithChannel, seedEnvelope, fixtureExecutors } from "./_helpers.ts";

const source = "first\nsecond\nthird";
const runtime = async (t: TestContext) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const ids = await seedEnvelope(db, `read-authority-${crypto.randomUUID()}`);
    const harnessTurn = await insertOperationTurn(db, ids.loopId, 2, "_plurnk");
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    let sequence = 0;
    const run = async (program: string, origin: "model" | "_plurnk" = "model") => {
        const parsed = PlurnkParser.parseClient(program, { executors: fixtureExecutors(program) });
        assert.equal(parsed.items.length, 1, program);
        const item = parsed.items[0];
        assert.equal(item?.kind, "statement", program);
        if (item?.kind !== "statement") throw new Error("Expected one operation");
        return engine.dispatch({ ...ids, turnId: origin === "model" ? ids.turnId : harnessTurn,
            sequence: ++sequence, origin, statement: item.statement as PlurnkStatement });
    };
    const read = async (target: string, origin: "model" | "_plurnk" = "model") =>
        Results.assertReadResult(await run(`\`\`\`READ (${target}) <1,-1>\`\`\``, origin)) as AnchoredReadResult;
    const seed = async (ownerId: number, target: string) => {
        const result = await new Worker().edit(editStmt(parsePath(target), source), makeSchemeCtx({
            db, workspaceId: ids.workspaceId, workerId: ownerId, writer: "_plurnk",
        }));
        assert.equal(result.status, 201);
    };
    return { db, ids, schemes, run, read, seed };
};

const assertProjection = (read: AnchoredReadResult, editable: boolean) => {
    assert.equal(read.status, 200);
    assert.equal(read.content, source);
    assert.equal(Object.hasOwn(read, "lineAnchors"), editable);
    if (editable) assert.equal(read.lineAnchors?.length, 3);
    const wire = PacketWire.renderLog([{ coordinate: "1/1/1", op: "READ", origin: "_plurnk",
        status: read.status, rx: read, lineAnchors: read.lineAnchors, lineNumberWidth: read.lineNumberWidth }], contentWeight);
    assert.match(wire, /1:first/);
    if (editable) assert.match(wire, /@[0-9A-Za-z]{5} +1:first/);
    else assert.doesNotMatch(wire, /@[0-9A-Za-z]{5} +\d+:/);
};

for (const mode of ["writable", "read-only", "unresolved", "unavailable"] as const) {
    test(`{§line-anchor-write-authority}: plugin ${mode} resolution governs publication without hiding internal failure`, async (t) => {
        const { db, ids, schemes, read } = await runtime(t);
        const calls: unknown[] = [];
        const unavailable = Results.failure("scheme:authority", "authority-unavailable", 500, "Write authority could not be resolved.");
        assert.ok(unavailable.problem);
        const scheme: SchemeHandler = {
            manifest: {
                name: "authority", authority: "namespace", category: "data",
                channels: { body: "text/plain" }, defaultChannel: "body",
                writableBy: ["model", "_plurnk"], textEditScopes: true, volatile: false, modelVisible: true,
            },
            resolveEntryAddress: async (_target, ctx, access) => {
                calls.push([access, ctx.writer]);
                if (access === "write") {
                    if (mode === "read-only") return Results.failure("scheme:authority", "read-only", 403, "The resource is read-only.");
                    if (mode === "unresolved") return null;
                    if (mode === "unavailable") return unavailable;
                }
                return { authority: "", pathname: "/entry" };
            },
        };
        schemes.register("authority", scheme);
        await seedEntryWithChannel(db, { workspaceId: ids.workspaceId, scheme: "authority", pathname: "/entry",
            channel: "body", content: source, mimetype: "text/plain" });
        for (const origin of ["model", "_plurnk"] as const) {
            calls.length = 0;
            const result = await read("authority:///entry", origin);
            assert.deepEqual(calls, [["read", origin], ["write", "model"]]);
            if (mode === "unavailable") {
                assert.equal(result.status, 500);
                assert.equal(result.problem?.type, unavailable.problem.type);
                assert.equal(result.problem?.detail, unavailable.problem.detail);
                assert.equal(result.content, null, "a failed authority service is not disguised as a successful read-only projection");
            } else assertProjection(result, mode === "writable");
        }
    });
}

for (const { target, editable, problem } of [

    { target: "worker:///note.md", editable: true, problem: null },
    { target: "worker://peer/note.md", editable: true, problem: null },
    { target: "worker:///_plurnk/tools/example.md", editable: true, problem: null },
    { target: "worker:///_plurnk/tools/example.md", editable: true, problem: null },
]) {
    test(`{§line-anchors}: ${target} publishes only its resource's model edit authority`, async (t) => {
        const { db, ids, run, read, seed } = await runtime(t);
        const peer = await insertWorker(db, ids.workspaceId, null, "peer");
        await seed(target.includes("//peer/") ? peer : ids.workerId, target);
        for (const origin of ["model", "_plurnk"] as const) assertProjection(await read(target, origin), editable);
        if (editable) {
            const anchor = (await read(target)).lineAnchors![1];
            assert.equal((await run(`\`\`\`EDIT (${target}) <${anchor}>\nchanged\n\`\`\``)).status, 200);
            assert.equal((await read(target)).content, "first\nchanged\nthird");
        } else {
            for (const scope of ["<1>", "<@abcde>"]) {
                const denied = await run(`\`\`\`EDIT (${target}) ${scope}\nchanged\n\`\`\``);
                assert.equal(denied.status, 403);
                assert.equal(denied.problem?.type, `https://problems.plurnk.xyz/scheme/worker/${problem}`);
            }
            assert.equal((await read(target)).content, source);
        }
    });
}

test("{§line-anchors}: harness edits retain internal coordinate validation and publish generated-document edit anchors", async (t) => {
    const { ids, seed, read, run } = await runtime(t);
    const target = "worker:///_plurnk/tools/example.md";
    await seed(ids.workerId, target);
    const original = await read(target);
    assertProjection(original, true);
    assert.equal(typeof original.lineAnchorIdentity, "string");
    const anchor = LineAnchors.tokens(original.lineAnchorIdentity!, source)[1];
    const changed = await run(`\`\`\`EDIT (${target}) <${anchor}>\nupdated\n\`\`\``, "_plurnk");
    assert.equal(changed.status, 200);
    const current = await read(target);
    assert.equal(current.content, "first\nupdated\nthird");
    assert.equal(Object.hasOwn(current, "lineAnchors"), true);
});

test("{§line-anchors}: file READ and EDIT share root and mounted-member write authority", async (t) => {
    const parent = await mkdtemp(join(tmpdir(), "plurnk-read-authority-"));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const root = join(parent, "project");
    await mkdir(root);
    const { db, ids, read, run } = await runtime(t);
    await rootWorkspace(db, ids.workspaceId, root);

    const ctx = makeSchemeCtx({ ...ids, db });
    for (const { path, origin, editable } of [
        { path: "local.md", origin: "git", editable: true },
        { path: "../mounted.md", origin: "git", editable: false },
        { path: "../picked.md", origin: "constraint", editable: true },
    ]) {
        await writeFile(join(root, path), source);
        await db.crud_register_workspace_member.get({ workspace_id: ids.workspaceId, scheme: "file", authority: "", pathname: path, membership_origin: origin });
        await EntryCrud.writeEntry({ authority: "", pathname: path }, { channels: {
            body: { content: source, mimetype: "text/markdown" },
        } }, ctx, "file");
        assertProjection(await read(path), editable);
        if (!editable) {
            const denied = await run(`\`\`\`EDIT (${path}) <@abcde>\nchanged\n\`\`\``);
            assert.equal(denied.status, 403);
            assert.equal(denied.problem?.type, "https://problems.plurnk.xyz/scheme/file/member-read-only");
            const killed = await run(PlurnkParser.frame(`KILL (${path})`, null));
            assert.equal(killed.status, 403, JSON.stringify(killed));
            assert.equal(killed.problem?.type, denied.problem?.type, "the same member write authority governs deletion");
        }
        assert.equal(await readFile(join(root, path), "utf8"), source, "READ and refused EDIT have no disk effects");
    }
});
