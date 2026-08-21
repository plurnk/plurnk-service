// Floor-scope capstone — drives the non-EXEC entry DSL ops end-to-end through the
// canonical grammar parser, real Engine, real SchemeRegistry, real SqlRite.

import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, seedEnvelope, DEFAULT_MIMETYPES } from "./_helpers.ts";

const parse = (dsl: string): PlurnkStatement[] => {
    const result = PlurnkParser.parseStatements(dsl);
    return result.items
        .filter((i) => i.kind === "statement")
        .map((i) => (i as { kind: "statement"; statement: PlurnkStatement }).statement)
        .filter((s) => s.op !== "PLAN");
};

test("Floor-scope capstone: full DSL surface exercised end-to-end", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, "capstone-ws", { producer: "client" });
    // FIND body matchers now run content through the mimetypes plugin,
    // so the end-to-end engine needs a real (discovering) Mimetypes — same as the
    // daemon wires in production; the bare default has no handlers.
    await DEFAULT_MIMETYPES.ready();
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });

    const dispatch = async (statement: PlurnkStatement, sequence: number) =>
        engine.dispatch({ statement, ...env, sequence, origin: "client" });

    try {
        const [editQuestion] = parse("## EDIT0 [+geography,+question] (worker:///france/capital)\nwhat is the capital of france?");
        const r1 = await dispatch(editQuestion, 1);
        assert.equal(r1.status, 201);
        const questionEntryId = r1.entryId as number;
        assert.ok(typeof questionEntryId === "number");

        const channels1 = await db.test_list_channel_names.all<{ name: string }>({ entry_id: questionEntryId });
        assert.deepEqual(channels1.map((c) => c.name), ["body"]);

        // {§edit-marker-required-on-existing} — the entry already exists (created above), so
        // the re-edit needs a marker; <1,-1> states the deliberate full rewrite.
        const [editQuestionAgain] = parse("## EDIT0 [+geography] (worker:///france/capital) <1,-1>\nrephrased question");
        const r2 = await dispatch(editQuestionAgain, 2);
        assert.equal(r2.status, 200);
        assert.equal(r2.entryId, questionEntryId);
        const body2 = (await db.test_get_channel.get<{ content: string }>({ entry_id: questionEntryId, name: "body" }))?.content;
        assert.equal(body2, "rephrased question");

        const [copyOp] = parse("## COPY0 [+answer,+france] (worker:///france/capital)\nskill:///france/capital");
        const r3 = await dispatch(copyOp, 3);
        assert.equal(r3.status, 201);

        const skillEntry = await db.test_get_entry_id_by_scheme_pathname.get<{ id: number }>({ scheme: "skill", pathname: "/france/capital" });
        const skillEntryId = skillEntry!.id;

        // The COPY above already created this entry, so the edit needs a marker too.
        const [editSkill] = parse("## EDIT0 (skill:///france/capital) <1,-1>\nParis");
        const r4 = await dispatch(editSkill, 4);
        assert.equal(r4.status, 200);
        const skillBody = (await db.test_get_channel.get<{ content: string }>({ entry_id: skillEntryId, name: "body" }))?.content;
        assert.equal(skillBody, "Paris");

        const [classifiedFind] = parse("## FIND0 [+answer] (skill:///)");
        const r6 = await dispatch(classifiedFind, 5);
        assert.equal(r6.status, 200);
        assert.deepEqual((r6.results as Array<[{ path: string }]>).map(([resource]) => resource.path), ["skill:///france/capital"]);
        const logTags = await db.test_log_tags_by_worker.all<{ coordinate: string; tag: string }>({ worker_id: env.workerId });
        assert.deepEqual(logTags.filter(({ coordinate }) => coordinate === "1/1/3" || coordinate === "1/1/5"), [
            { coordinate: "1/1/3", tag: "answer" },
            { coordinate: "1/1/3", tag: "france" },
            { coordinate: "1/1/5", tag: "answer" },
        ]);

        // glob body matches CONTENT (the entry's body is "Paris"), not the pathname.
        const [findByGlob] = parse("## FIND0 (skill:///)\nParis*");
        const r7 = await dispatch(findByGlob, 6);
        assert.equal(r7.status, 200);
        assert.deepEqual((r7.results as Array<[{ path: string }]>).map(([resource]) => resource.path), ["skill:///france/capital"]);

        const [moveOp] = parse("## MOVE0 (worker:///france/capital)\nworker:///archive/france/capital");
        const r10 = await dispatch(moveOp, 9);
        assert.equal(r10.status, 201);
        const oldGone = await db.test_get_entry_id_by_scheme_pathname.get<{ id: number }>({ scheme: "worker", pathname: "/france/capital" });
        assert.equal(oldGone, undefined);
        const archive = await db.test_get_entry_id_by_scheme_pathname.get<{ id: number }>({ scheme: "worker", pathname: "/archive/france/capital" });
        const archiveBody = (await db.test_get_channel.get<{ content: string }>({ entry_id: archive?.id, name: "body" }))?.content;
        assert.equal(archiveBody, "rephrased question"); // the commons original — Paris lives on the skill copy

        const [deleteOp] = parse("## SEND0 [410] (skill:///france/capital)");
        const r11 = await dispatch(deleteOp, 10);
        assert.equal(r11.status, 200);
        const skillGone = await db.test_get_entry_id_by_scheme_pathname.get<{ id: number }>({ scheme: "skill", pathname: "/france/capital" });
        assert.equal(skillGone, undefined);

        const [sendTerminal] = parse("## SEND0 [200]\nanswer delivered");
        const r12 = await dispatch(sendTerminal, 11);
        assert.equal(r12.status, 200);
        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: env.loopId }))?.status;
        assert.equal(loopStatus, 200);

        const allEntries = (await db.test_list_entries_by_workspace_workspace_pathname.all<{ scheme: string; pathname: string }>({ workspace_id: env.workspaceId })).map((r) => ({ scheme: r.scheme, pathname: r.pathname }));
        assert.deepEqual(allEntries, [{ scheme: "worker", pathname: "/archive/france/capital" }]);

        const logCount = (await db.test_count_log_entries_by_worker.get<{ n: number }>({ worker_id: env.workerId }))?.n;
        assert.equal(logCount, 9);

        const clientLogCount = (await db.test_count_log_entries_worker_origin.get<{ n: number }>({ worker_id: env.workerId, origin: "client" }))?.n;
        assert.equal(clientLogCount, 9);
    } finally { await db.close(); }
});
