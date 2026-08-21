// SPEC contract coverage for the user-packet notices and prompt-row
// surface ({§packet} / {§operation-results}). One test per contract tag. Every assertion is
// against real DB artifacts and the real wire render — no stand-ins.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import { Mock, ProviderError } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, packetSection, seedEntryWithChannel, testProviderCapacity } from "./_helpers.ts";
import { editStmt, readStmt, sendStmt, urlPath } from "./_dsl.ts";
import { OperationFailureError } from "../../src/core/results.ts";

// Response from raw content WITHOUT ops - forces the engine to run the real
// PlurnkParser rather than Mock's trusted pre-parsed seam.
const contentResponse = (content: string): MockResponse => ({
    assistant: {
        // Turns lead with PLAN; the Engine re-parses the supplied content.
        content: content.startsWith("# PLAN")
            ? content
            : `# PLAN0\nadmit the supplied turn\n\n${content}`,
        reasoning: null,
    },
    assistantRaw: null,
});

// A complete, admitted draining turn. Its only job is to run so the model's
// next packet drains the notices buffer on read.
const drainTurn = contentResponse("## SEND0 [200]\ndrained");

// A provider transport anomaly notice. Grammar verdicts are engine-owned under
// {§rail-truth-engine-verdict}; the provider notice path remains for observations
// such as a decode escaping into a discarded channel.
// `extraDrains` clean turns follow so the buffer can be observed draining.
const NOTICE_CONTENT = "# PLAN0\nreasoning\n\n## SEND0 [200]\nnoted";
const NOTICE_POS = Array.from(NOTICE_CONTENT.slice(0, NOTICE_CONTENT.indexOf("## SEND0") + 3)).length;
const noticeProvider = (extraDrains: number) => {
    const provider = new Mock({ contextWindow: 100000, responses: Array.from({ length: extraDrains }, () => drainTurn) });
    const real = provider.generate.bind(provider);
    let did = false;
    provider.generate = async (req) => {
        if (did) return real(req);
        did = true;
        const accounting = {
            provider: "provider:mock",
            model: "mock",
            outcome: "response",
            usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
            cost: {
                kind: "estimated",
                amount: { amount: "0", currency: "USD" },
                source: "notice fixture",
            },
        } as const;
        const settle = await req.observeRequest?.({ provider: accounting.provider, model: accounting.model });
        await settle?.(accounting);
        return {
            assistant: { content: NOTICE_CONTENT, reasoning: null, finishReason: "stop", model: "mock" },
            assistantRaw: { id: "x", filtered: true },
            accounting: [accounting],
            capacity: testProviderCapacity(req.messages, provider.contextWindow),
            notices: [{ source: "provider:mock", kind: "grammar_unenforced", level: "warn", message: "decode escaped into a discarded channel", position: NOTICE_POS }],
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
    // A NOTICE points the model at a line in its own emission; turnOps is ALWAYS folded
    // ({§turn-ops-entry}) — the model READs it at the cited lines. No snippet duplicating the bytes.
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = noticeProvider(1);
        const t1 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });

        const p1 = await getPacket(db, t1.turnId) as { assistant?: { content?: string } };
        assert.equal(p1.assistant?.content, NOTICE_CONTENT, "a transport notice does not discard completed model bytes");
        const p2 = await getPacket(db, t2.turnId);
        const notice = packetSection(p2, "notices");
        assert.equal(
            notice,
            "* grammar_unenforced: decode escaped into a discarded channel @ 4:3",
            "the notice surfaced on the next packet with its bounded message and content-offset",
        );

        // The wire: a meta line carrying the position, no snippet / error:// fence. The Errors
        // section is framework status (uri+status pointers) in the user slot's status clump
        // ({§packet-cache-monotone}); render it alone so the log's JSON rows don't blur the assertions.
        const wire = PacketWire.renderSection(p2.sections.find((s) => s.name === "notices")!);
        assert.match(wire, /## Notices/);
        assert.doesNotMatch(wire, /\{"/, "no JSON dump — the section renders terse lines, not events");
        assert.doesNotMatch(wire, /error:\/\//, "no error:// snippet fence");
        assert.match(wire, /^\* grammar_unenforced: decode escaped into a discarded channel @ 4:3$/m);

        // The mirror is ALWAYS folded — even on the NOTICE turn (the auto-OPEN trigger is retired);
        // the model READs the folded row at the cited line when it cares.
        const echo = (await db.test_log_entries_by_loop.all<{ op: string | null; origin: string; folded: string; turn_id: number; attrs: string }>({ loop_id: loopId }))
            .find((r) => r.turn_id === t1.turnId && r.op === null && r.origin === "model" && JSON.parse(r.attrs).kind === "turnOps");
        assert.ok(echo !== undefined && echo.folded === "[[1,-1]]", "the NOTICE turn's model echo stays folded");
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

test("a tolerated three-coordinate scope reports its exact canonical region on the next packet ({§text-scope-runtime})", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    await seedEntryWithChannel(db, {
        workspaceId,
        pathname: "/x",
        content: "alpha\nbeta\ngamma\ndelta",
        mimetype: "text/markdown",
    });
    try {
        const stmtTurn = (ops: PlurnkStatement[]): MockResponse => ({
            assistant: {
                content: "",
                ops,
                reasoning: null,
            },
        } as MockResponse);
        const scopedRead = readStmt(urlPath("worker", "/x"));
        scopedRead.lineMarker = { marks: [2, 1, 3] };
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                stmtTurn([scopedRead, sendStmt(102, null, "read")]),
                stmtTurn([sendStmt(200, null, "done")]),
            ],
        });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const second = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const packet = await getPacket(db, second.turnId);

        assert.match(
            packetSection(packet, "log"),
            /"body":"\n@[0-9A-Za-z]{5} 2:beta\n@[0-9A-Za-z]{5} 3:gamma\n"\}/,
        );
        assert.equal(
            packetSection(packet, "notices"),
            "* scope_normalized: Scope <2,1,3> was normalized to <2,1,3,6>.",
        );
    } finally { await db.close(); }
});

test("an EDIT batch reports each tolerated scope once in authored order ({§text-scope-runtime})", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    const target = urlPath("worker", "/x");
    await seedEntryWithChannel(db, {
        workspaceId,
        pathname: "/x",
        content: "alpha\nbeta\ngamma\ndelta",
        mimetype: "text/markdown",
    });
    try {
        const stmtTurn = (ops: PlurnkStatement[]): MockResponse => ({
            assistant: {
                content: "",
                ops,
                reasoning: null,
            },
        } as MockResponse);
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                stmtTurn([
                    editStmt(target, "A", null, { marks: [1, 2, 1] }),
                    editStmt(target, "G", null, { marks: [3, 2, 3] }),
                    sendStmt(102, null, "edited"),
                ]),
                stmtTurn([sendStmt(200, null, "done")]),
            ],
        });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const second = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });

        assert.equal(
            packetSection(await getPacket(db, second.turnId), "notices"),
            [
                "* scope_normalized: Scope <1,2,1> was normalized to <1,2,1,6>.",
                "* scope_normalized: Scope <3,2,3> was normalized to <3,2,3,6>.",
            ].join("\n"),
        );
    } finally { await db.close(); }
});

test("a thrown ProviderError is persisted as one exact operation failure — no turn is fabricated", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // A ProviderError means no completed exchange exists (auth, network, rate
        // limit). The engine persists that failure and does not invent model bytes.
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

test("a parser warning remains advisory while the independently invalid mutation stays durable", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "finish despite a recoverable grammar advisory");
        const broadcasts: Array<{ payload: { loopId: number; notice: Record<string, unknown> } }> = [];
        const engine = new Engine({
            db,
            schemes: new SchemeRegistry(),
            noticeNotify: (_sid, payload) => {
                broadcasts.push({ payload: payload as { loopId: number; notice: Record<string, unknown> } });
            },
        });
        const emission = "# PLAN0\nedit the file\n\n## EDIT0 [+src/example.ts]\nbody\n\n## SEND0 [200]\ndone";
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                contentResponse(emission),
            ],
        });

        const turn = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });

        assert.equal(turn.status, 102, "the invalid mutation prevents premature terminal completion");
        assert.equal(turn.emissionAttempts, 1, "the advisory does not reject and reroll the trustworthy frame");
        assert.ok(
            turn.outcomes.some(({ op, status }) => op === "EDIT" && status === 400),
            "the targetless mutation fails through ordinary operation execution",
        );
        const advisories = broadcasts.filter(({ payload }) => payload.notice.kind === "parse_advisory");
        assert.equal(advisories.length, 1, "the recoverable parser diagnosis is emitted once");
        assert.equal(advisories[0]!.payload.notice.level, "warn");
        assert.match(String(advisories[0]!.payload.notice.message), /has no `\(target\)`/);
        assert.deepEqual(
            advisories[0]!.payload.notice.position,
            { type: "content-offset", line: 4, column: 0 },
            "the Notice retains the parser's typed source position",
        );
        const [failedEdit] = await db.test_log_entries_by_worker_op_full.all<{
            status_rx: number;
        }>({ worker_id: workerId, op: "EDIT" });
        assert.equal(failedEdit?.status_rx, 400, "the operation's own row preserves its durable failure");
        assert.deepEqual(
            await db.test_error_rows_for_worker.all({ worker_id: workerId }),
            [],
            "the advisory and operation failure mint no substitute error row",
        );
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
        assert.deepEqual(liveNotice.position, { type: "content-offset", line: 4, column: 3 });

        // Model side: the notice drains once as a bounded projection.
        const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const p2 = await getPacket(db, t2.turnId);
        assert.equal(
            packetSection(p2, "notices"),
            "* grammar_unenforced: decode escaped into a discarded channel @ 4:3",
        );
    } finally { await db.close(); }
});
