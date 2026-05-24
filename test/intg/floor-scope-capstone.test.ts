// Floor-scope capstone — drives every non-EXEC DSL op end-to-end through the
// canonical grammar parser, real Engine, real SchemeRegistry, real SqlRite.

import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-grammar";
import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, seedEnvelope } from "./_helpers.ts";

const parse = (dsl: string): PlurnkStatement[] => {
    const result = PlurnkParser.parse(dsl);
    return result.items
        .filter((i) => i.kind === "statement")
        .map((i) => (i as { kind: "statement"; statement: PlurnkStatement }).statement);
};

test("Floor-scope capstone: full DSL surface exercised end-to-end", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, "capstone-ws");
    const engine = new Engine({ db, schemes: new SchemeRegistry() });

    const dispatch = async (statement: PlurnkStatement, actionIndex: number) =>
        engine.dispatch({ statement, ...env, actionIndex, origin: "client" });

    try {
        const [editUnknown] = parse("<<EDIT[geography,question](unknown://france/capital):what is the capital of france?:EDIT");
        const r1 = await dispatch(editUnknown, 0);
        assert.equal(r1.status, 201);
        const unknownEntryId = r1.entryId as number;
        assert.ok(typeof unknownEntryId === "number");

        const channels1 = await (db.test_list_channel_names as PrepMethod).all<{ name: string }>({ entry_id: unknownEntryId });
        assert.deepEqual(channels1.map((c) => c.name), ["body"]);

        const [editUnknownAgain] = parse("<<EDIT[geography](unknown://france/capital):rephrased question:EDIT");
        const r2 = await dispatch(editUnknownAgain, 1);
        assert.equal(r2.status, 200);
        assert.equal(r2.entryId, unknownEntryId);
        const body2 = (await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: unknownEntryId, name: "body" }))?.content;
        assert.equal(body2, "rephrased question");

        const [copyOp] = parse("<<COPY[answer,france](unknown://france/capital):known://france/capital:COPY");
        const r3 = await dispatch(copyOp, 2);
        assert.equal(r3.status, 201);

        const knownEntry = await (db.test_get_entry_id_by_scheme_pathname as PrepMethod).get<{ id: number }>({ scheme: "known", pathname: "france/capital" });
        const knownEntryId = knownEntry!.id;
        const knownTags = (await (db.test_list_entry_tags as PrepMethod).all<{ tag: string }>({ entry_id: knownEntryId })).map((t) => t.tag);
        assert.deepEqual(knownTags, ["answer", "france"]);

        const [editKnown] = parse("<<EDIT(known://france/capital):Paris:EDIT");
        const r4 = await dispatch(editKnown, 3);
        assert.equal(r4.status, 200);
        const knownBody = (await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: knownEntryId, name: "body" }))?.content;
        assert.equal(knownBody, "Paris");

        const [findByTag] = parse("<<FIND[answer](known://)::FIND");
        const r6 = await dispatch(findByTag, 4);
        assert.equal(r6.status, 200);
        assert.deepEqual(r6.results, ["known://france/capital"]);

        const [findByGlob] = parse("<<FIND(known://):france*:FIND");
        const r7 = await dispatch(findByGlob, 5);
        assert.equal(r7.status, 200);
        assert.deepEqual(r7.results, ["known://france/capital"]);

        const [hideOp] = parse("<<HIDE(known://france/capital)::HIDE");
        const r8 = await dispatch(hideOp, 6);
        assert.equal(r8.status, 200);
        const hiddenRows = await (db.test_visibility_for_entry_indexed as PrepMethod).all<{ indexed: number }>({ entry_id: knownEntryId });
        assert.ok(hiddenRows.every((r) => r.indexed === 0));

        const [showOp] = parse("<<SHOW(known://france/capital)::SHOW");
        const r9 = await dispatch(showOp, 7);
        assert.equal(r9.status, 200);
        const shownRows = await (db.test_visibility_for_entry_indexed as PrepMethod).all<{ indexed: number }>({ entry_id: knownEntryId });
        assert.ok(shownRows.every((r) => r.indexed === 1));

        const [moveOp] = parse("<<MOVE(known://france/capital):known://archive/france/capital:MOVE");
        const r10 = await dispatch(moveOp, 8);
        assert.equal(r10.status, 201);
        const oldGone = await (db.test_get_entry_id_by_scheme_pathname as PrepMethod).get<{ id: number }>({ scheme: "known", pathname: "france/capital" });
        assert.equal(oldGone, undefined);
        const archive = await (db.test_get_entry_id_by_scheme_pathname as PrepMethod).get<{ id: number }>({ scheme: "known", pathname: "archive/france/capital" });
        const archiveBody = (await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: archive?.id, name: "body" }))?.content;
        assert.equal(archiveBody, "Paris");

        const [deleteOp] = parse("<<SEND[410](unknown://france/capital)::SEND");
        const r11 = await dispatch(deleteOp, 9);
        assert.equal(r11.status, 200);
        const unknownGone = await (db.test_get_entry_id_by_scheme_pathname as PrepMethod).get<{ id: number }>({ scheme: "unknown", pathname: "france/capital" });
        assert.equal(unknownGone, undefined);

        const [sendTerminal] = parse("<<SEND[200]:answer delivered:SEND");
        const r12 = await dispatch(sendTerminal, 10);
        assert.equal(r12.status, 200);
        const loopStatus = (await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: env.loopId }))?.status;
        assert.equal(loopStatus, 200);

        const allEntries = (await (db.test_list_entries_by_session_session_pathname as PrepMethod).all<{ scheme: string; pathname: string }>({ session_id: env.sessionId })).map((r) => ({ scheme: r.scheme, pathname: r.pathname }));
        assert.deepEqual(allEntries, [{ scheme: "known", pathname: "archive/france/capital" }]);

        const logCount = (await (db.test_count_log_entries_by_run as PrepMethod).get<{ n: number }>({ run_id: env.runId }))?.n;
        assert.equal(logCount, 11);

        const clientLogCount = (await (db.test_count_log_entries_run_origin as PrepMethod).get<{ n: number }>({ run_id: env.runId, origin: "client" }))?.n;
        assert.equal(clientLogCount, 11);
    } finally { await db.close(); }
});
