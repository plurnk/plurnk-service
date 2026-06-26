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

// An engine NOTICE provider (providers#24 filter mode): returns the model's bytes + a non-fatal
// `grammar_unenforced` TelemetryEvent at a code-point divergence. A NOTICE is telemetry (ephemeral,
// drain-on-read, broadcast) — distinct from a model ERROR, which is now a log item (§telemetry).
// `extraDrains` clean turns follow so the buffer can be observed draining.
const NOTICE_CONTENT = "<<PLAN:reasoning:PLAN\n<<SEND[103]:noted:SEND"; // 'N' of SEND on line 2 = code point 26
const NOTICE_POS = 26; // → content-offset line 2, column 4
const NOTICE_SNIPPET = `1:\t<<PLAN:reasoning:PLAN\n2:\t<<SEND[103]:noted:SEND`;
const noticeProvider = (extraDrains: number) => {
    const provider = new Mock({ contextSize: 100000, responses: Array.from({ length: extraDrains }, () => drainTurn) });
    const real = provider.generate.bind(provider);
    let did = false;
    provider.generate = async (req) => {
        if (did) return real(req);
        did = true;
        return {
            assistant: { content: NOTICE_CONTENT, reasoning: null, usage: { prompt: 5, completion: 10, reasoning: 0, cached: 0, total: 15 }, finishReason: "stop", model: "mock" },
            assistantRaw: { id: "x", filtered: true },
            telemetry: [{ source: "provider:mock", kind: "grammar_unenforced", message: "grammar not enforced at code point 26", position: NOTICE_POS }],
        };
    };
    return provider;
};

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

test("[§telemetry-content-offset-snippet] a content-offset NOTICE (grammar_unenforced) renders its N:\\t snippet under error://<line>; snippet stripped from meta JSON", async () => {
    // Errors are log items now; the content-offset snippet render belongs to the remaining engine
    // NOTICES (telemetry) — here grammar_unenforced, which carries a code-point divergence position.
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = noticeProvider(1);
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });

        const p2 = await getPacket(db, t2.turnId);
        const notice = p2.telemetryErrors.find((e) => e.kind === "grammar_unenforced");
        assert.ok(notice !== undefined, "the notice surfaced on the next packet");
        assert.deepEqual(notice.position, { type: "content-offset", line: 2, column: 4 });
        assert.equal(notice.snippet, NOTICE_SNIPPET);

        // The wire: meta line (no snippet key) immediately followed by the error://<line> fence.
        const wire = PacketWire.renderSlot(p2.sections, "user");
        assert.match(wire, /## Plurnk System Errors/);
        assert.doesNotMatch(wire, /"snippet":/, "snippet stripped from meta JSON");
        const fenced = `<<:::error://2\n${NOTICE_SNIPPET}\n:::error://2`;
        assert.ok(wire.includes(fenced), "snippet rendered under error://<line> fence with N:\\t prefix");
        const metaIdx = wire.indexOf('"kind":"grammar_unenforced"');
        const fenceIdx = wire.indexOf("<<:::error://2");
        assert.ok(metaIdx !== -1 && fenceIdx !== -1 && metaIdx < fenceIdx, "meta line precedes the snippet fence");
    } finally { await db.close(); }
});

test("[§telemetry-drain-on-read] the NOTICE telemetry buffer drains — a notice appears on exactly one packet, then is gone", async () => {
    // Errors persist (log items); engine NOTICES are ephemeral — drain-on-read, one packet only.
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = noticeProvider(2);
        const t1 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const t3 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });

        const kindsOf = async (turnId: number) =>
            (await getPacket(db, turnId)).telemetryErrors
                .filter((e) => e.kind === "grammar_unenforced").length;

        assert.equal(await kindsOf(t1.turnId), 0, "notice not visible on the turn that produced it");
        assert.equal(await kindsOf(t2.turnId), 1, "notice drained exactly once on read");
        assert.equal(await kindsOf(t3.turnId), 0, "drained notice does not reappear on subsequent packets");
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

test("#275 / providers#24 — filter-mode grammar_unenforced does NOT throw: the bytes persist and a telemetry event with the divergence snippet drains onto the next packet", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        // GBNF-filter mode (providers 0.19.0): generate() returns the model's UNCONSTRAINED bytes
        // and attaches a non-fatal grammar_unenforced TelemetryEvent carrying the code-point
        // divergence position — it does NOT throw. The engine must persist the bytes (no empty
        // turn, the old cascade root cause) AND drain the event with a content-offset snippet so
        // the model sees its own emission and self-corrects.
        const FREE = "<<PLAN:reasoning:PLAN\n<<SEND[103]:noted:SEND"; // 'N' of SEND on line 2 is code point 26
        const provider = new Mock({ contextSize: 100000, responses: [drainTurn] }); // turn 2 drains
        const realGenerate = provider.generate.bind(provider);
        let did = false;
        provider.generate = async (req) => {
            if (did) return realGenerate(req);
            did = true;
            return {
                assistant: { content: FREE, reasoning: "thought about it", usage: { prompt: 5, completion: 10, reasoning: 2, cached: 0, total: 17 }, finishReason: "stop", model: "mock" },
                assistantRaw: { id: "x", filtered: true },
                telemetry: [{ source: "provider:mock", kind: "grammar_unenforced", message: "grammar not enforced: output rejected by the transported grammar at code point 26", position: 26 }],
            };
        };

        const t1 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });

        // #24 root-cause fix: the model's bytes SURVIVE — not nulled into an empty turn.
        const p1 = await getPacket(db, t1.turnId) as { assistant?: { content?: string }; assistantRaw?: unknown };
        assert.equal(p1.assistant?.content, FREE, "the unconstrained emission is persisted, not discarded");
        assert.notEqual(p1.assistantRaw, null, "assistantRaw populated — no empty-turn write");

        // The conflict drains onto turn 2's packet exactly once, with the provider's own source,
        // a real content-offset position, and a snippet of the model's bytes around the divergence.
        const p2 = await getPacket(db, t2.turnId);
        const ge = p2.telemetryErrors.filter((e) => e.kind === "grammar_unenforced");
        assert.equal(ge.length, 1, "grammar_unenforced telemetry drained exactly once");
        assert.equal(ge[0].source, "provider:mock", "attributed to the minting provider");
        assert.deepEqual(ge[0].position, { type: "content-offset", line: 2, column: 4 }, "code-point offset → content-offset line/column");
        assert.equal(ge[0].snippet, `1:\t<<PLAN:reasoning:PLAN\n2:\t<<SEND[103]:noted:SEND`, "the model's own bytes around the divergence line");
        assert.match(String(ge[0].message), /not enforced/i, "carries the provider's verdict");
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

test("[§telemetry-no-error-scheme] an actionless parse failure is a LOG ITEM (op='error', status 400) — queryable + foldable, not a bespoke error:// scheme", async () => {
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

        // The failure is a DURABLE log row — op='error', status_rx 400, actionless (no target).
        // It folds/kills/recalls like any log entry (§telemetry — errors are log items), so the
        // grinder's prior-turn rollback can reclaim it: one budget surface, the log.
        const rows = await (db.test_log_entries_by_loop as PrepMethod).all<{ op: string; status_rx: number; scheme: string | null }>({ loop_id: loopId });
        const errRow = rows.find((r) => r.op === "error" && r.status_rx === 400);
        assert.ok(errRow !== undefined, "parse failure recorded as a log:///…/error item (status 400), not ephemeral telemetry");
        assert.equal(errRow!.scheme, null, "an error row is actionless — no target scheme");

        // No `error://` SCHEME namespace — errors live in the LOG (log:///), not a bespoke scheme.
        const errorScheme = await (db.test_count_entries_by_session_scheme as PrepMethod).get<{ n: number }>({
            session_id: sessionId, scheme: "error",
        });
        assert.equal(errorScheme?.n ?? 0, 0, "no error:// scheme entries — errors are log items, queried via log:///");

        // The errors section derives a POINTER (status + coordinate) to the log item.
        const t2 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const p2 = await getPacket(db, t2.turnId);
        assert.ok(p2.telemetryErrors.some((e) => e.op === "error" && e.status === 400), "errors section surfaces a derived pointer to the error log item");
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

        const provider = noticeProvider(1);                   // turn 1: grammar_unenforced NOTICE pushed + broadcast live
        // NOTE: errors are log items (no telemetry/event); the broadcast surface is for engine NOTICES.
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });

        // Client side: the event broadcast live, scoped to the loop's session,
        // BEFORE turn 2 ever builds a packet.
        const liveParse = broadcasts.filter((b) => b.payload.event.kind === "grammar_unenforced");
        assert.equal(liveParse.length, 1, "the notice broadcast live exactly once");
        assert.equal(liveParse[0].sessionId, sessionId, "scoped to the loop's session");
        assert.equal(liveParse[0].payload.loopId, loopId);
        const liveEvent = liveParse[0].payload.event;
        assert.equal(liveEvent.source, "provider:mock");
        assert.equal(liveEvent.kind, "grammar_unenforced");
        assert.deepEqual(liveEvent.position, { type: "content-offset", line: 2, column: 4 });

        // Model side: the SAME envelope drains onto the next packet's
        // telemetry.errors[]. Same source/kind/message/position on both sides.
        const t2 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const p2 = await getPacket(db, t2.turnId);
        const drained = p2.telemetryErrors.find((e) => e.kind === "grammar_unenforced");
        assert.ok(drained !== undefined, "same event drains onto the model's next packet");
        assert.equal(drained.source, liveEvent.source, "source matches on both sides");
        assert.equal(drained.message, liveEvent.message, "message matches on both sides");
        assert.deepEqual(drained.position, liveEvent.position, "position matches on both sides");
    } finally { await db.close(); }
});
