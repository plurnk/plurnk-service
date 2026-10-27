import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import NoticeChannel from "../../src/core/NoticeChannel.ts";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import RuntimeSession from "../../src/core/RuntimeSession.ts";
import LoopDocs from "../../src/server/loopDocs.ts";
import Daemon from "../../src/server/Daemon.ts";
import Results, { OperationFailureError } from "../../src/core/results.ts";
import GitMembership from "../../src/core/git-membership.ts";
import ResourceState from "./resource-state.ts";
import { completeStmt, noteStmt, editStmt, readStmt, urlPath, findStmt } from "./_dsl.ts";
import { type PlurnkStatement, isExecution } from "@plurnk/plurnk-contracts";
import { PlurnkParser, parsePath } from "@plurnk/plurnk-parser";
import { type StoredPacketSection } from "../../src/core/StoredPacket.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import { Mock, type MockResponse, ProviderError } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertSession, insertLoop, seedEntryWithChannel, rootWorkspace } from "./_db.ts";
import { packetSection, logEntries } from "./_packet.ts";
import { ownSession, TEST_OWNER } from "./_approval.ts";
import { testProviderCapacity, viableWindow } from "./_provider.ts";
import { rm, readFile, mkdtemp, writeFile } from "node:fs/promises";
import { liveWorkspace, seedEntry } from "../_live-harness.ts";
import { namedModelSession } from "./_sessions.ts";
import { Lexer } from "marked";
import { DEFAULT_MIMETYPES, makeSchemeCtx } from "./_scheme.ts";
import { testExecutors } from "./_execs.ts";
import { fixtureExecutors } from "./_mock.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { type PlurnkSchemeContext } from "../../src/core/scheme-types.ts";

describe("contract-notices", () => {
const UNACCOUNTED = "> [!WARNING]\n> 5000 output tokens billed; 1 visible across content and reasoning @ 2:3 [output_unaccounted]";
// {§operation-results} — the turns under test continue without a NOTE, and the next packet says so.
const CONTINUED = "> [!WARNING]\n> YOU MUST persist all new facts, ideas, and plans in NOTEs on every turn. The turn continued without a NOTE. [continued_without_note]";
const scope = (requested: string, canonical: string): string =>
    `> [!WARNING]\n> YOU SHOULD write the normalized scope. Scope <${requested}> was normalized to <${canonical}>. [scope_normalized]`;

// Response from raw content WITHOUT ops - forces the engine to run the real
// PlurnkParser rather than Mock's trusted pre-parsed seam.
const contentResponse = (content: string): MockResponse => ({
    assistant: {
        content,
        reasoning: null,
    },
    assistantRaw: null,
});

// A complete, admitted draining turn. Its only job is to run so the model's
// next packet drains the notices buffer on read.
const drainTurn = contentResponse("````SEND [200]\ndrained\n````");

// A provider transport anomaly notice: the provider notice path carries observations
// such as a decode escaping into a discarded channel ({§provider-instantiation} grades nothing).
// `extraDrains` clean turns follow so the buffer can be observed draining.
const NOTICE_CONTENT = "\n````SEND\nnoted\n````";
const NOTICE_POS = Array.from(NOTICE_CONTENT.slice(0, NOTICE_CONTENT.indexOf("````SEND") + 3)).length;
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
            notices: [{ source: "provider:mock", kind: "output_unaccounted", level: "warn", message: "5000 output tokens billed; 1 visible across content and reasoning", position: NOTICE_POS }],
        };
    };
    return provider;
};

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "what is the capital of france?");
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, engine, workspaceId, sessionId, loopId };
};

const getPacket = async (db: Awaited<ReturnType<typeof openMigrated>>, turnId: number) => {
    const row = await db.test_get_packet.get<{ packet: string }>({ id: turnId });
    return JSON.parse(row?.packet ?? "{}") as { sections: StoredPacketSection[] };
};

test("{§operation-results} a content-offset NOTICE (output_unaccounted) carries a line:col pointer, no embedded snippet", async () => {
    // A NOTICE points at exact source retrievable through ops://<session>/, not an automatic log row.
    // ({§log-history-projection}) — the model READs it at the cited lines. No snippet duplicating the bytes.
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const provider = noticeProvider(1);
        const t1 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        const p1 = await getPacket(db, t1.turnId) as { assistant?: { content?: string } };
        assert.equal(p1.assistant?.content, NOTICE_CONTENT, "a transport notice does not discard completed model bytes");
        const p2 = await getPacket(db, t2.turnId);
        const notice = packetSection(p2, "notices");
        assert.equal(
            notice,
            `${UNACCOUNTED}\n\n${CONTINUED}`,
            "the notice surfaced on the next packet with its bounded message and content-offset",
        );

        // The wire: a meta line carrying the position, no snippet / error:// fence. The Errors
        // section is framework status (uri+status pointers) in the user slot's status clump
        // ({§packet-assembly}); render it alone so the log's JSON rows don't blur the assertions.
        const wire = PacketWire.renderSection(p2.sections.find((s) => s.name === "notices")!);
        assert.match(wire, /## Notices/);
        assert.doesNotMatch(wire, /\{"/, "no JSON dump — the section renders terse lines, not events");
        assert.match(wire, /^> 5000 output tokens billed; 1 visible across content and reasoning @ 2:3 \[output_unaccounted\]$/m);

        const programs = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
        const source = programs.find(({ turn_id, kind }) => turn_id === t1.turnId && kind === "ops");
        assert.ok(source?.content, "the notice's source is retained for a scoped ops READ");
        const echo = (await db.test_log_entries_by_loop.all<{ op: string | null; turn_id: number }>({ loop_id: loopId }))
            .find((row) => row.turn_id === t1.turnId && row.op === null);
        assert.equal(echo, undefined, "a notice does not reintroduce automatic source log rows");
    } finally { await db.close(); }
});

test("{§operation-results} the notice buffer drains — a notice appears on exactly one packet, then is gone", async () => {
    // Errors persist (log items); engine NOTICES are ephemeral — drain-on-read, one packet only.
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const provider = noticeProvider(2);
        const t1 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const t3 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        const kindsOf = async (turnId: number) =>
            packetSection(await getPacket(db, turnId), "notices")
                .split("\n")
                .filter((line) => line.includes("output_unaccounted")).length;

        assert.equal(await kindsOf(t1.turnId), 0, "notice not visible on the turn that produced it");
        assert.equal(await kindsOf(t2.turnId), 1, "notice drained exactly once on read");
        assert.equal(await kindsOf(t3.turnId), 0, "drained notice does not reappear on subsequent packets");
    } finally { await db.close(); }
});

for (const fail of [false, true]) {
    test(`{§operation-results} ${fail ? "exceptional exit" : "normal completion"} releases undelivered notices`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "notice-cleanup");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Record the observation, then finish.");
        const pushed = t.mock.method(NoticeChannel.prototype, "push");
        const cause = new Error("notice delivery fixture failed");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), noticeNotify: (_workspaceId, { notice }) => {
            if (fail && notice.kind === "parse_advisory") throw cause;
        } });
        const provider = new Mock({ contextWindow: 100_000, responses: [contentResponse("````NOTE remember\n````\n\n````SEND [200]\ndone\n````")] });
        const running = engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [] });
        if (fail) await assert.rejects(running, (error) => error === cause);
        else assert.equal((await running).result.status, 200);
        const warning = pushed.mock.calls.find(({ arguments: args }) => args[2] === loopId && args[3].kind === "parse_advisory");
        assert.ok(warning, "the last emission produced a pending warning");
        assert.deepEqual((warning.this as NoticeChannel).drain(loopId), [], "no future model packet exists to consume the buffer");
    });
}

test("a tolerated three-coordinate scope reports its exact canonical region on the next packet ({§zero-width-column-one-insert})", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
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
        });
        const scopedRead = readStmt(urlPath("workspace", "/x"));
        scopedRead.lineMarker = { marks: [2, 1, 3] };
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                stmtTurn([scopedRead, noteStmt("read")]),
                stmtTurn([completeStmt("done")]),
            ],
        });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const second = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const packet = await getPacket(db, second.turnId);

        const read = logEntries(packet).find(({ logPath, body }) =>
            typeof logPath === "string" && logPath.endsWith("/READ") && /2<@[0-9A-Za-z]{5}>beta/.test(String(body)));
        assert.match(String(read?.body), /^2<@[0-9A-Za-z]{5}>beta\n3<@[0-9A-Za-z]{5}>gamma\n$/);
        assert.equal(
            packetSection(packet, "notices"),
            scope("2,1,3", "2,1,3,6"),
        );
    } finally { await db.close(); }
});

test("{§slicer-text-algebra}: a zero-start READ delivers its body and one warning without a failed operation", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        await seedEntryWithChannel(db, { workspaceId, pathname: "/zero-start", content: "alpha\nbeta\ngamma", mimetype: "text/plain" });
        const scopedRead = readStmt(urlPath("workspace", "/zero-start"));
        scopedRead.lineMarker = { marks: [0, 120] };
        const provider = new Mock({ contextWindow: 100000, responses: [
            { assistant: { content: "", ops: [scopedRead], reasoning: null } },
            { assistant: { content: "", ops: [completeStmt("done")], reasoning: null } },
        ] });
        const first = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const second = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const packet = await getPacket(db, second.turnId);
        const read = logEntries(packet).find(({ logPath, body }) => logPath.endsWith("/READ") && /1<@[0-9A-Za-z]{5}>alpha/.test(String(body)));
        assert.match(String(read?.body), /1<@[0-9A-Za-z]{5}>alpha\n2<@[0-9A-Za-z]{5}>beta\n3<@[0-9A-Za-z]{5}>gamma/);
        assert.equal(packetSection(packet, "notices"),
            `${scope("0,120", "1,120")}\n\n${CONTINUED}`);
        const receipts = await db.test_log_entries_by_turn.all<{ op: string; status_rx: number }>({ turn_id: first.turnId });
        assert.deepEqual(receipts.filter(({ op }) => op === "READ").map(({ status_rx }) => status_rx), [200]);
        assert.doesNotMatch(packetSection(packet, "notices"), /strike|failed/i);
    } finally { await db.close(); }
});

test("an EDIT batch reports each tolerated scope once in authored order ({§zero-width-column-one-insert})", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    const target = urlPath("workspace", "/x");
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
        });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                stmtTurn([
                    editStmt(target, "A", { marks: [1, 2, 1] }),
                    editStmt(target, "G", { marks: [3, 2, 3] }),
                    noteStmt("edited"),
                ]),
                stmtTurn([completeStmt("done")]),
            ],
        });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const second = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        assert.equal(
            packetSection(await getPacket(db, second.turnId), "notices"),
            [scope("1,2,1", "1,2,1,6"), scope("3,2,3", "3,2,3,6")].join("\n\n"),
        );
    } finally { await db.close(); }
});

test("{§packet} a thrown ProviderError is persisted as one exact operation failure — no turn is fabricated", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
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
            () => engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] }),
            (err: unknown) => {
                assert.ok(err instanceof OperationFailureError);
                assert.equal(err.result.status, 401);
                assert.equal(err.result.problem.type, "https://problems.plurnk.xyz/provider/mock/unauthorized");
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
        const durable = JSON.parse(failures[0].rx) as { status: number; problem: { detail: string; instance: string } };
        assert.equal(durable.status, 401);
        assert.equal(durable.problem.detail, "backend rejected the API key");
        assert.match(durable.problem.instance, /^log:\/\/\//);

        // A later packet projects only a terse pointer to the durable Problem.
        const t2 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const p2 = await getPacket(db, t2.turnId);
        assert.match(packetSection(p2, "errors"), /"status":401,"path":"log:\/\/\/[^"]+\/error"/);
        assert.equal(packetSection(p2, "notices").includes("unauthorized"), false, "terminal failure never masquerades as a notice");
    } finally { await db.close(); }
});

test("{§engine-rails} provider error: a terminal kind is durable product truth, never a notices notice", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        await ownSession(db, workspaceId, sessionId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const broadcasts: Array<{ payload: { loopId: number; notice: Record<string, unknown> } }> = [];
        const engine = new Engine({
            db, schemes: new SchemeRegistry(),
            noticeNotify: (_sid, payload) => { broadcasts.push({ payload: payload }); },
        });
        const provider = new Mock({ contextWindow: 100000, responses: [] });
        provider.generate = async () => { throw new ProviderError("plurnk", "network_failure", "connection refused"); };

        // {§engine-rails} — a transient infra failure never ends the loop: the turn retries with
        // backoff (the Mock tier's budget is 1.5 s) and, still failing, parks as a 202 wait.
        const turn = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.equal(turn.status, 202, "the turn parks instead of failing the loop");
        assert.equal(turn.providerParked, true);
        assert.equal(turn.providerFailure?.status, 503);
        assert.equal(turn.providerFailure?.problem?.type, "https://problems.plurnk.xyz/provider/plurnk/network-failure");
        assert.equal(turn.providerFailure?.problem?.detail, "connection refused");
        assert.equal(
            broadcasts.filter((b) => b.payload.notice.kind === "network_failure").length,
            0,
            "the provider's own failure is not duplicated onto the notice channel",
        );
        const recovery = broadcasts.filter((b) => b.payload.notice.source === "engine:provider").map((b) => b.payload.notice);
        assert.ok(recovery.length >= 2, "every retry and the park are noticed");
        assert.ok(recovery.slice(0, -1).every((notice) => notice.kind === "provider_unavailable" && notice.level === "warn" && /retrying in/u.test(String(notice.message))));
        assert.equal(recovery.at(-1)?.level, "error");
        assert.match(String(recovery.at(-1)?.message), /parked/u);
        const rows = await db.test_log_entries_by_loop.all<{ op: string; rx: string }>({ loop_id: loopId });
        const durable = rows.find(({ op }) => op === "error");
        assert.ok(durable !== undefined);
        assert.equal((JSON.parse(durable.rx) as { problem: { detail: string } }).problem.detail, "connection refused");
    } finally { await db.close(); }
});

test("{§operation-results} engine brackets generate() with turn_awaiting_model → turn_generated notices (liveness heartbeat)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const broadcasts: Array<{ payload: { loopId: number; notice: Record<string, unknown> } }> = [];
        const engine = new Engine({
            db, schemes: new SchemeRegistry(),
            noticeNotify: (_sid, payload) => { broadcasts.push({ payload: payload }); },
        });
        const provider = new Mock({ contextWindow: 100000, responses: [drainTurn] });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        // The two beats bracket the provider call, in order — so a client flips "reasoning… → working…"
        // across the one long opaque window (submit → first committed op) instead of a static screen
        // that reads as a hang. Live-broadcast, info-level, scoped to the loop.
        const lifecycle = broadcasts.filter((b) => b.payload.notice.source === "engine:turn");
        assert.deepEqual(lifecycle.map((b) => b.payload.notice.kind), ["turn_awaiting_model", "turn_generated"], "two engine:turn beats, in generate()-bracket order");
        // {§operation-results} (#465) — the completion beat carries the turn's exact
        // settled wire accounting, so a live watcher accrues loop cost per turn.
        const generated = lifecycle[1].payload.notice as {
            accounting?: { requests: number; costUsd: string | null; inputTokens: number | null; outputTokens: number | null };
        };
        assert.deepEqual(generated.accounting, {
            requests: 1,
            costUsd: "0",
            knownCostUsd: "0",
            inputTokens: 0,
            knownInputTokens: 0,
            outputTokens: 0,
            knownOutputTokens: 0,
            reasoningTokens: null,
            knownReasoningTokens: null,
            cacheReadTokens: null,
            knownCacheReadTokens: null,
        }, "the exact settled derivation rides turn_generated");
        for (const b of lifecycle) {
            assert.equal(b.payload.notice.level, "info", "lifecycle beats are info-level progress notices, never errors");
            assert.equal(b.payload.loopId, loopId, "scoped to the loop");
        }
    } finally { await db.close(); }
});

test("{§operation-results} a parser warning remains advisory while the independently invalid mutation stays durable", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "finish despite a recoverable grammar advisory");
        const broadcasts: Array<{ payload: { loopId: number; notice: Record<string, unknown> } }> = [];
        const engine = new Engine({
            db,
            schemes: new SchemeRegistry(),
            noticeNotify: (_sid, payload) => {
                broadcasts.push({ payload: payload });
            },
        });
        const emission = "\n````EDIT (src/example.ts<1,-1>)\nbody\n````\n\n````SEND\ndone\n````";
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                contentResponse(emission),
            ],
        });

        const turn = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        assert.equal(turn.status, 102, "the invalid mutation prevents premature terminal completion");
        assert.equal(turn.emissionAttempts, 1, "the advisory does not reject and reroll the trustworthy frame");
        assert.ok(
            turn.outcomes.some(({ op, status }) => op === "EDIT" && status === 400),
            "the targetless mutation fails through ordinary operation execution",
        );
        const advisories = broadcasts.filter(({ payload }) => payload.notice.kind === "parse_advisory");
        assert.equal(advisories.length, 1, "the recoverable parser diagnosis is emitted once");
        assert.equal(advisories[0].payload.notice.level, "warn");
        assert.match(String(advisories[0].payload.notice.message), /The scope was inside the target slot; it was applied as the operation scope\./);
        assert.deepEqual(
            advisories[0].payload.notice.position,
            { type: "content-offset", line: 2, column: 24 },
            "the Notice retains the parser's typed source position",
        );
        const [failedEdit] = await db.test_log_entries_by_session_op_full.all<{
            status_rx: number;
        }>({ session_id: sessionId, op: "EDIT" });
        assert.equal(failedEdit?.status_rx, 400, "the operation's own row preserves its durable failure");
        assert.deepEqual(
            await db.test_error_rows_for_session.all({ session_id: sessionId }),
            [],
            "the advisory and operation failure mint no substitute error row",
        );
    } finally { await db.close(); }
});

test("{§packet} a notice broadcasts structured and drains as its terse model-facing projection", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "trace the broken xpath");

        // Capture the live fan-out: every Notice the engine pushes
        // to the loop's buffer also fires this callback the moment it lands.
        const broadcasts: Array<{ workspaceId: number; payload: { loopId: number; notice: Record<string, unknown> } }> = [];
        const engine = new Engine({
            db,
            schemes: new SchemeRegistry(),
            noticeNotify: (sid, payload) => { broadcasts.push({ workspaceId: sid, payload: payload }); },
        });

        const provider = noticeProvider(1);                   // turn 1: output_unaccounted NOTICE pushed + broadcast live
        // NOTE: errors are log items (no notice/event); the broadcast surface is for engine NOTICES.
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        // Client side: the notice broadcast live, scoped to the loop's workspace,
        // BEFORE turn 2 ever builds a packet.
        const liveParse = broadcasts.filter((b) => b.payload.notice.kind === "output_unaccounted");
        assert.equal(liveParse.length, 1, "the notice broadcast live exactly once");
        assert.equal(liveParse[0].workspaceId, workspaceId, "scoped to the loop's workspace");
        assert.equal(liveParse[0].payload.loopId, loopId);
        const liveNotice = liveParse[0].payload.notice;
        assert.equal(liveNotice.source, "provider:mock");
        assert.equal(liveNotice.kind, "output_unaccounted");
        assert.deepEqual(liveNotice.position, { type: "content-offset", line: 2, column: 3 });

        // Model side: the notice drains once as a bounded projection.
        const t2 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const p2 = await getPacket(db, t2.turnId);
        assert.equal(
            packetSection(p2, "notices"),
            `${UNACCOUNTED}\n\n${CONTINUED}`,
        );
    } finally { await db.close(); }
});

test("{§operation-fences}: literal programs inside a longer fence produce no spurious parse advisory", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const emission = "`````EDIT (workspace:///a.md) <!-- first note -->\nalpha\n````EDIT (workspace:///b.md) <!-- literal example -->\nbeta\n````\n````EDIT (workspace:///c.md)\ngamma\n````\n`````\n````NOTE\ncontinue\n````";
        const provider = new Mock({ contextWindow: 100000, responses: [contentResponse(emission), contentResponse("````SEND [200]\ndone\n````")] });
        const t1 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.equal(t1.emissionAttempts, 1);
        const edits = t1.outcomes.filter(({ op }) => op === "EDIT");
        assert.equal(edits.length, 1, "the nested programs are one EDIT's literal body");
        const t2 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const p2 = await getPacket(db, t2.turnId);
        const notice = packetSection(p2, "notices");
        assert.doesNotMatch(notice, /parse_advisory|parse_error/, "literal examples are not probable mistakes");
    } finally { await db.close(); }
});
});

describe("live-harness-resources", () => {
test("{§tokenomics} live fixtures obey resource publication and query contracts", async (t) => {
    const provider = new Mock({ contextWindow: 100_000, responses: [] });
    t.mock.method(ProviderInstantiate, "loadActiveProvider", async () => provider);
    const inference = t.mock.method(provider, "generate");
    const workspace = await liveWorkspace({ name: "harness-resource-publication" });
    try {
        const sessionId = await namedModelSession(workspace.daemon, workspace.workspaceId, "main");
        for (const content of ["alpha\nbeta\ngamma", ""]) {
            await t.test(`{§tokenomics} ${content.length === 0 ? "empty" : "nonempty"} fixtures have their actual curation weight`, async () => {
                const entryId = await seedEntry(workspace.db, workspace.workspaceId, {
                    pathname: content.length === 0 ? "empty.md" : "lines.md", content,
                });
                const channels = await workspace.db.entry_read_channels.all<{
                    name: string; content: string; weight: number;
                }>({ entry_id: entryId });
                const body = channels.find(({ name }) => name === "body");
                assert.ok(body);
                assert.equal(body.content, content);
                assert.equal(body.weight, contentWeight(content));
            });
        }

        const html = "<html><body><h1>Welcome</h1></body></html>";
        const entryId = await seedEntry(workspace.db, workspace.workspaceId, {
            pathname: "page.html", content: html, mimetype: "text/html",
        });
        await t.test("{§channel-selection} an HTML fixture retains its source and publishes its readable sibling", async () => {
            const channels = await workspace.db.entry_read_channels.all<{
                name: string; content: string; mimetype: string; weight: number;
            }>({ entry_id: entryId });
            const source = channels.find(({ name }) => name === "body");
            assert.equal(source?.content, html);
            assert.equal(source?.mimetype, "text/html");
            const readable = channels.find(({ name }) => name === "readable");
            assert.ok(readable, "the live fixture uses the production readable projection");
            assert.match(readable.content, /Welcome/u);
            assert.equal(readable.mimetype, "text/markdown");
            assert.equal(readable.weight, contentWeight(readable.content));
        });
        await t.test("{§mimetype-query} an HTML fixture answers the live story's XPath through the real dispatcher", async () => {
            const [result] = await workspace.daemon.dispatchClientAction({
                workspaceId: workspace.workspaceId, actor: TEST_OWNER, contextSessionId: sessionId,
                statements: [readStmt(parsePath("workspace:///page.html"), { marks: [1, -1] }, {
                    dialect: "xpath", raw: "//h1",
                })],
            });
            assert.ok(result !== undefined);
            assert.equal(result.status, 200);
            assert.equal(result.matched, 1);
            assert.match(String(result.content), /Welcome/u);
        });
        await t.test("{§channel-selection} ordinary READ keeps the fixture's source text", async () => {
            const [result] = await workspace.daemon.dispatchClientAction({
                workspaceId: workspace.workspaceId, actor: TEST_OWNER, contextSessionId: sessionId,
                statements: [readStmt(parsePath("workspace:///page.html"), { marks: [1, -1] })],
            });
            assert.ok(result !== undefined);
            assert.equal(result.status, 200);
            assert.equal(result.content, html);
        });
        await t.test("{§mimetype-query} JSON fixtures support structural READ", async () => {
            const content = '{"answer":42}';
            await seedEntry(workspace.db, workspace.workspaceId, {
                pathname: "answer.json", content, mimetype: "application/json",
            });
            const [result] = await workspace.daemon.dispatchClientAction({
                workspaceId: workspace.workspaceId, actor: TEST_OWNER, contextSessionId: sessionId,
                statements: [readStmt(parsePath("workspace:///answer.json"), { marks: [1, -1] }, {
                    dialect: "jsonpath", raw: "$.answer",
                })],
            });
            assert.ok(result !== undefined);
            assert.equal(result.status, 200);
            assert.equal(result.matched, 1);
            assert.equal(result.content, content);
        });
        await t.test("{§matcher-dispatch} fixtures enter the ordinary full-text index", async () => {
            await seedEntry(workspace.db, workspace.workspaceId, {
                pathname: "notes.md", content: "Checkpoint retention is working.",
            });
            const [result] = await workspace.daemon.dispatchClientAction({
                workspaceId: workspace.workspaceId, actor: TEST_OWNER, contextSessionId: sessionId,
                statements: [findStmt(parsePath("workspace:///notes.md"), { dialect: "fts", raw: "~checkpoint" })],
            });
            assert.ok(result !== undefined);
            assert.equal(result.status, 200);
            assert.deepEqual(JSON.parse(String(result.content)), [{
                region: "<1,1,1,11>", matched: "Checkpoint",
            }]);
        });
        assert.equal(inference.mock.callCount(), 0, "publishing and inspecting fixtures requires no inference");
    } finally {
        await workspace.cleanup();
        await rm(workspace.runDir, { recursive: true, force: true });
    }
});
});

describe("loop-docs", () => {
class FixtureEngine extends Engine {
    documents: Array<{ pathname: string; content: string }> = [];

    override async referenceEntries(): Promise<Array<{ pathname: string; content: string }>> {
        return this.documents;
    }
}

test("{§application-session-observation} {§application-session-observation} maintenance preserves work lifecycle and scheduler history", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db });
    try {
        const engine = new FixtureEngine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const workspaceId = await insertWorkspace(db, "maintenance-status");
        for (const [status, lifecycle] of [[null, "idle"], [100, "queued"], [102, "running"], [202, "parked"], [200, "completed"], [499, "cancelled"], [500, "failed"]] as const) {
            const sessionId = await insertSession(db, workspaceId, null, `session-${lifecycle}`, "model");
            const loopId = status === null ? null : await insertLoop(db, sessionId, 1, "do the work");
            if (loopId !== null) {
                await db.test_set_loop_status.run({
                    id: loopId,
                    status,
                    terminal_result: status === 500 || status === 499 ? JSON.stringify(Results.attachInstance(
                        status === 500 ? Results.failure("engine:fixture", "failed", 500, "Work failed.") : Results.failure("engine:fixture", "cancelled", 499, "Work cancelled."),
                        `session://session-${lifecycle}`,
                    ))
                        : status === 200 ? JSON.stringify({ status: 200 }) : null,
                });
            }
            engine.documents = [{ pathname: "/_plurnk/plurnk/tool.md", content: "# Tool\n\nReady." }];
            await LoopDocs.materialize(engine, db, workspaceId);
            const session = await daemon.readSession({ workspaceId, identity: { id: sessionId } });
            assert.equal(session?.lifecycle, lifecycle, "housekeeping does not replace work status");
            assert.equal((await daemon.listSessions(workspaceId)).find(({ id }) => id === sessionId)?.lifecycle, lifecycle);
            assert.deepEqual((await daemon.listSessionLoops({ workspaceId, sessionId })).map(({ id }) => id), loopId === null ? [] : [loopId],
                "status snapshots see work, not administrative housekeeping loops");
            const loops = await db.test_loop_queue_by_session.all<{ id: number }>({ session_id: sessionId });
            assert.deepEqual(loops.map(({ id }) => id), loopId === null ? [] : [loopId]);
            const maintenance = await db.test_get_loop_by_session.get<{ id: number }>({ session_id: await RuntimeSession.ensure(db, workspaceId) });
            assert.ok(maintenance);
            const turns = await db.test_list_turns_in_loop.all<{ kind: string }>({ loop_id: maintenance.id });
            assert.deepEqual(turns.map(({ kind }) => kind), ["maintenance"], "maintenance remains ordinary durable history");
        }
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§env-delta} generated child documentation is durable without publishing a task conclusion", async () => {
    const db = await openMigrated();
    try {
        const engine = new FixtureEngine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const workspaceId = await insertWorkspace(db, "child-docs-conclusion");
        const parentId = await insertSession(db, workspaceId, null, "parent");
        const childId = await insertSession(db, workspaceId, parentId, "child");
        const parentLoopId = await insertLoop(db, parentId, 1, "observe child");
        engine.documents = [{ pathname: "/_plurnk/plurnk/tool.md", content: "# Tool\n\nReady to use." }];

        await LoopDocs.materialize(engine, db, workspaceId);
        assert.equal(await db.test_get_loop_by_session.get({ session_id: childId }), undefined);
        const adminLoop = await db.test_get_loop_by_session.get<{ id: number }>({ session_id: await RuntimeSession.ensure(db, workspaceId) });
        assert.ok(adminLoop);
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: adminLoop.id }))?.status, 200,
            "the real maintenance program concluded");
        const turns = await db.test_list_turns_in_loop.all<{ id: number; producer: string; kind: string; status: number }>({ loop_id: adminLoop.id });
        assert.deepEqual(turns.map(({ producer, kind, status }) => ({ producer, kind, status })), [
            { producer: "_plurnk", kind: "maintenance", status: 200 },
        ]);
        const doc = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: "/_plurnk/plurnk/tool.md", scheme: "workspace", name: "body",
        });
        assert.equal(doc?.content, engine.documents[0].content, "the program actually materialized its resource");
        const source = await db.test_log_sequencees_by_turn.all<{ op: string; status_rx: number }>({ turn_id: turns[0].id });
        assert.ok(source.some(({ op, status_rx }) => op === "EDIT" && status_rx === 201), "the source operation receipt remains durable");
        assert.equal(await db.engine_session_has_undelivered_child_term.get({ session_id: parentId }), undefined,
            "housekeeping is not an unobserved child result that can wake waiting work or refuse completion");

        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt("Child documentation observed.")] } }] }),
            workspaceId, sessionId: parentId, loopId: parentLoopId,
            messages: [{ role: "system", content: "Observe the child." }, { role: "user", content: "continue" }],
        });
        assert.equal(result.status, 200);
        const rows = await db.engine_render_log.all<{ source: string | null }>({ session_id: parentId });
        assert.deepEqual(rows.filter((row) => row.source === "session://child"), [],
            "the parent's real packet path contains no invented child deliverable");
    } finally { await db.close(); }
});

test("{§tools-resource-materialization} session documentation materialization removes stale generated entries", async () => {
    const db = await openMigrated();
    try {
        const engine = new FixtureEngine({
            db,
            schemes: new SchemeRegistry(),
            mimetypes: DEFAULT_MIMETYPES,
        });
        const workspaceId = await insertWorkspace(db, `loop-docs-${crypto.randomUUID()}`);
        await insertSession(db, workspaceId);
        const entry = (pathname: string) => db.crud_find_workspace_entry.get<{ id: number }>({
            workspace_id: workspaceId,
            scheme: "workspace",
            authority: "",
            pathname,
        });

        engine.documents = [
            { pathname: "/_plurnk/plurnk/retired.md", content: "# Retired" },
            { pathname: "/_plurnk/plurnk/tool-retired.md", content: "# Retired tool" },
        ];
        await LoopDocs.materialize(engine, db, workspaceId);
        assert.notEqual(await entry("/_plurnk/plurnk/retired.md"), undefined);
        assert.notEqual(await entry("/_plurnk/plurnk/tool-retired.md"), undefined);

        engine.documents = [
            { pathname: "/_plurnk/plurnk/current.md", content: "# Current" },
            { pathname: "/_plurnk/plurnk/tool-current.md", content: "# Current tool" },
        ];
        await LoopDocs.materialize(engine, db, workspaceId);
        assert.equal(await entry("/_plurnk/plurnk/retired.md"), undefined);
        assert.equal(await entry("/_plurnk/plurnk/tool-retired.md"), undefined);
        assert.notEqual(await entry("/_plurnk/plurnk/current.md"), undefined);
        assert.notEqual(await entry("/_plurnk/plurnk/tool-current.md"), undefined);
    } finally {
        await db.close();
    }
});

for (const runtime of ["sh", "js", "python3"]) test(`{§op-shapes}: installed ${runtime} examples and fenced README programs preserve executor/target ownership`, async (t) => {
    const executors = await testExecutors();
    if (!executors.availableRuntimes().includes(runtime)) return t.skip(`${runtime} is not installed`);
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        engine.setExecutors(executors);
        const workspaceId = await insertWorkspace(db, `${runtime}-doc-invocations`);
        await insertSession(db, workspaceId);
        await LoopDocs.materialize(engine, db, workspaceId);
        const doc = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: `/_plurnk/plurnk/${runtime}.md`, scheme: "workspace", name: "body",
        });
        assert.ok(doc, "the installed executor's documentation reaches the session");
        const readme = await readFile(new URL("README.md", import.meta.resolve("@plurnk/plurnk-execs-common/package.json")), "utf8");
        const examples = [doc.content, readme].flatMap((content) => Lexer.lex(content)
            .filter((token) => token.type === "code" && token.lang?.split(/[ \t]/)[0] === runtime));
        assert.ok(examples.length > 0, `${runtime} has executable examples`);
        const execs = examples.flatMap(({ raw }) => {
            const parsed = PlurnkParser.parseStatements(raw, { executors: fixtureExecutors(raw) });
            assert.equal(parsed.unparsedTail, undefined, raw);
            assert.equal(parsed.items.length, 1, raw);
            assert.equal(parsed.items[0]?.kind, "statement", raw);
            return parsed.items.flatMap((item) => item.kind === "statement" && isExecution(item.statement) ? [item.statement] : []);
        });
        assert.ok(execs.length > 0);
        assert.ok(execs.every((statement) => statement.runtime === runtime), `${runtime} is the runtime, never the input target`);
        assert.ok(execs.some(({ target }) => target === null), `${runtime} demonstrates the no-target form`);
        if (runtime !== "js") assert.ok(execs.some(({ target }) => target?.kind === "local"), `${runtime} demonstrates a local script target`);
    } finally { await db.close(); }
});

test("{§tools-resource-materialization} an unchanged generated surface dispatches nothing on re-materialization", async () => {
    const db = await openMigrated();
    try {
        const engine = new FixtureEngine({
            db,
            schemes: new SchemeRegistry(),
            mimetypes: DEFAULT_MIMETYPES,
        });
        const workspaceId = await insertWorkspace(db, `loop-docs-idem-${crypto.randomUUID()}`);
        await insertSession(db, workspaceId);
        engine.documents = [
            { pathname: "/_plurnk/plurnk/stable.md", content: "# Stable" },
        ];
        await LoopDocs.materialize(engine, db, workspaceId);
        const runtime = await db.session_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "_plurnk" });
        assert.ok(runtime !== undefined, "maintenance has its actual runtime actor");
        const before = await db.test_get_loop_by_session.get<{ id: number }>({ session_id: runtime.id });
        assert.ok(before !== undefined, "initial materialization recorded a maintenance loop");

        await LoopDocs.materialize(engine, db, workspaceId);
        const after = await db.test_get_loop_by_session.get<{ id: number }>({ session_id: runtime.id });
        assert.equal(after?.id, before?.id, "the unchanged surface re-dispatches nothing — no new _plurnk turn, no 304 churn");
    } finally {
        await db.close();
    }
});

test("{§exec-stream}: materialized shell documentation demonstrates scoped READ of an execution stream", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, "shell-doc-stream-read");
        await insertSession(db, workspaceId);
        await LoopDocs.materialize(engine, db, workspaceId);
        const doc = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: "/_plurnk/plurnk/sh.md", scheme: "workspace", name: "body",
        });
        assert.ok(doc, "the installed shell's documentation reaches the session");
        const examples = Lexer.lex(doc.content).flatMap((token) =>
            token.type === "code" && token.lang?.startsWith("READ ") ? [token.raw] : []);
        const reads = examples.flatMap((source) => {
            const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
            assert.equal(parsed.unparsedTail, undefined, source);
            assert.equal(parsed.items.length, 1, source);
            assert.equal(parsed.items[0]?.kind, "statement", source);
            return parsed.items.flatMap((item) => item.kind === "statement" && item.statement.op === "READ" ? [item.statement] : []);
        });
        assert.ok(reads.length > 0, "the doc demonstrates fetching beyond the terminal observation");
        for (const read of reads) {
            assert.equal(read.target?.kind, "url");
            if (read.target?.kind !== "url") throw new Error("The stream example must address a resource");
            assert.equal(read.target.scheme, "sh");
            assert.match(read.target.pathname, /^\/[a-f0-9]{8}$/);
            assert.equal(read.target.fragment, "stdout");
            assert.equal(read.lineMarker?.marks.length, 2, "the example selects a line interval");
        }
    } finally { await db.close(); }
});
});

describe("resource-state-soak", () => {
const execFileP = promisify(execFile);

test("{§test-artifact-retention} soak: N turn boundaries with per-turn membership re-resolution — zero growth, zero violations, every boundary", { timeout: 120_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-soak-"));
    const db = await openMigrated();
    try {
        // A real git workspace: three tracked members.
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env: hermeticGitEnv() });
        for (const f of ["a.md", "b.md", "sub-c.md"]) await writeFile(join(root, f), `# ${f}\n`);
        await execFileP("git", ["add", "-A"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env: hermeticGitEnv() });

        const workspaceId = await insertWorkspace(db, `soak-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const sessionId = await insertSession(db, workspaceId);
        const ctx: PlurnkSchemeContext = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const TURNS = 6;
        const responses = Array.from({ length: TURNS }, (_, i) => ({
            assistant: {
                content: `${i % 2 === 0 ? "````READ (a.md)````" : "````FIND (**)````"}
\`\`\`\`NOTE
continue
\`\`\`\``,
                reasoning: null,
            },
        }));
        const provider = new Mock({ contextWindow: viableWindow(), responses });

        const loopId = await insertLoop(db, sessionId, 1, "soak");
        let baseline: number | null = null;
        for (let turn = 1; turn <= TURNS; turn++) {
            // the per-turn membership pass
            await GitMembership.indexGitMembership(ctx);
            const r = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
            assert.ok(r.status < 500, `turn ${turn} completed (${r.status})`);
            const count = await ResourceState.entryCount(db);
            if (baseline === null) baseline = count;
            else assert.equal(count, baseline, `turn ${turn}: read-only turns grow the entries table by ZERO`);
            const violations = await ResourceState.check(db);
            assert.deepEqual(violations, [], `turn ${turn}: resource invariants hold at every boundary`);
        }
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
});
