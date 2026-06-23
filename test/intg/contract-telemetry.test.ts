// SPEC contract coverage for the user-packet telemetry + prompt-foist
// surface (§packet / §telemetry). One test per contract tag. Every assertion is
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
import PacketWire from "../../src/core/packet-wire.ts";
import { Mock, ProviderError } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop } from "./_helpers.ts";

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
        // grammar 0.70: turns lead with PLAN (the Engine re-parses this content to
        // surface the genuine parse_error in the embedded op, now on line 2).
        content: content.startsWith("<<PLAN") ? content : `<<PLAN::PLAN\n${content}`,
        reasoning: null,
        usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 },
    },
    assistantRaw: null,
});

// A no-op draining turn — its only job is to RUN so the model's NEXT packet drains the
// telemetry buffer on read. These tests assert the drain, never a dispatch; the former
// bare-statement op builders (no PLAN lead) silently parsed to [] anyway — same effect,
// now explicit (and parseDsl no longer hides that parse error — see _rpc.ts).
const drainTurn = opsResponse([]);

// Actionless malformation: a SEND with a non-integer signal — the lexer
// rejects 'x' in the signal slot at 1:7. (The former `//`-xpath trigger now
// degrades to glob in grammar 0.20.0, so it no longer errors.)
const BROKEN_STMT = "<<SEND[x]:y:SEND";

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
        telemetryErrors: Array<Record<string, unknown>>;
        sections: Array<Record<string, unknown>>;
    };
};

test("[§telemetry-content-offset-snippet] content-offset parse_error renders N:\\t snippet under error://<line>; snippet stripped from meta JSON", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextSize: 100000,
            responses: [
                contentResponse(BROKEN_STMT),                 // turn 1: real parse_error
                drainTurn,        // turn 2: clean — drains the buffer
            ],
        });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });

        const p2 = await getPacket(db, t2.turnId);
        const parseErr = p2.telemetryErrors.find((e) => e.kind === "parse_error");
        assert.ok(parseErr !== undefined, "parse_error surfaced on the next packet");
        // Real content-offset position — the malformed SEND is on line 2 now
        // (line 1 is the required PLAN lead, grammar 0.70).
        assert.deepEqual(parseErr.position, { type: "content-offset", line: 2, column: 7 });
        // Snippet is the model's own offending bytes, N:\t-prefixed by #extractSnippet.
        assert.equal(parseErr.source, "grammar");
        assert.equal(parseErr.parserSource, "lexer");
        assert.equal(parseErr.snippet, `1:\t<<PLAN::PLAN\n2:\t${BROKEN_STMT}`);

        // Render the wire the model actually receives and assert the layout:
        // meta line (no snippet key) immediately followed by the error://<line>
        // fence wrapping the N:\t snippet.
        const wire = PacketWire.renderSlot(p2.sections, "user");
        assert.match(wire, /## Plurnk System Errors/);
        // The snippet field must NOT appear in the meta JSON line — it lives in the body block once.
        assert.doesNotMatch(wire, /"snippet":/, "snippet stripped from meta JSON");
        // error://1 fence carrying the verbatim N:\t snippet, line 1, immediately after meta.
        const fenced = `<<:::error://2\n1:\t<<PLAN::PLAN\n2:\t${BROKEN_STMT}\n:::error://2`;
        assert.ok(wire.includes(fenced), "snippet rendered under error://<line> fence with N:\\t prefix");
        // Meta line precedes the fence (event meta, then locator block).
        const metaIdx = wire.indexOf('"kind":"parse_error"');
        const fenceIdx = wire.indexOf("<<:::error://2");
        assert.ok(metaIdx !== -1 && fenceIdx !== -1 && metaIdx < fenceIdx, "meta line precedes the snippet fence");
    } finally { await db.close(); }
});

test("[§telemetry-drain-on-read] telemetry buffer drains — parse_error appears on exactly one packet, then is gone", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextSize: 100000,
            responses: [
                contentResponse(BROKEN_STMT),                 // turn 1: parse_error pushed to buffer
                drainTurn,       // turn 2: reads (drains) the buffer
                drainTurn,        // turn 3: buffer already empty
            ],
        });
        const t1 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const t3 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });

        const kindsOf = async (turnId: number) =>
            (await getPacket(db, turnId)).telemetryErrors
                .filter((e) => e.kind === "parse_error").length;

        // Turn 1's own packet predates the failure → no parse_error yet.
        assert.equal(await kindsOf(t1.turnId), 0, "failure not visible on the turn that produced it");
        // Turn 2 drains the single buffered parse_error.
        assert.equal(await kindsOf(t2.turnId), 1, "parse_error drained exactly once on read");
        // Turn 3: buffer was emptied at the drain — the error does NOT replay.
        assert.equal(await kindsOf(t3.turnId), 0, "drained error does not reappear on subsequent packets");
    } finally { await db.close(); }
});

test("#256 — grammar_unenforced provider error surfaces as telemetry on the next packet + an empty no-op turn, not a loop crash", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        // The one provider error the MODEL can recover from: the backend failed to
        // enforce the transported GBNF, so generate() throws ProviderError. The engine
        // must catch it, surface telemetry, and fall through as an empty no-op turn —
        // NOT propagate (which would terminate the loop). Turn 2 is a clean Mock turn
        // that drains the telemetry buffer onto its packet.
        const provider = new Mock({
            contextSize: 100000,
            responses: [drainTurn], // consumed by turn 2 only
        });
        const realGenerate = provider.generate.bind(provider);
        let threw = false;
        provider.generate = async (req) => {
            if (threw) return realGenerate(req);
            threw = true;
            throw new ProviderError("mock", "grammar_unenforced", "backend did not enforce the transported grammar");
        };

        const t1 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });

        // Turn 1 did not crash: zero ops dispatched, and it took the no-ops strike (422),
        // so the strike rail gives the model maxStrikes chances to recover.
        assert.deepEqual(t1.statuses, [], "grammar_unenforced → no ops dispatched (empty no-op turn)");
        assert.equal(t1.status, 422, "no real ops, no terminal SEND → the 422 no-op strike, not a terminal error");

        // Negative control: the failure is NOT on the turn that produced it (predates the drain)...
        const p1 = await getPacket(db, t1.turnId);
        assert.equal(
            p1.telemetryErrors.filter((e) => e.kind === "grammar_unenforced").length, 0,
            "failure not visible on the turn that produced it",
        );
        // ...it surfaces on turn 2's packet — the model's next view — exactly once.
        const p2 = await getPacket(db, t2.turnId);
        const ge = p2.telemetryErrors.filter((e) => e.kind === "grammar_unenforced");
        assert.equal(ge.length, 1, "grammar_unenforced drained exactly once onto the next packet");
        assert.equal(ge[0].source, "provider", "attributed to the provider, not the grammar/scheme");
        assert.match(String(ge[0].message), /grammar/i, "carries the provider's own diagnostic");
    } finally { await db.close(); }
});

test("provider error: a terminal kind (network_failure) telemetries live, then ends the loop", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "go");
        const broadcasts: Array<{ payload: { loopId: number; event: Record<string, unknown> } }> = [];
        const engine = new Engine({
            db, schemes: new SchemeRegistry(),
            telemetryEventNotify: (_sid, payload) => { broadcasts.push({ payload: payload as { loopId: number; event: Record<string, unknown> } }); },
        });
        const provider = new Mock({ contextSize: 100000, responses: [] });
        provider.generate = async () => { throw new ProviderError("plurnk", "network_failure", "connection refused"); };

        // Unlike grammar_unenforced, a terminal infra error propagates out of runTurn to end the loop.
        await assert.rejects(
            engine.runTurn({ provider, sessionId, runId, loopId, messages: [] }),
            /connection refused/,
            "a terminal provider error propagates (ends the loop), not recovered as a no-op",
        );
        // ...but it surfaced as a live telemetry event FIRST — the client sees the cause, not just
        // an opaque loop.run rejection.
        const live = broadcasts.filter((b) => b.payload.event.kind === "network_failure");
        assert.equal(live.length, 1, "network_failure broadcast live exactly once before terminating");
        assert.equal(live[0].payload.loopId, loopId);
        assert.equal(live[0].payload.event.source, "provider", "attributed to the provider");
        assert.match(String(live[0].payload.event.message), /connection refused/, "carries the provider's diagnostic");
    } finally { await db.close(); }
});

test("[§telemetry-no-error-scheme] actionless parse failures route to telemetry, not a queryable error:// entry namespace", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextSize: 100000,
            responses: [
                contentResponse(BROKEN_STMT),                 // actionless failure (no op dispatched)
                drainTurn,
            ],
        });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });

        // The failure IS surfaced — as telemetry, the actionless alert channel.
        const p2 = await getPacket(db, t2.turnId);
        assert.ok(
            p2.telemetryErrors.some((e) => e.kind === "parse_error"),
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
        const wire = PacketWire.renderSlot(p2.sections, "user");
        assert.ok(wire.includes("error://2"), "error://<line> is render-time locator context only");
    } finally { await db.close(); }
});

test("[§telemetry-telemetry-event-notify] every pushed event broadcasts live with the same envelope the model later drains", async () => {
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
                contentResponse(BROKEN_STMT),                 // turn 1: parse_error pushed + broadcast live
                drainTurn,        // turn 2: model drains it on read
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
        assert.deepEqual(liveEvent.position, { type: "content-offset", line: 2, column: 7 });

        // Model side: the SAME envelope drains onto the next packet's
        // telemetry.errors[]. Same source/kind/message/position on both sides.
        const t2 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const p2 = await getPacket(db, t2.turnId);
        const drained = p2.telemetryErrors.find((e) => e.kind === "parse_error");
        assert.ok(drained !== undefined, "same event drains onto the model's next packet");
        assert.equal(drained.source, liveEvent.source, "source matches on both sides");
        assert.equal(drained.message, liveEvent.message, "message matches on both sides");
        assert.deepEqual(drained.position, liveEvent.position, "position matches on both sides");
    } finally { await db.close(); }
});
