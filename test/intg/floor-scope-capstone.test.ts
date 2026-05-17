// Floor-scope capstone — drives every non-EXEC DSL op end-to-end through the
// canonical grammar parser, real Engine, real SchemeRegistry, real SQLite.
//
// When this test is green, the floor is green: every op exercises correctly
// against entry-bearing schemes, channel routing works, COPY/MOVE/FIND/SEND
// integrate via the engine, and the DB ends in a coherent state.

import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-grammar";
import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, seedEnvelope } from "./_helpers.ts";

const parse = (dsl: string): PlurnkStatement[] => {
    const result = PlurnkParser.parse(dsl);
    return result.items
        .filter((i) => i.kind === "statement")
        .map((i) => (i as { kind: "statement"; statement: PlurnkStatement }).statement);
};

test("Floor-scope capstone: full DSL surface exercised end-to-end", async () => {
    const db = await openMigrated();
    const env = seedEnvelope(db, "capstone-ws");
    const engine = new Engine({ db, schemes: new SchemeRegistry() });

    const dispatch = async (statement: PlurnkStatement, actionIndex: number) =>
        engine.dispatch({ statement, ...env, actionIndex, origin: "client" });

    try {
        // === Phase 1: EDIT into unknown:// (initial creation with tags) ===
        const [editUnknown] = parse("<<EDIT[geography,question](unknown://france/capital):what is the capital of france?:EDIT");
        const r1 = await dispatch(editUnknown, 0);
        assert.equal(r1.status, 201, "EDIT new entry returns 201");
        const unknownEntryId = r1.entryId;
        assert.ok(typeof unknownEntryId === "number");

        // Verify channels written (body + preview)
        const channels1 = db.prepare("SELECT name FROM entry_channels WHERE entry_id = ? ORDER BY name").all(unknownEntryId) as Array<{ name: string }>;
        assert.deepEqual(channels1.map((c) => c.name), ["body", "preview"]);

        // === Phase 2: EDIT same path (idempotent update) ===
        const [editUnknownAgain] = parse("<<EDIT[geography](unknown://france/capital):rephrased question:EDIT");
        const r2 = await dispatch(editUnknownAgain, 1);
        assert.equal(r2.status, 200, "EDIT existing entry returns 200");
        assert.equal(r2.entryId, unknownEntryId, "same entry id");

        const body2 = (db.prepare("SELECT content FROM entry_channels WHERE entry_id = ? AND name = 'body'").get(unknownEntryId) as { content: string }).content;
        assert.equal(body2, "rephrased question");

        // === Phase 3: COPY unknown → known (with tag replacement) ===
        const [copyOp] = parse("<<COPY[answer,france](unknown://france/capital):known://france/capital:COPY");
        const r3 = await dispatch(copyOp, 2);
        assert.equal(r3.status, 201, "COPY creates dest");

        const knownEntryId = (db.prepare("SELECT id FROM entries WHERE scheme = 'known' AND pathname = 'france/capital'").get() as { id: number }).id;
        const knownTags = (db.prepare("SELECT tag FROM entry_tags WHERE entry_id = ? ORDER BY tag").all(knownEntryId) as Array<{ tag: string }>).map((t) => t.tag);
        assert.deepEqual(knownTags, ["answer", "france"], "signal tags REPLACE source tags on dest");

        // === Phase 4: EDIT to update the body of the known entry ===
        const [editKnown] = parse("<<EDIT(known://france/capital):Paris:EDIT");
        const r4 = await dispatch(editKnown, 3);
        assert.equal(r4.status, 200);
        const knownBody = (db.prepare("SELECT content FROM entry_channels WHERE entry_id = ? AND name = 'body'").get(knownEntryId) as { content: string }).content;
        assert.equal(knownBody, "Paris");

        // === Phase 5: EDIT to preview channel via fragment ===
        const [editPreview] = parse("<<EDIT(known://france/capital#preview):capital of france: Paris:EDIT");
        const r5 = await dispatch(editPreview, 4);
        assert.equal(r5.status, 200);
        assert.equal(r5.channel, "preview");
        const previewBody = (db.prepare("SELECT content FROM entry_channels WHERE entry_id = ? AND name = 'preview'").get(knownEntryId) as { content: string }).content;
        assert.equal(previewBody, "capital of france: Paris");
        // Body untouched
        const bodyStillParis = (db.prepare("SELECT content FROM entry_channels WHERE entry_id = ? AND name = 'body'").get(knownEntryId) as { content: string }).content;
        assert.equal(bodyStillParis, "Paris");

        // === Phase 6: FIND by tag ===
        const [findByTag] = parse("<<FIND[answer](known://)::FIND");
        const r6 = await dispatch(findByTag, 5);
        assert.equal(r6.status, 200);
        assert.deepEqual(r6.results, ["known://france/capital"], "tag filter finds the known entry");

        // === Phase 7: FIND by glob ===
        const [findByGlob] = parse("<<FIND(known://):france*:FIND");
        const r7 = await dispatch(findByGlob, 6);
        assert.equal(r7.status, 200);
        assert.deepEqual(r7.results, ["known://france/capital"]);

        // === Phase 8: SHOW/HIDE round-trip ===
        const [hideOp] = parse("<<HIDE(known://france/capital)::HIDE");
        const r8 = await dispatch(hideOp, 7);
        assert.equal(r8.status, 200);
        const hiddenRows = db.prepare("SELECT indexed FROM visibility WHERE entry_id = ?").all(knownEntryId) as Array<{ indexed: number }>;
        assert.ok(hiddenRows.every((r) => r.indexed === 0), "all channels hidden");

        const [showOp] = parse("<<SHOW(known://france/capital)::SHOW");
        const r9 = await dispatch(showOp, 8);
        assert.equal(r9.status, 200);
        const shownRows = db.prepare("SELECT indexed FROM visibility WHERE entry_id = ?").all(knownEntryId) as Array<{ indexed: number }>;
        assert.ok(shownRows.every((r) => r.indexed === 1), "all channels shown");

        // === Phase 9: MOVE the entry to archive ===
        const [moveOp] = parse("<<MOVE(known://france/capital):known://archive/france/capital:MOVE");
        const r10 = await dispatch(moveOp, 9);
        assert.equal(r10.status, 201);
        // Old path gone
        const oldGone = db.prepare("SELECT id FROM entries WHERE scheme = 'known' AND pathname = 'france/capital'").get();
        assert.equal(oldGone, undefined);
        // New path exists
        const archiveId = (db.prepare("SELECT id FROM entries WHERE scheme = 'known' AND pathname = 'archive/france/capital'").get() as { id: number }).id;
        const archiveBody = (db.prepare("SELECT content FROM entry_channels WHERE entry_id = ? AND name = 'body'").get(archiveId) as { content: string }).content;
        assert.equal(archiveBody, "Paris");

        // === Phase 10: SEND[410] delete the unknown entry ===
        const [deleteOp] = parse("<<SEND[410](unknown://france/capital)::SEND");
        const r11 = await dispatch(deleteOp, 10);
        assert.equal(r11.status, 200);
        const unknownGone = db.prepare("SELECT id FROM entries WHERE scheme = 'unknown' AND pathname = 'france/capital'").get();
        assert.equal(unknownGone, undefined, "unknown entry deleted");

        // === Phase 11: SEND[200] terminal broadcast (loop closes) ===
        const [sendTerminal] = parse("<<SEND[200]:answer delivered:SEND");
        const r12 = await dispatch(sendTerminal, 11);
        assert.equal(r12.status, 200);
        const loopStatus = (db.prepare("SELECT status FROM loops WHERE id = ?").get(env.loopId) as { status: number }).status;
        assert.equal(loopStatus, 200, "loop status updated by terminal SEND broadcast");

        // === Final state verification ===
        const allEntries = (db.prepare("SELECT scheme, pathname FROM entries WHERE session_id = ? ORDER BY scheme, pathname").all(env.sessionId) as Array<{ scheme: string; pathname: string }>).map((r) => ({ scheme: r.scheme, pathname: r.pathname }));
        assert.deepEqual(
            allEntries,
            [{ scheme: "known", pathname: "archive/france/capital" }],
            "single entry remains: the archived known entry",
        );

        const logCount = (db.prepare("SELECT COUNT(*) as n FROM log_entries WHERE run_id = ?").get(env.runId) as { n: number }).n;
        assert.equal(logCount, 12, "every dispatched op produced a log_entries row");

        const clientLogCount = (db.prepare("SELECT COUNT(*) as n FROM log_entries WHERE run_id = ? AND origin = 'client'").get(env.runId) as { n: number }).n;
        assert.equal(clientLogCount, 12, "all 12 ops carry origin = 'client'");
    } finally { db.close(); }
});
