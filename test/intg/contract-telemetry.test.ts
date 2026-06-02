// SPEC contract coverage for the user-packet telemetry + prompt-foist
// surface (§15 / §15.1). One test per contract tag. Every assertion is
// against real DB artifacts and the real wire render — no stand-ins.
//
// Parse errors are driven END-TO-END: the Mock response supplies `content`
// WITHOUT pre-parsed `ops`, forcing Engine.#splitResponse to run the real
// PlurnkParser. The canonical edit-todo emission (a READ whose matcher body
// starts with `//`, which the grammar xpath-dispatches and rejects) yields a
// genuine `parse_error` TelemetryEvent with a real content-offset position
// and a real `#extractSnippet` slice of the model's own bytes.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { renderUserContent } from "../../src/core/packet-wire.js";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop } from "./_helpers.ts";
import { parseDsl } from "./_rpc.ts";

// Response from pre-parsed ops (clean turn) — mirrors the production wire
// where the provider hands the engine already-parsed statements.
const opsResponse = (ops: PlurnkStatement[]): MockResponse => ({
    assistant: {
        content: "", ops, reasoning: null,
        usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 },
    },
    assistantRaw: null,
});

// Response from raw content WITHOUT ops — forces the engine to run the real
// PlurnkParser, so a malformed emission produces a genuine parse_error.
const contentResponse = (content: string): MockResponse => ({
    assistant: {
        content, reasoning: null,
        usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 },
    },
    assistantRaw: null,
});

const okEdit = parseDsl("<<EDIT(known://ok):v:EDIT");
const sendDone = parseDsl("<<SEND[200]:done:SEND");
const sendGoing = parseDsl("<<SEND[102]:going:SEND");

// Canonical edit-todo malformation: a READ body opening with `//` gets
// xpath-dispatched and rejected by the grammar visitor at 1:0.
const BROKEN_READ = "<<READ(known://app.js):// TODO: add error handling:READ";

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1, "what is the capital of france?");
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, engine, sessionId, runId, loopId };
};

const getPacket = async (db: Awaited<ReturnType<typeof openMigrated>>, turnId: number) => {
    const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: turnId });
    return JSON.parse(row?.packet ?? "{}") as {
        system: { index: Array<{ scheme: string | null; pathname: string }> };
        user: { prompt: string; telemetry: { budget: string; errors: Array<Record<string, unknown>> } };
    };
};

test("[§15-current-prompt-foist] turn-1 prompt is foisted into packet.user.prompt; prior-loop prompt stays index-addressable", async () => {
    const { db, engine, sessionId, runId, loopId: loop1Id } = await setup();
    try {
        // Loop 1: writes plurnk://prompt/<loop1>/1 on loop start.
        const r1 = await engine.runTurn({
            provider: new Mock({ contextSize: 100000, responses: [opsResponse([...sendDone])] }),
            sessionId, runId, loopId: loop1Id, messages: [],
        });

        // (a) The prompt is a first-class system-origin EDIT entry on disk.
        const promptEntry = await (db.test_get_entry_by_path as PrepMethod).get<{ id: number }>({
            session_id: sessionId, scheme: "plurnk", pathname: `prompt/${loop1Id}/1`,
        });
        assert.ok(promptEntry !== undefined, "plurnk://prompt/<loop>/1 entry written on loop start");

        const p1 = await getPacket(db, r1.turnId);
        // (b) Foisted IN: the current loop's prompt body materializes in user.prompt.
        assert.equal(p1.user.prompt, "what is the capital of france?");
        // (c) Foisted OUT: the current loop's prompt entry is absent from the index render.
        const foistedOut = p1.system.index.find(
            (e) => e.scheme === "plurnk" && e.pathname.startsWith(`prompt/${loop1Id}/`),
        );
        assert.equal(foistedOut, undefined, "current loop's prompt NOT in packet.system.index");

        // Loop 2: from its vantage, loop 1's prompt is "previous" — it MUST
        // remain in the index (READ/HIDE-able), while loop 2's own prompt foists.
        const loop2Id = await insertLoop(db, runId, 2, "second loop prompt");
        const r2 = await engine.runTurn({
            provider: new Mock({ contextSize: 100000, responses: [opsResponse([...sendDone])] }),
            sessionId, runId, loopId: loop2Id, messages: [],
        });
        const p2 = await getPacket(db, r2.turnId);
        assert.equal(p2.user.prompt, "second loop prompt", "loop 2's own prompt foisted into user.prompt");
        const loop1Indexed = p2.system.index.find(
            (e) => e.scheme === "plurnk" && e.pathname.startsWith(`prompt/${loop1Id}/`),
        );
        const loop2Indexed = p2.system.index.find(
            (e) => e.scheme === "plurnk" && e.pathname.startsWith(`prompt/${loop2Id}/`),
        );
        assert.ok(loop1Indexed !== undefined, "prior loop's prompt stays in index, addressable for READ/HIDE");
        assert.equal(loop2Indexed, undefined, "current loop's prompt foisted out of index");
    } finally { await db.close(); }
});

test("[§15.1-content-offset-snippet] content-offset parse_error renders N:\\t snippet under error://<line>; snippet stripped from meta JSON", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextSize: 100000,
            responses: [
                contentResponse(BROKEN_READ),                 // turn 1: real parse_error
                opsResponse([...okEdit, ...sendDone]),        // turn 2: clean — drains the buffer
            ],
        });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });

        const p2 = await getPacket(db, t2.turnId);
        const parseErr = p2.user.telemetry.errors.find((e) => e.kind === "parse_error");
        assert.ok(parseErr !== undefined, "parse_error surfaced on the next packet");
        // Real content-offset position from the grammar visitor (1:0).
        assert.deepEqual(parseErr.position, { type: "content-offset", line: 1, column: 0 });
        // Snippet is the model's own offending bytes, N:\t-prefixed by #extractSnippet.
        assert.equal(parseErr.source, "grammar");
        assert.equal(parseErr.parserSource, "visitor");
        assert.equal(parseErr.snippet, `1:\t${BROKEN_READ}`);

        // Render the wire the model actually receives and assert the layout:
        // meta line (no snippet key) immediately followed by the error://<line>
        // fence wrapping the N:\t snippet.
        const wire = renderUserContent(p2.user);
        assert.match(wire, /# Plurnk System Errors/);
        // The snippet field must NOT appear in the meta JSON line — it lives in the body block once.
        assert.doesNotMatch(wire, /"snippet":/, "snippet stripped from meta JSON");
        // error://1 fence carrying the verbatim N:\t snippet, line 1, immediately after meta.
        const fenced = `<<:::error://1\n1:\t${BROKEN_READ}\n:::error://1`;
        assert.ok(wire.includes(fenced), "snippet rendered under error://<line> fence with N:\\t prefix");
        // Meta line precedes the fence (event meta, then locator block).
        const metaIdx = wire.indexOf('"kind":"parse_error"');
        const fenceIdx = wire.indexOf("<<:::error://1");
        assert.ok(metaIdx !== -1 && fenceIdx !== -1 && metaIdx < fenceIdx, "meta line precedes the snippet fence");
    } finally { await db.close(); }
});

test("[§15.1-drain-on-read] telemetry buffer drains — parse_error appears on exactly one packet, then is gone", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextSize: 100000,
            responses: [
                contentResponse(BROKEN_READ),                 // turn 1: parse_error pushed to buffer
                opsResponse([...okEdit, ...sendGoing]),       // turn 2: reads (drains) the buffer
                opsResponse([...okEdit, ...sendDone]),        // turn 3: buffer already empty
            ],
        });
        const t1 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const t3 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });

        const kindsOf = async (turnId: number) =>
            (await getPacket(db, turnId)).user.telemetry.errors
                .filter((e) => e.kind === "parse_error").length;

        // Turn 1's own packet predates the failure → no parse_error yet.
        assert.equal(await kindsOf(t1.turnId), 0, "failure not visible on the turn that produced it");
        // Turn 2 drains the single buffered parse_error.
        assert.equal(await kindsOf(t2.turnId), 1, "parse_error drained exactly once on read");
        // Turn 3: buffer was emptied at the drain — the error does NOT replay.
        assert.equal(await kindsOf(t3.turnId), 0, "drained error does not reappear on subsequent packets");
    } finally { await db.close(); }
});

test("[§15.1-no-error-scheme] actionless parse failures route to telemetry, not a queryable error:// entry namespace", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextSize: 100000,
            responses: [
                contentResponse(BROKEN_READ),                 // actionless failure (no op dispatched)
                opsResponse([...okEdit, ...sendDone]),
            ],
        });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });

        // The failure IS surfaced — as telemetry, the actionless alert channel.
        const p2 = await getPacket(db, t2.turnId);
        assert.ok(
            p2.user.telemetry.errors.some((e) => e.kind === "parse_error"),
            "actionless failure routed to telemetry.errors[]",
        );

        // It is NOT materialized as an addressable entry under an `error://`
        // scheme. No `error` scheme namespace exists in storage.
        const errorScheme = await (db.test_count_entries_by_session_scheme as PrepMethod).get<{ n: number }>({
            session_id: sessionId, scheme: "error",
        });
        assert.equal(errorScheme?.n, 0, "no error:// scheme entries — actionless failures aren't a queryable namespace");

        // The only `error://` token the model ever sees is the snippet-fence
        // LOCATOR in the rendered telemetry, not an entry it can address.
        const wire = renderUserContent(p2.user);
        assert.ok(wire.includes("error://1"), "error://<line> is render-time locator context only");
    } finally { await db.close(); }
});

test("[§15.1-telemetry-event-notify] every pushed event broadcasts live with the same envelope the model later drains", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "trace the broken xpath");

        // Capture the live fan-out: every TelemetryEvent the engine pushes
        // to the loop's buffer also fires this callback the moment it lands.
        const broadcasts: Array<{ sessionId: number; payload: { loopId: number; event: Record<string, unknown> } }> = [];
        const engine = new Engine({
            db,
            schemes: new SchemeRegistry(),
            telemetryEventNotify: (sid, payload) => { broadcasts.push({ sessionId: sid, payload: payload as { loopId: number; event: Record<string, unknown> } }); },
        });

        const provider = new Mock({
            contextSize: 100000,
            responses: [
                contentResponse(BROKEN_READ),                 // turn 1: parse_error pushed + broadcast live
                opsResponse([...okEdit, ...sendDone]),        // turn 2: model drains it on read
            ],
        });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });

        // Client side: the event broadcast live, scoped to the loop's session,
        // BEFORE turn 2 ever builds a packet.
        const liveParse = broadcasts.filter((b) => b.payload.event.kind === "parse_error");
        assert.equal(liveParse.length, 1, "parse_error broadcast live exactly once");
        assert.equal(liveParse[0].sessionId, sessionId, "scoped to the loop's session");
        assert.equal(liveParse[0].payload.loopId, loopId);
        const liveEvent = liveParse[0].payload.event;
        assert.equal(liveEvent.source, "grammar");
        assert.equal(liveEvent.kind, "parse_error");
        assert.deepEqual(liveEvent.position, { type: "content-offset", line: 1, column: 0 });

        // Model side: the SAME envelope drains onto the next packet's
        // telemetry.errors[]. Same source/kind/message/position on both sides.
        const t2 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const p2 = await getPacket(db, t2.turnId);
        const drained = p2.user.telemetry.errors.find((e) => e.kind === "parse_error");
        assert.ok(drained !== undefined, "same event drains onto the model's next packet");
        assert.equal(drained.source, liveEvent.source, "source matches on both sides");
        assert.equal(drained.message, liveEvent.message, "message matches on both sides");
        assert.deepEqual(drained.position, liveEvent.position, "position matches on both sides");
    } finally { await db.close(); }
});
