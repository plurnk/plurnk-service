// SPEC contract coverage for the user-packet notices + prompt-foist
// surface (§packet / §operation-results). One test per contract tag. Every assertion is
// against real DB artifacts and the real wire render — no stand-ins.
//
// Parse errors are driven END-TO-END: the Mock response supplies `content`
// WITHOUT pre-parsed `ops`, forcing Engine.#splitResponse to run the real
// PlurnkParser, which yields a genuine parse failure with a real content-offset
// position the model resolves against its own emission (the born-OPEN model row).

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import { Mock, ProviderError } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, packetSection } from "./_helpers.ts";
import { OperationFailureError } from "../../src/core/results.ts";

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
// notices buffer on read. These tests assert the drain, never a dispatch; the former
// bare-statement op builders (no PLAN lead) silently parsed to [] anyway — same effect,
// now explicit (and parseDsl no longer hides that parse error — see _rpc.ts).
const drainTurn = opsResponse([]);

// Actionless malformation: a SEND with a non-integer signal — the lexer
// rejects 'x' in the signal slot at 1:7. (The former `//`-xpath trigger now
// degrades to glob in grammar 0.20.0, so it no longer errors.)
const BROKEN_STMT = "<<SEND[x]:y:SEND";

// An engine NOTICE provider (providers#24 filter mode): returns the model's bytes + a non-fatal
// `grammar_unenforced` Notice at a code-point divergence. A Notice is ephemeral,
// drain-on-read, and broadcast — distinct from a durable failure log item.
// `extraDrains` clean turns follow so the buffer can be observed draining.
const NOTICE_CONTENT = "<<PLAN:reasoning:PLAN\n<<SEND[103]:noted:SEND"; // 'N' of SEND on line 2 = code point 26
const NOTICE_POS = 26; // → content-offset line 2, column 4
const noticeProvider = (extraDrains: number) => {
    const provider = new Mock({ contextWindow: 100000, responses: Array.from({ length: extraDrains }, () => drainTurn) });
    const real = provider.generate.bind(provider);
    let did = false;
    provider.generate = async (req) => {
        if (did) return real(req);
        did = true;
        return {
            assistant: { content: NOTICE_CONTENT, reasoning: null, usage: { prompt: 5, completion: 10, reasoning: 0, cached: 0, total: 15 }, finishReason: "stop", model: "mock" },
            assistantRaw: { id: "x", filtered: true },
            notices: [{ source: "provider:mock", kind: "grammar_unenforced", level: "warn", message: "grammar not enforced at code point 26", position: NOTICE_POS }],
        };
    };
    return provider;
};

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "what is the capital of france?");
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, engine, workspaceId, workerId, loopId };
};

const getPacket = async (db: Awaited<ReturnType<typeof openMigrated>>, turnId: number) => {
    const row = await db.test_get_packet.get<{ packet: string }>({ id: turnId });
    return JSON.parse(row?.packet ?? "{}") as { sections: Array<Record<string, unknown>> };
};

test("a content-offset NOTICE (grammar_unenforced) carries a line:col pointer, no embedded snippet", async () => {
    // A NOTICE points the model at a line in its own emission; the mirror row is ALWAYS folded
    // (§model-entry) — the model READs it at the cited lines. No snippet duplicating the bytes.
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = noticeProvider(1);
        const t1 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });

        const p2 = await getPacket(db, t2.turnId);
        const notice = packetSection(p2, "notices");
        assert.equal(
            notice,
            "* grammar_unenforced: grammar not enforced at code point 26 @ 2:4",
            "the notice surfaced on the next packet with its bounded message and content-offset",
        );

        // The wire: a meta line carrying the position, no snippet / error:// fence. The Errors
        // section is framework status (uri+status pointers) in the user slot's status clump
        // ([§packet-cache-monotone]); render it alone so the log's JSON rows don't blur the assertions.
        const wire = PacketWire.renderSection(p2.sections.find((s) => s.name === "notices")!);
        assert.match(wire, /## Notices/);
        assert.doesNotMatch(wire, /\{"/, "no JSON dump — the section renders terse lines, not events");
        assert.doesNotMatch(wire, /error:\/\//, "no error:// snippet fence");
        assert.match(wire, /^\* grammar_unenforced: grammar not enforced at code point 26 @ 2:4$/m);

        // The mirror is ALWAYS folded — even on the NOTICE turn (the auto-OPEN trigger is retired);
        // the model READs the folded row at line 2 when it cares.
        const echo = (await db.test_log_entries_by_loop.all<{ op: string; origin: string; expanded: number; turn_id: number }>({ loop_id: loopId }))
            .find((r) => r.turn_id === t1.turnId && r.op === "model" && r.origin === "model");
        assert.ok(echo !== undefined && echo.expanded === 0, "the NOTICE turn's model echo stays folded");
    } finally { await db.close(); }
});

test("the notice buffer drains — a notice appears on exactly one packet, then is gone", async () => {
    // Errors persist (log items); engine NOTICES are ephemeral — drain-on-read, one packet only.
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = noticeProvider(2);
        const t1 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const t3 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });

        const kindsOf = async (turnId: number) =>
            packetSection(await getPacket(db, turnId), "notices")
                .split("\n")
                .filter((line) => line.includes("grammar_unenforced")).length;

        assert.equal(await kindsOf(t1.turnId), 0, "notice not visible on the turn that produced it");
        assert.equal(await kindsOf(t2.turnId), 1, "notice drained exactly once on read");
        assert.equal(await kindsOf(t3.turnId), 0, "drained notice does not reappear on subsequent packets");
    } finally { await db.close(); }
});

test("a thrown ProviderError is persisted as one exact operation failure — no turn is fabricated", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // Providers 0.32 retired the constrained-path throw: a completed exchange ALWAYS
        // returns (bytes + a conformance OBSERVATION on response.notices — the #275 test
        // below pins that path). A ProviderError reaching the engine therefore means NO
        // completed exchange exists (auth, network, rate limit) — the engine must NOT
        // fabricate an empty turn (the retired fallback laundered provider adjudications
        // into model-behavior 422s): notices the cause and propagate, so the drain
        // writes the loop terminal 500 with the message.
        const provider = new Mock({ contextWindow: 100000, responses: [drainTurn] });
        const realGenerate = provider.generate.bind(provider);
        let threw = false;
        provider.generate = async (req) => {
            if (threw) return realGenerate(req);
            threw = true;
            throw new ProviderError("mock", "unauthorized", "backend rejected the API key");
        };

        await assert.rejects(
            () => engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] }),
            (err: unknown) => {
                assert.ok(err instanceof OperationFailureError);
                assert.equal(err.result.status, 401);
                assert.equal(err.result.problem.type, "https://problems.plurnk.dev/provider/mock/unauthorized");
                assert.equal(err.result.problem.detail, "backend rejected the API key");
                assert.match(err.result.problem.instance ?? "", /^log:\/\/\//);
                return true;
            },
            "the infrastructure failure propagates — no fabricated turn absorbs it",
        );

        const failures = (await db.test_log_entries_by_loop.all<{
            op: string;
            status_rx: number;
            rx: string;
        }>({ loop_id: loopId })).filter(({ op }) => op === "error");
        assert.equal(failures.length, 1, "the provider failure has one durable owner");
        const durable = JSON.parse(failures[0]!.rx) as { status: number; problem: { detail: string; instance: string } };
        assert.equal(durable.status, 401);
        assert.equal(durable.problem.detail, "backend rejected the API key");
        assert.match(durable.problem.instance, /^log:\/\/\//);

        // A later packet projects only a terse pointer to the durable Problem.
        const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const p2 = await getPacket(db, t2.turnId);
        assert.match(packetSection(p2, "errors"), /^\* 401 log:\/\/\/.+\/error$/m);
        assert.equal(packetSection(p2, "notices").includes("unauthorized"), false, "terminal failure never masquerades as a notice");
    } finally { await db.close(); }
});

test("#275 / providers#24 — filter-mode grammar_unenforced does NOT throw: the bytes persist and a Notice with the divergence position drains onto the next packet", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // GBNF-filter mode (providers 0.19.0): generate() returns the model's UNCONSTRAINED bytes
        // and attaches a non-fatal grammar_unenforced Notice carrying the code-point
        // divergence position — it does NOT throw. The engine must persist the bytes (no empty
        // turn, the old cascade root cause) AND drain the event with a content-offset line:col the
        // model resolves against its own (born-OPEN) emission.
        const FREE = "<<PLAN:reasoning:PLAN\n<<SEND[103]:noted:SEND"; // 'N' of SEND on line 2 is code point 26
        const provider = new Mock({ contextWindow: 100000, responses: [drainTurn] }); // turn 2 drains
        const realGenerate = provider.generate.bind(provider);
        let did = false;
        provider.generate = async (req) => {
            if (did) return realGenerate(req);
            did = true;
            return {
                assistant: { content: FREE, reasoning: "thought about it", usage: { prompt: 5, completion: 10, reasoning: 2, cached: 0, total: 17 }, finishReason: "stop", model: "mock" },
                assistantRaw: { id: "x", filtered: true },
                notices: [{ source: "provider:mock", kind: "grammar_unenforced", level: "warn", message: "grammar not enforced: output rejected by the transported grammar at code point 26", position: 26 }],
            };
        };

        const t1 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });

        // #24 root-cause fix: the model's bytes SURVIVE — not nulled into an empty turn.
        const p1 = await getPacket(db, t1.turnId) as { assistant?: { content?: string }; assistantRaw?: unknown };
        assert.equal(p1.assistant?.content, FREE, "the unconstrained emission is persisted, not discarded");
        assert.notEqual(p1.assistantRaw, null, "assistantRaw populated — no empty-turn write");

        // The conflict drains onto turn 2's packet exactly once, with the provider's own source and
        // a real content-offset position (no embedded snippet — the model resolves it against its emission).
        const p2 = await getPacket(db, t2.turnId);
        assert.equal(
            packetSection(p2, "notices"),
            "* grammar_unenforced: grammar not enforced: output rejected by the transported grammar at code point 26 @ 2:4",
            "grammar_unenforced drains exactly once with its explanation and content-offset",
        );
    } finally { await db.close(); }
});

test("provider error: a terminal kind is durable product truth, never a notices notice", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const broadcasts: Array<{ payload: { loopId: number; notice: Record<string, unknown> } }> = [];
        const engine = new Engine({
            db, schemes: new SchemeRegistry(),
            noticeNotify: (_sid, payload) => { broadcasts.push({ payload: payload as { loopId: number; notice: Record<string, unknown> } }); },
        });
        const provider = new Mock({ contextWindow: 100000, responses: [] });
        provider.generate = async () => { throw new ProviderError("plurnk", "network_failure", "connection refused"); };

        // Unlike grammar_unenforced, a terminal infra error propagates out of runTurn to end the loop.
        await assert.rejects(
            engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] }),
            (err: unknown) => {
                assert.ok(err instanceof OperationFailureError);
                assert.equal(err.result.status, 503);
                assert.equal(err.result.problem.type, "https://problems.plurnk.dev/provider/plurnk/network-failure");
                assert.equal(err.result.problem.detail, "connection refused");
                return true;
            },
            "a terminal provider error propagates (ends the loop), not recovered as a no-op",
        );
        assert.equal(
            broadcasts.filter((b) => b.payload.notice.kind === "network_failure").length,
            0,
            "a terminal failure is not duplicated onto the notice channel",
        );
        const rows = await db.test_log_entries_by_loop.all<{ op: string; rx: string }>({ loop_id: loopId });
        const durable = rows.find(({ op }) => op === "error");
        assert.ok(durable !== undefined);
        assert.equal((JSON.parse(durable.rx) as { problem: { detail: string } }).problem.detail, "connection refused");
    } finally { await db.close(); }
});

test("engine brackets generate() with turn_awaiting_model → turn_generated notices (liveness heartbeat)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const broadcasts: Array<{ payload: { loopId: number; notice: Record<string, unknown> } }> = [];
        const engine = new Engine({
            db, schemes: new SchemeRegistry(),
            noticeNotify: (_sid, payload) => { broadcasts.push({ payload: payload as { loopId: number; notice: Record<string, unknown> } }); },
        });
        const provider = new Mock({ contextWindow: 100000, responses: [drainTurn] });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });

        // The two beats bracket the provider call, in order — so a client flips "thinking… → working…"
        // across the one long opaque window (submit → first committed op) instead of a static screen
        // that reads as a hang. Live-broadcast, info-level, scoped to the loop.
        const lifecycle = broadcasts.filter((b) => b.payload.notice.source === "engine:turn");
        assert.deepEqual(lifecycle.map((b) => b.payload.notice.kind), ["turn_awaiting_model", "turn_generated"], "two engine:turn beats, in generate()-bracket order");
        for (const b of lifecycle) {
            assert.equal(b.payload.notice.level, "info", "lifecycle beats are info-level progress notices, never errors");
            assert.equal(b.payload.loopId, loopId, "scoped to the loop");
        }
    } finally { await db.close(); }
});

test("a parser warning remains an advisory — valid statements complete and no durable failure is minted", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "finish despite a recoverable grammar near-miss");
        const broadcasts: Array<{ payload: { loopId: number; notice: Record<string, unknown> } }> = [];
        const engine = new Engine({
            db,
            schemes: new SchemeRegistry(),
            noticeNotify: (_sid, payload) => {
                broadcasts.push({ payload: payload as { loopId: number; notice: Record<string, unknown> } });
            },
        });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                contentResponse("<<PLAN:t:PLAN <<CLOSE(log://x)::CLOSE <<SEND[200]:done:SEND"),
            ],
        });

        const turn = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });

        assert.equal(turn.status, 200, "the valid terminal SEND still determines the turn result");
        const advisories = broadcasts.filter(({ payload }) => payload.notice.kind === "parse_advisory");
        assert.equal(advisories.length, 1, "the recoverable parser diagnosis is emitted once");
        assert.equal(advisories[0]!.payload.notice.level, "warn");
        assert.match(String(advisories[0]!.payload.notice.message), /`<<CLOSE`.*did you mean `<<FOLD`/);
        assert.deepEqual(
            advisories[0]!.payload.notice.position,
            { type: "content-offset", line: 1, column: 14 },
            "the Notice retains the parser's typed source position",
        );
        assert.deepEqual(
            await db.test_error_rows_for_run.all({ worker_id: workerId }),
            [],
            "an advisory cannot become durable failure truth",
        );
    } finally { await db.close(); }
});

test("an actionless parse failure is a LOG ITEM (op='error', status 400) — queryable + foldable, not a bespoke error:// scheme", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                contentResponse(BROKEN_STMT),                 // actionless failure (no op dispatched)
                drainTurn,
            ],
        });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });

        // The failure is a DURABLE log row — op='error', status_rx 400, actionless (no target).
        // It folds/kills/recalls like any log entry (§operation-results), so the
        // grinder's prior-turn rollback can reclaim it: one budget surface, the log.
        const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; scheme: string | null }>({ loop_id: loopId });
        const errRow = rows.find((r) => r.op === "error" && r.status_rx === 400);
        assert.ok(errRow !== undefined, "parse failure recorded as a log:///…/error item (status 400), not ephemeral notices");
        assert.equal(errRow!.scheme, null, "an error row is actionless — no target scheme");

        // No `error://` SCHEME namespace — errors live in the LOG (log:///), not a bespoke scheme.
        const errorScheme = await db.test_count_entries_by_session_scheme.get<{ n: number }>({
            workspace_id: workspaceId, scheme: "error",
        });
        assert.equal(errorScheme?.n ?? 0, 0, "no error:// scheme entries — errors are log items, queried via log:///");

        // The errors section derives a LogCoordinate POINTER (status + coordinate) to the log item.
        const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const p2 = await getPacket(db, t2.turnId);
        assert.ok(
            /^\* 400 log:\/\/\/.+\/error$/m.test(packetSection(p2, "errors")),
            "errors section surfaces a derived LogCoordinate pointer to the error log item",
        );
    } finally { await db.close(); }
});

// §model-entry — the per-turn `model` echo (origin=model, distinct from the born-OPEN turn-0
// exemplar at origin=plurnk) is ALWAYS born FOLDED (auto-OPEN on error is retired; the model READs its
// malformed emission, line-numbered, to fix it) and FOLDED on a clean turn (budget-neutral).
test("the model echo is ALWAYS born FOLDED — errored and clean turns alike (the model READs it when it cares)", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                contentResponse(BROKEN_STMT),                  // turn 1: genuine parse error
                contentResponse("<<SEND[200]:done:SEND"),      // turn 2: clean emission
            ],
        });
        const t1 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });

        const echo = async (turnId: number) =>
            (await db.test_log_entries_by_loop.all<{ op: string; origin: string; expanded: number; turn_id: number }>({ loop_id: loopId }))
                .find((r) => r.turn_id === turnId && r.op === "model" && r.origin === "model");

        const e1 = await echo(t1.turnId);
        assert.ok(e1 !== undefined, "the parse-error turn mirrors a model echo");
        assert.equal(e1!.expanded, 0, "born FOLDED even on the erred turn — auto-OPEN is retired; the model READs the cited lines");

        const e2 = await echo(t2.turnId);
        assert.ok(e2 !== undefined, "the clean turn mirrors a model echo");
        assert.equal(e2!.expanded, 0, "born FOLDED — budget-neutral until the model OPENs it");
    } finally { await db.close(); }
});

test("a notice broadcasts structured and drains as its terse model-facing projection", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "trace the broken xpath");

        // Capture the live fan-out: every Notice the engine pushes
        // to the loop's buffer also fires this callback the moment it lands.
        const broadcasts: Array<{ workspaceId: number; payload: { loopId: number; notice: Record<string, unknown> } }> = [];
        const engine = new Engine({
            db,
            schemes: new SchemeRegistry(),
            noticeNotify: (sid, payload) => { broadcasts.push({ workspaceId: sid, payload: payload as { loopId: number; notice: Record<string, unknown> } }); },
        });

        const provider = noticeProvider(1);                   // turn 1: grammar_unenforced NOTICE pushed + broadcast live
        // NOTE: errors are log items (no notice/event); the broadcast surface is for engine NOTICES.
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });

        // Client side: the notice broadcast live, scoped to the loop's workspace,
        // BEFORE turn 2 ever builds a packet.
        const liveParse = broadcasts.filter((b) => b.payload.notice.kind === "grammar_unenforced");
        assert.equal(liveParse.length, 1, "the notice broadcast live exactly once");
        assert.equal(liveParse[0].workspaceId, workspaceId, "scoped to the loop's workspace");
        assert.equal(liveParse[0].payload.loopId, loopId);
        const liveNotice = liveParse[0].payload.notice;
        assert.equal(liveNotice.source, "provider:mock");
        assert.equal(liveNotice.kind, "grammar_unenforced");
        assert.deepEqual(liveNotice.position, { type: "content-offset", line: 2, column: 4 });

        // Model side: the notice drains once as a bounded projection.
        const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const p2 = await getPacket(db, t2.turnId);
        assert.equal(
            packetSection(p2, "notices"),
            "* grammar_unenforced: grammar not enforced at code point 26 @ 2:4",
        );
    } finally { await db.close(); }
});
