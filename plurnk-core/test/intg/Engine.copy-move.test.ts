// Tests for SPEC {§copy} (Engine.copy orchestration) and {§move} (Engine.move).

import test from "node:test";
import assert from "node:assert/strict";
import type { CopyStatement, MoveStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Worker from "../../src/schemes/Worker.ts";
import { openMigrated, seedEnvelope, makeSchemeCtx } from "./_helpers.ts";
import { urlPath, localPath, editStmt, copyStmt, moveStmt, fullReplace } from "./_dsl.ts";

const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, ...env, engine };
};

const dispatch = async (engine: Engine, env: { workspaceId: number; workerId: number; loopId: number; turnId: number }, statement: CopyStatement | MoveStatement) => {
    return await engine.dispatch({
        statement, ...env, sequence: 1, origin: "client",
    });
};

test("Engine.copy copies the default channel", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/france/capital"), "Paris"), makeSchemeCtx({ db, workspaceId, workerId }));

        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, copyStmt(urlPath("worker", "/france/capital"), urlPath("worker", "/europe/france")));
        assert.equal(r.status, 201);

        const dst = await db.test_get_entry_by_pathname_scheme.get<{ scheme: string; pathname: string }>({ pathname: "/europe/france", scheme: "worker" });
        assert.equal(dst?.scheme, "worker");
        const channel = await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/europe/france", name: "body" });
        assert.equal(channel?.content, "Paris");
    } finally { await db.close(); }
});

test("Engine.copy cross-scheme (worker commons → skill)", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/topic"), "open question"), makeSchemeCtx({ db, workspaceId, workerId }));

        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, copyStmt(urlPath("worker", "/topic"), urlPath("skill", "/topic")));
        assert.equal(r.status, 201);

        const dst = await db.test_get_entry_by_pathname_scheme.get<{ scheme: string }>({ pathname: "/topic", scheme: "skill" });
        assert.equal(dst?.scheme, "skill");
        const channel = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/topic", scheme: "skill", name: "body" });
        assert.equal(channel?.content, "open question");
    } finally { await db.close(); }
});

test("Engine.copy missing source returns 404", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, copyStmt(urlPath("worker", "/nope"), urlPath("worker", "/elsewhere")));
        assert.equal(r.status, 404);
        assert.equal(r.problem?.type, "https://problems.plurnk.dev/scheme/worker/entry-not-found");
        assert.equal(r.problem?.target, "worker:///nope");
    } finally { await db.close(); }
});

test("Engine.copy conflicting destination returns 409", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        const k = new Worker();
        await k.edit(editStmt(urlPath("worker", "/src"), "source body"), makeSchemeCtx({ db, workspaceId, workerId }));
        await k.edit(editStmt(urlPath("worker", "/dst"), "dest body"), makeSchemeCtx({ db, workspaceId, workerId }));

        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, copyStmt(urlPath("worker", "/src"), urlPath("worker", "/dst")));
        assert.equal(r.status, 409);
        const dstBody = (await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/dst", name: "body" }))?.content;
        assert.equal(dstBody, "dest body");
    } finally { await db.close(); }
});

test("Engine.copy to a destination already holding identical content returns 304", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        const k = new Worker();
        await k.edit(editStmt(urlPath("worker", "/src"), "same body"), makeSchemeCtx({ db, workspaceId, workerId }));
        // Three dispatches in one turn → distinct sequences (log_entries is unique on turn_id+sequence).
        const copy = (sequence: number) => engine.dispatch({ statement: copyStmt(urlPath("worker", "/src"), urlPath("worker", "/dst")), workspaceId, workerId, loopId, turnId, sequence, origin: "client" });

        const created = await copy(1);
        assert.equal(created.status, 201, "first copy creates the destination");
        assert.deepEqual(created.effects, [{
            target: "worker:///dst",
            action: "create",
        }]);
        const unchanged = await copy(2);
        assert.equal(unchanged.status, 304, "identical re-copy is a no-op, not a 409");
        assert.equal(unchanged.effects, undefined, "a no-op reports no effects");

        // Divergent destination is still a real collision; it stays untouched.
        await k.edit(editStmt(urlPath("worker", "/src"), "changed body", null, fullReplace), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal((await copy(3)).status, 409, "divergent content is a collision");
        const dstBody = (await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/dst", name: "body" }))?.content;
        assert.equal(dstBody, "same body", "collision leaves the destination untouched");
    } finally { await db.close(); }
});

test("Engine.copy classifies its durable receipt with its signal", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/src"), "x"), makeSchemeCtx({ db, workspaceId, workerId }));

        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, copyStmt(urlPath("worker", "/src"), urlPath("worker", "/dst"), ["+new", "+tags"]));
        assert.equal(r.status, 201);

        const tags = await db.test_log_tags_by_worker.all<{ coordinate: string; tag: string }>({ worker_id: workerId });
        assert.deepEqual(tags, [
            { coordinate: "1/1/1", tag: "new" },
            { coordinate: "1/1/1", tag: "tags" },
        ]);
    } finally { await db.close(); }
});

test("Engine.move relocates: source deleted, dest created", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/src"), "movable"), makeSchemeCtx({ db, workspaceId, workerId }));

        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, moveStmt(urlPath("worker", "/src"), urlPath("worker", "/dst")));
        assert.equal(r.status, 201);

        const src = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/src" });
        assert.equal(src, undefined, "source removed");

        const dstBody = (await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/dst", name: "body" }))?.content;
        assert.equal(dstBody, "movable");
    } finally { await db.close(); }
});

test("{§move-canonical-whole-source}: Engine.move treats <1,-1> as whole-channel source selection", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/src"), "movable"), makeSchemeCtx({ db, workspaceId, workerId }));

        const result = await dispatch(
            engine,
            { workspaceId, workerId, loopId, turnId },
            moveStmt(urlPath("worker", "/src"), urlPath("worker", "/dst"), null, fullReplace),
        );
        assert.equal(result.status, 201);
        assert.deepEqual(result.effects, [
            { target: "worker:///dst", action: "create" },
            { target: "worker:///src", action: "delete" },
        ]);
        assert.equal(
            await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/src" }),
            undefined,
            "the canonical whole-content marker removes the final source channel instead of hollowing it out",
        );
        const rows = await db.test_log_entries_by_loop.all<{ op: string; lineMarker: string | null }>({ loop_id: loopId });
        assert.equal(
            rows.find(({ op }) => op === "MOVE")?.lineMarker,
            JSON.stringify(fullReplace),
            "canonical cleanup does not erase the scope the model authored",
        );
    } finally { await db.close(); }
});

test("Engine.move keeps an ordinary source region regional when it covers the current content", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/src"), "only line"), makeSchemeCtx({ db, workspaceId, workerId }));

        const result = await dispatch(
            engine,
            { workspaceId, workerId, loopId, turnId },
            moveStmt(urlPath("worker", "/src"), urlPath("worker", "/dst"), null, { marks: [1] }),
        );
        assert.equal(result.status, 201);
        assert.deepEqual(
            (result.effects as Array<{ action: string }>).map(({ action }) => action),
            ["create", "update"],
        );
        const source = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/src" });
        assert.notEqual(source, undefined, "ordinary regional syntax retains the source resource");
        const channel = await db.test_get_channel.get<{ content: string }>({ entry_id: source?.id, name: "body" });
        assert.equal(channel?.content, "");
    } finally { await db.close(); }
});

test("Engine.move with no destination → 400, source survives", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/trash-me"), "stale"), makeSchemeCtx({ db, workspaceId, workerId }));

        // MOVE relocates; it never deletes. A null destination is a 400 — use KILL.
        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, moveStmt(urlPath("worker", "/trash-me"), null));
        assert.equal(r.status, 400);

        const remaining = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/trash-me" });
        assert.notEqual(remaining, undefined, "source survives — MOVE never deletes");
    } finally { await db.close(); }
});

test("Engine.move to /dev/null no longer deletes — source survives", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/obsolete"), "stale"), makeSchemeCtx({ db, workspaceId, workerId }));

        // /dev/null carries no special meaning now (KILL is the delete). It's a
        // plain relocation to an unwritable dest — it fails, and the source stays.
        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, moveStmt(urlPath("worker", "/obsolete"), localPath("/dev/null")));
        assert.notEqual(r.status, 200, "not a successful delete");

        const remaining = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/obsolete" });
        assert.notEqual(remaining, undefined, "source survives — /dev/null no longer deletes");
    } finally { await db.close(); }
});

test("Engine.move missing source returns 404", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, moveStmt(urlPath("worker", "/nope"), urlPath("worker", "/elsewhere")));
        assert.equal(r.status, 404);
    } finally { await db.close(); }
});

test("Engine.move cross-scheme (worker commons → skill) deletes source, creates dest", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/draft"), "answer"), makeSchemeCtx({ db, workspaceId, workerId }));

        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, moveStmt(urlPath("worker", "/draft"), urlPath("skill", "/answer")));
        assert.equal(r.status, 201);

        const srcRemaining = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ pathname: "/draft", scheme: "worker" });
        assert.equal(srcRemaining, undefined, "the commons source is deleted");

        const dst = await db.test_get_entry_by_pathname_scheme.get<{ scheme: string }>({ pathname: "/answer", scheme: "skill" });
        assert.equal(dst?.scheme, "skill");
    } finally { await db.close(); }
});

test("Engine.copy with <L> slices the source range into the dest, no N:\\t prefix", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/long"), "alpha\nbeta\ngamma\ndelta"), makeSchemeCtx({ db, workspaceId, workerId }));
        const stmt: CopyStatement = { ...copyStmt(urlPath("worker", "/long"), urlPath("worker", "/sliced")), lineMarker: { marks: [2, 3] } };
        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, stmt);
        assert.equal(r.status, 201);
        assert.ok(Array.isArray(r.effects));
        const [effect] = r.effects as Array<{
            action: string;
            receipt?: {
                before: number;
                after: number;
                effect: { requested: string; context: string };
            };
        }>;
        assert.equal(effect?.action, "create");
        assert.equal(effect?.receipt?.before, 0);
        assert.equal(effect?.receipt?.after, 2);
        assert.equal(effect?.receipt?.effect.requested, "<1,-1>");
        assert.match(effect?.receipt?.effect.context ?? "", /1:beta\n2:gamma/);
        const entryRow = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/sliced" });
        const dstChannel = await db.test_get_channel.get<{ content: string }>({ entry_id: entryRow?.id, name: "body" });
        assert.equal(dstChannel?.content, "beta\ngamma\n");
        // Symmetric with READ <L> but WITHOUT the N: prefix (sliceLinesRaw) — the dest is content, not a view.
        assert.doesNotMatch(dstChannel?.content ?? "", /^\d+:/, "COPY <L> writes raw lines, never the READ line-number prefix");
    } finally { await db.close(); }
});

test("Engine.copy with <L> out of range returns 416", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/src"), "only one line"), makeSchemeCtx({ db, workspaceId, workerId }));
        const stmt: CopyStatement = { ...copyStmt(urlPath("worker", "/src"), urlPath("worker", "/dst")), lineMarker: { marks: [99] } };
        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, stmt);
        assert.equal(r.status, 416);
    } finally { await db.close(); }
});

test("Engine.move with a source region removes only that region", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/orig"), "first\nsecond\nthird"), makeSchemeCtx({ db, workspaceId, workerId }));
        const stmt: MoveStatement = { ...moveStmt(urlPath("worker", "/orig"), urlPath("worker", "/moved")), lineMarker: { marks: [1, 2] } };
        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, stmt);
        assert.equal(r.status, 201);
        assert.ok(Array.isArray(r.effects));
        const effects = r.effects as Array<{
            action: string;
            receipt?: { effect: { requested: string; context: string } };
        }>;
        assert.deepEqual(effects.map(({ action }) => action), ["create", "update"]);
        assert.equal(effects[0]?.receipt?.effect.requested, "<1,-1>");
        assert.match(effects[0]?.receipt?.effect.context ?? "", /1:first\n2:second/);
        assert.equal(effects[1]?.receipt?.effect.requested, "<1,2>");
        const srcRemaining = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/orig" });
        assert.notEqual(srcRemaining, undefined, "the source entry remains");
        const srcChannel = await db.test_get_channel.get<{ content: string }>({ entry_id: srcRemaining?.id, name: "body" });
        assert.equal(srcChannel?.content, "third");
        const entryRow = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/moved" });
        const dstChannel = await db.test_get_channel.get<{ content: string }>({ entry_id: entryRow?.id, name: "body" });
        assert.equal(dstChannel?.content, "first\nsecond\n");
    } finally { await db.close(); }
});
