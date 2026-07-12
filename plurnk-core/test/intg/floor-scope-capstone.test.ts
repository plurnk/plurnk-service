// Floor-scope capstone — drives the non-EXEC entry DSL ops end-to-end through the
// canonical grammar parser, real Engine, real SchemeRegistry, real SqlRite.

import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-grammar";
import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, seedEnvelope, DEFAULT_MIMETYPES } from "./_helpers.ts";

const parse = (dsl: string): PlurnkStatement[] => {
    // grammar 0.70: turns lead with PLAN; prefix it (when absent) and strip it back out.
    const result = PlurnkParser.parse(dsl.startsWith("<<PLAN") ? dsl : `<<PLAN::PLAN\n${dsl}`);
    return result.items
        .filter((i) => i.kind === "statement")
        .map((i) => (i as { kind: "statement"; statement: PlurnkStatement }).statement)
        .filter((s) => s.op !== "PLAN");
};

test("Floor-scope capstone: full DSL surface exercised end-to-end", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, "capstone-ws");
    // FIND body matchers now run content through the mimetypes daughter,
    // so the end-to-end engine needs a real (discovering) Mimetypes — same as the
    // daemon wires in production; the bare default has no handlers.
    await DEFAULT_MIMETYPES.ready();
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });

    const dispatch = async (statement: PlurnkStatement, sequence: number) =>
        engine.dispatch({ statement, ...env, sequence, origin: "client" });

    try {
        const [editUnknown] = parse("<<EDIT[geography,question](unknown:///france/capital):what is the capital of france?:EDIT");
        const r1 = await dispatch(editUnknown, 1);
        assert.equal(r1.status, 201);
        const unknownEntryId = r1.entryId as number;
        assert.ok(typeof unknownEntryId === "number");

        const channels1 = await (db.test_list_channel_names as PrepMethod).all<{ name: string }>({ entry_id: unknownEntryId });
        assert.deepEqual(channels1.map((c) => c.name), ["body"]);

        const [editUnknownAgain] = parse("<<EDIT[geography](unknown:///france/capital):rephrased question:EDIT");
        const r2 = await dispatch(editUnknownAgain, 2);
        assert.equal(r2.status, 200);
        assert.equal(r2.entryId, unknownEntryId);
        const body2 = (await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: unknownEntryId, name: "body" }))?.content;
        assert.equal(body2, "rephrased question");

        const [copyOp] = parse("<<COPY[answer,france](unknown:///france/capital):known:///france/capital:COPY");
        const r3 = await dispatch(copyOp, 3);
        assert.equal(r3.status, 201);

        const knownEntry = await (db.test_get_entry_id_by_scheme_pathname as PrepMethod).get<{ id: number }>({ scheme: "known", pathname: "/france/capital" });
        const knownEntryId = knownEntry!.id;
        const knownTags = (await (db.test_list_entry_tags as PrepMethod).all<{ tag: string }>({ entry_id: knownEntryId })).map((t) => t.tag);
        assert.deepEqual(knownTags, ["answer", "france"]);

        const [editKnown] = parse("<<EDIT(known:///france/capital):Paris:EDIT");
        const r4 = await dispatch(editKnown, 4);
        assert.equal(r4.status, 200);
        const knownBody = (await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: knownEntryId, name: "body" }))?.content;
        assert.equal(knownBody, "Paris");

        const [findByTag] = parse("<<FIND[answer](known:///)::FIND");
        const r6 = await dispatch(findByTag, 5);
        assert.equal(r6.status, 200);
        assert.deepEqual([...new Set((r6.results as { path: string }[]).map((f) => f.path))], ["known:///france/capital"]);

        // glob body matches CONTENT (the entry's body is "Paris"), not the pathname.
        const [findByGlob] = parse("<<FIND(known:///):Paris*:FIND");
        const r7 = await dispatch(findByGlob, 6);
        assert.equal(r7.status, 200);
        assert.deepEqual([...new Set((r7.results as { path: string }[]).map((f) => f.path))], ["known:///france/capital"]);

        const [moveOp] = parse("<<MOVE(known:///france/capital):known:///archive/france/capital:MOVE");
        const r10 = await dispatch(moveOp, 9);
        assert.equal(r10.status, 201);
        const oldGone = await (db.test_get_entry_id_by_scheme_pathname as PrepMethod).get<{ id: number }>({ scheme: "known", pathname: "/france/capital" });
        assert.equal(oldGone, undefined);
        const archive = await (db.test_get_entry_id_by_scheme_pathname as PrepMethod).get<{ id: number }>({ scheme: "known", pathname: "/archive/france/capital" });
        const archiveBody = (await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: archive?.id, name: "body" }))?.content;
        assert.equal(archiveBody, "Paris");

        const [deleteOp] = parse("<<SEND[410](unknown:///france/capital)::SEND");
        const r11 = await dispatch(deleteOp, 10);
        assert.equal(r11.status, 200);
        const unknownGone = await (db.test_get_entry_id_by_scheme_pathname as PrepMethod).get<{ id: number }>({ scheme: "unknown", pathname: "/france/capital" });
        assert.equal(unknownGone, undefined);

        const [sendTerminal] = parse("<<SEND[200]:answer delivered:SEND");
        const r12 = await dispatch(sendTerminal, 11);
        assert.equal(r12.status, 200);
        const loopStatus = (await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: env.loopId }))?.status;
        assert.equal(loopStatus, 200);

        const allEntries = (await (db.test_list_entries_by_session_session_pathname as PrepMethod).all<{ scheme: string; pathname: string }>({ session_id: env.sessionId })).map((r) => ({ scheme: r.scheme, pathname: r.pathname }));
        assert.deepEqual(allEntries, [{ scheme: "known", pathname: "/archive/france/capital" }]);

        const logCount = (await (db.test_count_log_entries_by_run as PrepMethod).get<{ n: number }>({ run_id: env.runId }))?.n;
        assert.equal(logCount, 9);

        const clientLogCount = (await (db.test_count_log_entries_run_origin as PrepMethod).get<{ n: number }>({ run_id: env.runId, origin: "client" }))?.n;
        assert.equal(clientLogCount, 9);
    } finally { await db.close(); }
});
