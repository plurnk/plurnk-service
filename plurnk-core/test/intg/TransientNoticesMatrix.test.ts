import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Engine from "../../src/core/Engine.ts";
import Daemon from "../../src/server/Daemon.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import NoticeChannel from "../../src/core/NoticeChannel.ts";
import Results from "../../src/core/results.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import { Mock, ProviderError, type MockResponse } from "@plurnk/plurnk-providers";
import { serverProposals } from "./_approval.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn, seedEntryWithChannel } from "./_db.ts";
import { packetSection, logEntries } from "./_packet.ts";
import { mcpMockTurn } from "./_mock.ts";
import { connect, rpcCall, runLoopToTerminal } from "./_rpc.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";

describe("transient-notices-matrix", () => {
const rawTurn = (content: string, finishReason: "stop" | "length" = "stop"): MockResponse =>
    mcpMockTurn(content, { finishReason });

const getPacket = async (db: Awaited<ReturnType<typeof openMigrated>>, turnId: number) => {
    const row = await db.test_get_packet.get<{ packet: string }>({ id: turnId });
    assert.ok(row?.packet, `expected stored packet for turn ${turnId}`);
    return JSON.parse(row.packet) as Record<string, unknown>;
};

test("{§log-history-projection} {§tokenomics}: 100 missed log:/// kill 404s add zero weight to Log and emission-history, surface on T+1 Notices, and vanish on T+2", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `matrix-100-kills-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Curate and continue.");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });

        const kills = Array.from({ length: 100 }, (_, i) =>
            `await plurnk.kill({"path":"log:///9/9/${i + 1}"});`).join("\n\n");
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [
                rawTurn(`${kills}\n\nawait plurnk.note({"text":"batch tried"});`),
                rawTurn("await plurnk.note({\"text\":\"observed misses\"});"),
                rawTurn("await plurnk.done({\"text\":\"clean\"});"),
            ],
        });

        const t1 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.equal(t1.status, 102);
        const t1Rows = await db.test_log_entries_by_turn.all<{ op: string; status_rx: number }>({ turn_id: t1.turnId });
        assert.equal(t1Rows.filter((r) => r.op === "kill" && r.status_rx === 404).length, 100, "all 100 missed kills remain durable in log_entries");

        const t2 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.equal(t2.status, 102);
        const p2 = await getPacket(db, t2.turnId);
        assert.equal(logEntries(p2).filter((e) => e.logPath.endsWith("/kill")).length, 0, "zero missed kill receipts enter ## Log");
        assert.doesNotMatch(packetSection(p2, "emission-history"), /log:\/\/\/9\/9\//u, "zero missed kills enter emission-history");
        const notices2 = packetSection(p2, "notices");
        assert.equal([...notices2.matchAll(/404 kill \(log:\/\/\/9\/9\/\d+\):/gu)].length, 100, "all 100 misses surface on T+1 ## Notices");

        const t3 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.equal(t3.status, 200);
        const p3 = await getPacket(db, t3.turnId);
        assert.equal(
            packetSection(p3, "notices"),
            "> [!NOTE]\n> Only note performed. If done, resolve Open Message(s) with done tool. [open_messages_unresolved]",
            "all 100 miss notices vanish on T+2 after T+1 emission completes",
        );
    } finally {
        await db.close();
    }
});

test("{§log-history-projection} {§emission-history} {§tokenomics}: 100 successful 200 log:/// kills add zero permanent weight, emit one-turn log_curated notices, and keep largest free of omitted emission stubs", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `matrix-100-curation-200-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Read, curate, and verify zero residue.");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });

        const notes = Array.from({ length: 100 }, (_, i) =>
            `await plurnk.note({"text":"temp-fact-${i + 1}"});`).join("\n\n");
        const kills = Array.from({ length: 100 }, (_, i) =>
            `await plurnk.kill({"path":"log:///1/2/${i + 3}/note"});`).join("\n\n");

        const provider = new Mock({
            contextWindow: 50_000,
            responses: [
                rawTurn(notes),
                rawTurn(kills),
                rawTurn("await plurnk.kill({\"path\":\"log:///1/[1-2]/*\"});"),
                rawTurn("await plurnk.done({\"text\":\"zero residue\"});"),
            ],
        });

        const t1 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.equal(t1.status, 102);

        const t2 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.equal(t2.status, 102);
        const t2Rows = await db.test_log_entries_by_turn.all<{ op: string; status_rx: number }>({ turn_id: t2.turnId });
        assert.equal(t2Rows.filter((r) => r.op === "kill" && r.status_rx === 200).length, 100, "all 100 curation kills succeeded with 200");

        const t3 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.equal(t3.status, 102);
        const p3 = await getPacket(db, t3.turnId);
        assert.doesNotMatch(packetSection(p3, "emission-history"), /temp-fact-|call_1_3_/u, "all 100 notes were retired and none of the 100 200 log:/// kills replay");
        const notices3 = packetSection(p3, "notices");
        assert.equal([...notices3.matchAll(/200 kill \(log:\/\/\/1\/2\/\d+\/note\): Retired 1 log entry\. \[log_curated\]/gu)].length, 100, "all 100 curations surface once in T+1 Notices");

        const t4 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.equal(t4.status, 200);
        const p4 = await getPacket(db, t4.turnId);
        assert.equal(packetSection(p4, "emission-history"), "", "subsequent curation kill also leaves zero replay");
        assert.equal(packetSection(p4, "log"), "", "all curatable log entries are retired and omitted emission stubs do not render");
        const gauge4 = JSON.parse(packetSection(p4, "budget")) as { tokens: number; percent?: number; largest?: Array<{ path: string }> };
        assert.equal(gauge4.tokens, 0, "curatable log weight returns strictly to 0 after 101 sequential kills");
        assert.equal(gauge4.largest, undefined, "omitted emission stubs never appear in largest");
        assert.match(packetSection(p4, "notices"), /^> \[!NOTE\]\n> 200 kill \(log:\/\/\/1\/\[1-2\]\/\*\): Retired \d+ log entries \(message:\/\/alice\/00\)\. \[log_curated\]$/u, "prior 100 log_curated notices vanished on T+2 and retired inbound send names message://alice/00");
    } finally {
        await db.close();
    }
});

test("{§log-history-projection} {§operation-results}: 204 and 304 matrix separates stateful queries (find/read 204) from transient mutation no-ops across packetless turns", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `matrix-204-304-${crypto.randomUUID()}`);
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/empty.txt", content: "", mimetype: "text/plain" });
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/doc.txt", content: "alpha\nbeta", mimetype: "text/plain" });
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Check 204 and 304 outcomes.");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });

        const turn1Program = [
            "await plurnk.find({\"path\":\"workspace:///doc.txt\",\"pattern\":\"/nomatch/\"});",
            "await plurnk.read({\"path\":\"workspace:///empty.txt\"});",
            "await plurnk.kill({\"path\":\"log:///9/9/*\"});",
            "await plurnk.kill({\"path\":\"workspace:///nonexistent-*.txt\"});",
            "await plurnk.edit({\"path\":\"workspace:///doc.txt\",\"pattern\":\"/nomatch/\",\"content\":\"gamma\"});",
            "await plurnk.copy({\"from\":{\"path\":\"workspace:///doc.txt\",\"pattern\":\"/nomatch/\"},\"to\":\"workspace:///out.txt\"});",
            "await plurnk.edit({\"path\":\"workspace:///doc.txt\",\"range\":\"1,-1\",\"content\":\"alpha\\nbeta\"});",
            "await plurnk.copy({\"from\":\"workspace:///doc.txt\",\"to\":\"workspace:///doc-copy.txt\"});",
            "await plurnk.copy({\"from\":\"workspace:///doc.txt\",\"to\":\"workspace:///doc-copy.txt\"});",
            "await plurnk.note({\"text\":\"matrix dispatched\"});",
        ].join("\n\n");

        const provider = new Mock({
            contextWindow: 100_000,
            responses: [
                rawTurn(turn1Program),
                rawTurn("await plurnk.note({\"text\":\"checked\"});"),
                rawTurn("await plurnk.done({\"text\":\"done\"});"),
            ],
        });

        const t1 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.equal(t1.status, 102);

        // Insert an intervening packetless _plurnk turn between T1 and T2: notices from T1 must NOT drop!
        const maintTurnId = await insertTurn(db, loopId, 3);
        await db.engine_insert_log_entry.get({
            session_id: sessionId, loop_id: loopId, turn_id: maintTurnId, sequence: 1,
            origin: "_plurnk", source: null, model_call_id: null, op: "note",
            scheme: null, username: null, password: null, hostname: null, port: null,
            pathname: null, query: null, fragment: null, lineMarker: null,
            tx: JSON.stringify({ body: "interveningturn" }), mimetype_tx: "application/json",
            rx: JSON.stringify({ status: 200 }), mimetype_rx: "application/json",
            status_rx: 200, weight: 1, state: "resolved", outcome: null, attrs: "{}",
        });

        const t2 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const p2 = await getPacket(db, t2.turnId);
        const active = logEntries(p2);

        assert.ok(active.some((e) => e.logPath.endsWith("/find") && e.status === 204), "find 204 stays active in tool-result");
        assert.ok(active.some((e) => e.logPath.endsWith("/read") && e.status === 204), "read 204 stays active in tool-result");
        assert.equal(
            active.some((e) => (e.status === 204 || e.status === 304) && !e.logPath.endsWith("/find") && !e.logPath.endsWith("/read")),
            false,
            "zero mutation 204/304 no-ops enter ## Log or tool-result replay",
        );

        const notices2 = packetSection(p2, "notices");
        assert.match(notices2, /204 kill \(log:\/\/\/9\/9\/\*\): .*\[no_match\]/u);
        assert.match(notices2, /204 kill \(workspace:\/\/\/nonexistent-\*\.txt\): .*\[no_match\]/u);
        assert.match(notices2, /204 edit \(workspace:\/\/\/doc\.txt\) \/nomatch\/: .*\[no_match\]/u);
        assert.match(notices2, /204 copy \(workspace:\/\/\/doc\.txt\) \/nomatch\/ \(workspace:\/\/\/out\.txt\): .*\[no_match\]/u);
        assert.match(notices2, /304 edit \(workspace:\/\/\/doc\.txt\): .*\[not_modified\]/u);
        assert.match(notices2, /304 copy \(workspace:\/\/\/doc\.txt\) \(workspace:\/\/\/doc-copy\.txt\): .*\[not_modified\]/u);

        const t3 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const p3 = await getPacket(db, t3.turnId);
        assert.equal(
            packetSection(p3, "notices"),
            "> [!NOTE]\n> Only note performed. If done, resolve Open Message(s) with done tool. [open_messages_unresolved]",
            "204/304 notices clear after one consumed packet while note-only turn reminds of Open Message",
        );
        assert.ok(logEntries(p3).some((e) => e.logPath.endsWith("/find") && e.status === 204), "find 204 remains active until curated");
        assert.ok(logEntries(p3).some((e) => e.logPath.endsWith("/read") && e.status === 204), "read 204 remains active until curated");
    } finally {
        await db.close();
    }
});

test("{§log-history-projection} {§operation-results}: >=400 matrix separates stateful partial/concluded payloads (active=1 + LogCoordinate pointer) from stateless refusals (active=0 + inline notice)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `matrix-400-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Verify >=400 classification.");
        const seededTurn = await insertTurn(db, loopId, 1);

        // Seed representative stateful >=400 rows vs stateless >=400 rows on Turn 1.
        // 1) Stateful 413 read with problem.delivered > 0 -> active=1 + @ log:///1/1/1/read pointer
        await db.engine_insert_log_entry.get({
            session_id: sessionId, loop_id: loopId, turn_id: seededTurn, sequence: 1,
            origin: "model", source: null, model_call_id: null, op: "read",
            scheme: "workspace", username: null, password: null, hostname: null, port: null,
            pathname: "/huge.txt", query: null, fragment: null, lineMarker: null,
            tx: JSON.stringify({ path: "workspace:///huge.txt" }), mimetype_tx: "application/json",
            rx: JSON.stringify({
                status: 413,
                content: "1:line one\n2:line two",
                problem: {
                    type: "https://problems.plurnk.xyz/engine/context/result-exceeds-budget",
                    title: "Result exceeds budget",
                    status: 413,
                    detail: "Delivered prefix of 2 lines.",
                    delivered: 2,
                },
            }),
            mimetype_rx: "application/json", status_rx: 413, weight: 5, state: "resolved", outcome: null, attrs: "{}",
        });
        // 2) Stateless 413 read with delivered = 0 and no content -> active=0 + inline notice
        await db.engine_insert_log_entry.get({
            session_id: sessionId, loop_id: loopId, turn_id: seededTurn, sequence: 2,
            origin: "model", source: null, model_call_id: null, op: "read",
            scheme: "workspace", username: null, password: null, hostname: null, port: null,
            pathname: "/unfit.bin", query: null, fragment: null, lineMarker: null,
            tx: JSON.stringify({ path: "workspace:///unfit.bin" }), mimetype_tx: "application/json",
            rx: JSON.stringify({
                status: 413,
                problem: {
                    type: "https://problems.plurnk.xyz/engine/context/result-exceeds-budget",
                    title: "Result exceeds budget",
                    status: 413,
                    detail: "Zero items fit.",
                    delivered: 0,
                },
            }),
            mimetype_rx: "application/json", status_rx: 413, weight: 0, state: "resolved", outcome: null, attrs: "{}",
        });
        // 3) Stateful 409 multi-span edit with effects.length > 0 -> active=1 + @ log:///1/1/3/edit pointer
        await db.engine_insert_log_entry.get({
            session_id: sessionId, loop_id: loopId, turn_id: seededTurn, sequence: 3,
            origin: "model", source: null, model_call_id: null, op: "edit",
            scheme: "workspace", username: null, password: null, hostname: null, port: null,
            pathname: "/partial.txt", query: null, fragment: null, lineMarker: null,
            tx: JSON.stringify({ path: "workspace:///partial.txt" }), mimetype_tx: "application/json",
            rx: JSON.stringify({
                status: 409,
                effects: [{ path: "workspace:///partial.txt", action: "update", extent: "lines 2->2", change: "lines -1 +1", effect: "<1,1> -> <1,1>" }],
                problem: {
                    type: "https://problems.plurnk.xyz/scheme/file/edit-conflict",
                    title: "Edit conflict",
                    status: 409,
                    detail: "Second span conflicted after first span landed.",
                },
            }),
            mimetype_rx: "application/json", status_rx: 409, weight: 4, state: "resolved", outcome: null, attrs: "{}",
        });
        // 4) Stateless 409 zero-effect edit -> active=0 + inline notice
        await db.engine_insert_log_entry.get({
            session_id: sessionId, loop_id: loopId, turn_id: seededTurn, sequence: 4,
            origin: "model", source: null, model_call_id: null, op: "edit",
            scheme: "workspace", username: null, password: null, hostname: null, port: null,
            pathname: "/conflict.txt", query: null, fragment: null, lineMarker: null,
            tx: JSON.stringify({ path: "workspace:///conflict.txt" }), mimetype_tx: "application/json",
            rx: JSON.stringify({
                status: 409,
                effects: [],
                problem: {
                    type: "https://problems.plurnk.xyz/scheme/file/edit-conflict",
                    title: "Edit conflict",
                    status: 409,
                    detail: "Anchor mismatch; nothing written.",
                },
            }),
            mimetype_rx: "application/json", status_rx: 409, weight: 0, state: "resolved", outcome: null, attrs: "{}",
        });
        // 5) Stateful 500 child loop_termination via real LoopLifecycle.finish -> active=1 + @ log:///... pointer
        const worker = await insertSession(db, workspaceId, sessionId, "worker");
        const workerLoop = await insertLoop(db, worker, 1, "Child task.");
        await new LoopLifecycle(db).finish(
            workerLoop,
            Results.failure("engine:rail", "strike-limit-exceeded", 500, "Worker struck out."),
        );

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [
                rawTurn("await plurnk.note({\"text\":\"inspecting\"});"),
                rawTurn("await plurnk.done({\"text\":\"done\"});"),
            ],
        });

        const t2 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [], turnNumber: 2 });
        const p2 = await getPacket(db, t2.turnId);
        const activePaths = logEntries(p2).map((e) => e.logPath);
        assert.ok(activePaths.includes("log:///1/1/1/read"), "stateful 413 prefix stays in ## Log");
        assert.ok(!activePaths.includes("log:///1/1/2/read"), "bodiless 413 stays out of ## Log");
        assert.ok(activePaths.includes("log:///1/1/3/edit"), "partial 409 edit stays in ## Log");
        assert.ok(!activePaths.includes("log:///1/1/4/edit"), "zero-effect 409 edit stays out of ## Log");
        const termEntry = logEntries(p2).find((e) => e.status === 500 && e.source === "session://worker");
        assert.ok(termEntry, "500 loop_termination stays in ## Log");

        const notices2 = packetSection(p2, "notices");
        assert.match(notices2, /413 Delivered prefix of 2 lines\. @ log:\/\/\/1\/1\/1\/read \[result-exceeds-budget\]/u);
        assert.match(notices2, /413 read \(workspace:\/\/\/unfit\.bin\): Zero items fit\. \[result-exceeds-budget\]/u);
        assert.match(notices2, /409 Second span conflicted after first span landed\. @ log:\/\/\/1\/1\/3\/edit \[edit-conflict\]/u);
        assert.match(notices2, /409 edit \(workspace:\/\/\/conflict\.txt\): Anchor mismatch; nothing written\. \[edit-conflict\]/u);
        assert.match(notices2, new RegExp(`500 Worker struck out\\. @ ${termEntry.logPath} \\[strike-limit-exceeded\\]`, "u"));

        const t3 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [], turnNumber: 3 });
        const p3 = await getPacket(db, t3.turnId);
        assert.equal(
            packetSection(p3, "notices"),
            "> [!NOTE]\n> Only note performed. If done, resolve Open Message(s) with done tool. [open_messages_unresolved]",
            "all pointers and inline notices expire after one turn",
        );
    } finally {
        await db.close();
    }
});

test("{§operation-results} {§log-history-projection}: loop_notices and notice_log_cursor survive engine restart across parked 202 proposals and clear only after emission succeeds", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-notice-restart-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "plurnk.db");

    let workspaceId = 0;
    let sessionId = 0;
    let loopId = 0;
    let proposalId = 0;

    // Phase 1: before restart — seed a 404 read, a pending 202 proposal, and a durable loop_notices item.
    {
        const db1 = await openMigrated(dbPath);
        try {
            workspaceId = await insertWorkspace(db1, "restart-durability");
            sessionId = await insertSession(db1, workspaceId, null, "alice");
            loopId = await insertLoop(db1, sessionId, 1, "Resume cleanly after restart.");
            const turn1 = await insertTurn(db1, loopId, 1);

            await db1.engine_insert_log_entry.get({
                session_id: sessionId, loop_id: loopId, turn_id: turn1, sequence: 1,
                origin: "model", source: null, model_call_id: null, op: "read",
                scheme: "workspace", username: null, password: null, hostname: null, port: null,
                pathname: "/missing-before-park.txt", query: null, fragment: null, lineMarker: null,
                tx: JSON.stringify({ path: "workspace:///missing-before-park.txt" }), mimetype_tx: "application/json",
                rx: JSON.stringify(Results.failure("scheme:file", "not-found", 404, "Missing before park.")),
                mimetype_rx: "application/json", status_rx: 404, weight: 0, state: "resolved", outcome: null, attrs: "{}",
            });

            const propRow = await db1.engine_insert_log_entry.get<{ id: number }>({
                session_id: sessionId, loop_id: loopId, turn_id: turn1, sequence: 2,
                origin: "model", source: null, model_call_id: null, op: "edit",
                scheme: "workspace", username: null, password: null, hostname: null, port: null,
                pathname: "/gated.txt", query: null, fragment: null, lineMarker: null,
                tx: JSON.stringify({ path: "workspace:///gated.txt" }), mimetype_tx: "application/json",
                rx: JSON.stringify({ status: 202 }), mimetype_rx: "application/json",
                status_rx: 202, weight: 0, state: "proposed", outcome: null, attrs: "{}",
            });
            proposalId = propRow!.id;

            const ch1 = new NoticeChannel({ db: db1 });
            ch1.push(workspaceId, sessionId, loopId, {
                source: "engine:test",
                kind: "restart_survived",
                level: "warn",
                message: "Buffered across daemon restart.",
            });
            await ch1.flush();
        } finally {
            await db1.close();
        }
    }

    // Phase 2: new SQLite handle + new Engine (empty in-memory NoticeChannel), reject the proposal,
    // fail the first provider call (verifying notices are NOT consumed early), then succeed and drain.
    const db2 = await openMigrated(dbPath);
    try {
        await db2.engine_resolve_log_entry.run({
            id: proposalId,
            state: "failed",
            outcome: "rejected",
            status_rx: 400,
            rx: JSON.stringify(Results.failure("proposal", "rejected", 400, "The proposal was rejected.")),
            weight: 0,
        });

        const engine2 = new Engine({ db: db2, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });

        // Failed provider call must NOT consume loop_notices or advance notice_log_cursor.
        const failingProvider = new Mock({ contextWindow: 100_000, responses: [] });
        failingProvider.generate = () => Promise.reject(new ProviderError(
            "mock",
            "unauthorized",
            "bad token",
            { status: 401 },
        ));
        await assert.rejects(
            () => engine2.runTurn({
                provider: failingProvider,
                workspaceId,
                sessionId,
                loopId,
                messages: [],
                turnNumber: 2,
            }),
            /bad token/u,
        );

        const workingProvider = new Mock({
            contextWindow: 100_000,
            responses: [
                rawTurn("await plurnk.note({\"text\":\"resumed\"});"),
                rawTurn("await plurnk.done({\"text\":\"finished\"});"),
            ],
        });
        const resumed = await engine2.runTurn({
            provider: workingProvider,
            workspaceId,
            sessionId,
            loopId,
            messages: [],
            turnNumber: 3,
        });
        assert.equal(resumed.status, 102);
        const pResumed = await getPacket(db2, resumed.turnId);
        const noticesResumed = packetSection(pResumed, "notices");
        assert.match(noticesResumed, /404 read \(workspace:\/\/\/missing-before-park\.txt\): Missing before park\./u, "pre-park log notice survives restart");
        assert.match(noticesResumed, /400 edit \(workspace:\/\/\/gated\.txt\): The proposal was rejected\./u, "rejected 202 proposal notice surfaces after settlement");
        assert.match(noticesResumed, /Buffered across daemon restart\. \[restart_survived\]/u, "durable loop_notices item survives restart and failed provider call");
        assert.equal(logEntries(pResumed).some((e) => e.logPath.endsWith("/gated.txt") || e.status === 400), false, "settled 400 proposal has active=0");

        const final = await engine2.runTurn({
            provider: workingProvider,
            workspaceId,
            sessionId,
            loopId,
            messages: [],
            turnNumber: 4,
        });
        assert.equal(final.status, 200);
        const pFinal = await getPacket(db2, final.turnId);
        assert.equal(
            packetSection(pFinal, "notices"),
            "> [!NOTE]\n> Only note performed. If done, resolve Open Message(s) with done tool. [open_messages_unresolved]",
            "both loop_notices and notice_log_cursor clear after resumed turn completes",
        );
    } finally {
        await db2.close();
    }
});

test("{§env-delta} {§operation-results}: child session stateless failures stay out of parent ambient_events and Log while child mutations and terminal loop_termination surface", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `child-isolation-${crypto.randomUUID()}`);
        const parent = await insertSession(db, workspaceId, null, "parent");
        const parentLoop = await insertLoop(db, parent, 1, "Supervise worker.");
        const worker = await insertSession(db, workspaceId, parent, "worker");
        const workerLoop = await insertLoop(db, worker, 1, "Do child work.");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });

        const parentProvider = new Mock({
            contextWindow: 100_000,
            responses: [
                rawTurn("await plurnk.note({\"text\":\"baseline\"});"),
                rawTurn("await plurnk.done({\"text\":\"supervised\"});"),
            ],
        });
        await engine.runTurn({ provider: parentProvider, workspaceId, sessionId: parent, loopId: parentLoop, messages: [], turnNumber: 1 });

        const workerTurn = await insertTurn(db, workerLoop, 1);
        // Child stateless failures: 409 edit, 404 kill, 422 send, 304 edit
        await db.engine_insert_log_entry.get({
            session_id: worker, loop_id: workerLoop, turn_id: workerTurn, sequence: 1,
            origin: "model", source: null, model_call_id: null, op: "edit",
            scheme: "workspace", username: null, password: null, hostname: null, port: null,
            pathname: "/child-conflict.txt", query: null, fragment: null, lineMarker: null,
            tx: "{}", mimetype_tx: "application/json",
            rx: JSON.stringify(Results.failure("scheme:file", "edit-conflict", 409, "Child anchor conflict.")),
            mimetype_rx: "application/json", status_rx: 409, weight: 0, state: "resolved", outcome: null, attrs: "{}",
        });
        await db.engine_insert_log_entry.get({
            session_id: worker, loop_id: workerLoop, turn_id: workerTurn, sequence: 2,
            origin: "model", source: null, model_call_id: null, op: "kill",
            scheme: "workspace", username: null, password: null, hostname: null, port: null,
            pathname: "/child-missing.txt", query: null, fragment: null, lineMarker: null,
            tx: "{}", mimetype_tx: "application/json",
            rx: JSON.stringify(Results.failure("scheme:file", "not-found", 404, "Child target missing.")),
            mimetype_rx: "application/json", status_rx: 404, weight: 0, state: "resolved", outcome: null, attrs: "{}",
        });
        await db.engine_insert_log_entry.get({
            session_id: worker, loop_id: workerLoop, turn_id: workerTurn, sequence: 3,
            origin: "model", source: null, model_call_id: null, op: "send",
            scheme: "session", username: null, password: null, hostname: "nobody", port: null,
            pathname: "", query: null, fragment: null, lineMarker: null,
            tx: "{}", mimetype_tx: "application/json",
            rx: JSON.stringify(Results.failure("scheme:session", "unknown-recipient", 422, "Unknown recipient.")),
            mimetype_rx: "application/json", status_rx: 422, weight: 0, state: "resolved", outcome: null, attrs: "{}",
        });
        await db.engine_insert_log_entry.get({
            session_id: worker, loop_id: workerLoop, turn_id: workerTurn, sequence: 4,
            origin: "model", source: null, model_call_id: null, op: "edit",
            scheme: "workspace", username: null, password: null, hostname: null, port: null,
            pathname: "/child-noop.txt", query: null, fragment: null, lineMarker: null,
            tx: "{}", mimetype_tx: "application/json",
            rx: JSON.stringify({ status: 304 }),
            mimetype_rx: "application/json", status_rx: 304, weight: 0, state: "resolved", outcome: null, attrs: "{}",
        });
        // Child landed 200 mutation -> MUST surface in parent Log
        await db.engine_insert_log_entry.get({
            session_id: worker, loop_id: workerLoop, turn_id: workerTurn, sequence: 5,
            origin: "model", source: null, model_call_id: null, op: "edit",
            scheme: "workspace", username: null, password: null, hostname: null, port: null,
            pathname: "/child-landed.txt", query: null, fragment: null, lineMarker: null,
            tx: "{}", mimetype_tx: "application/json",
            rx: JSON.stringify({ status: 201, span: "1:landed" }),
            mimetype_rx: "application/json", status_rx: 201, weight: contentWeight("1:landed"), state: "resolved", outcome: null, attrs: "{}",
        });

        const parentT2 = await engine.runTurn({ provider: parentProvider, workspaceId, sessionId: parent, loopId: parentLoop, messages: [], turnNumber: 2 });
        const p2 = await getPacket(db, parentT2.turnId);
        const workerEntries = logEntries(p2).filter((e) => e.source === "session://worker");
        assert.deepEqual(
            workerEntries.map((e) => e.path),
            ["workspace:///child-landed.txt"],
            "only the child's resolved 201 mutation enters parent ambient_events and ## Log; child 409/404/422/304 stay private to child",
        );
    } finally {
        await db.close();
    }
});

test("{§operation-results}: an empty length-truncated turn emits a single output_truncated notice without duplicate length warnings", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `trunc-dedup-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Check length truncation deduplication.");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });

        const provider = new Mock({
            contextWindow: 100_000,
            responses: [
                { assistant: { content: "", reasoning: "Exhausted whole output budget in reasoning.", finishReason: "length" }, assistantRaw: null },
                rawTurn("await plurnk.done({\"text\":\"done\"});"),
            ],
        });

        const t1 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.equal(t1.status, 102);

        const t2 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.equal(t2.status, 200);
        const p2 = await getPacket(db, t2.turnId);
        const notices = packetSection(p2, "notices");
        assert.equal(
            [...notices.matchAll(/\[output_truncated\]/gu)].length,
            1,
            `expected exactly one [output_truncated] notice, got:\n${notices}`,
        );
        assert.match(notices, /no authored operations were performed/u);
    } finally {
        await db.close();
    }
});

test("{§log-history-projection} {§exec-stream} {§operation-results}: stateless plurnk:/// Functionality refusals and pre-call MCP refusals stay out of ## Log and include schema error details in 1-turn ## Notices", async (t) => {
    serverProposals(t, "accept");
    const db = await openMigrated();
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            rawTurn('plurnk.env({"name":"FOO_VERSION"})\n\nplurnk.wait({})'),
            rawTurn('plurnk.env({})\n\nplurnk.wait({})'),
            rawTurn('plurnk.done({"text":"inspected env"})'),
        ],
    });
    const daemon = new Daemon({ db, provider });
    try {
        await daemon.start();
        const ws = await connect({ daemon });
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `func-refusal-${crypto.randomUUID()}` });
            const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "Check FOO_VERSION." });
            assert.equal(finalStatus, 200);
            assert.ok(turnIds && turnIds.length === 4, `expected init turn + 3 model turns, got ${JSON.stringify(turnIds)}`);

            const p2 = await getPacket(db, turnIds[2]);
            const p2Log = logEntries(p2);
            assert.equal(
                p2Log.filter((e) => typeof e.status === "number" && e.status >= 400).length,
                0,
                "plurnk:/// 400 arguments-invalid refusal never enters ## Log or tool-error replay",
            );
            const notices2 = packetSection(p2, "notices");
            assert.doesNotMatch(notices2, /400 plurnk \(env\):/u, "stream-linked invocation row does not duplicate the stream refusal notice");
            assert.match(notices2, /400 read \(exec:\/\/\/plurnk\/[0-9a-f]{8}\): env add arguments do not match their schema\./u);
            assert.match(notices2, /Instance does not have required property "value"\./u);
            assert.match(notices2, /mcp\(\{ server: "plurnk", tool: "env", arguments: \{"name":"CARGO_TARGET_DIR","value":"\/tmp\/shared"\} \}\) \[arguments-invalid\]/u);

            const p3 = await getPacket(db, turnIds[3]);
            assert.equal(packetSection(p3, "notices"), "");
            assert.ok(
                logEntries(p3).some((e) => e.logPath.endsWith("/read") && e.path?.startsWith("exec:///plurnk/") && (e.status === undefined || e.status === 200)),
                "successful plurnk.env({}) list remains in ## Log",
            );
        } finally {
            ws.close();
        }
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§stream-control} {§log-history-projection} {§operation-results}: plurnk.kill on an already-terminated exec:/// stream initializes active=0, surfaces once on T+1 ## Notices, and vanishes on T+2", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `matrix-exec-kill-204-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Clean up terminated stream.");
        const entryId = await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "exec",
            pathname: "/sh/31111111",
            channel: "stdout",
            content: "done\n",
            mimetype: "text/stream",
            output: true,
        });
        const subscriptionId = await ChannelWrite.openSubscription(db, {
            sessionId,
            entryId,
            scheme: "exec",
            handle: "sh: /sh/31111111",
        });
        await ChannelWrite.closeSubscription(db, { subscriptionId, result: { status: 200 } });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [
                rawTurn("await plurnk.kill({\"path\":\"exec:///sh/31111111\"});\n\nawait plurnk.note({\"text\":\"attempted cleanup\"});"),
                rawTurn("await plurnk.note({\"text\":\"observed 204 notice\"});"),
                rawTurn("await plurnk.done({\"text\":\"clean\"});"),
            ],
        });

        const t1 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.equal(t1.status, 102);
        const t1Rows = await db.test_log_entries_by_turn.all<{ id: number; op: string; status_rx: number }>({ turn_id: t1.turnId });
        const killRow = t1Rows.find((r) => r.op === "kill");
        assert.ok(killRow, "204 exec:/// kill remains durable in log_entries");
        assert.equal(killRow.status_rx, 204);

        const t2 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.equal(t2.status, 102);
        const p2 = await getPacket(db, t2.turnId);
        assert.equal(logEntries(p2).filter((e) => e.logPath.endsWith("/kill")).length, 0, "204 exec:/// kill initializes active=0 and stays out of ## Log");
        assert.doesNotMatch(packetSection(p2, "emission-history"), /exec:\/\/\/sh\/31111111/u, "204 exec:/// kill stays out of emission-history");
        assert.match(
            packetSection(p2, "notices"),
            /204 kill \(exec:\/\/\/sh\/31111111\): Stream exec:\/\/\/sh\/31111111 already terminated \(status 200\); nothing changed\. \[no_match\]/u,
            "204 exec:/// kill surfaces once on T+1 ## Notices",
        );

        const t3 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.equal(t3.status, 200);
        const p3 = await getPacket(db, t3.turnId);
        assert.doesNotMatch(packetSection(p3, "notices"), /exec:\/\/\/sh\/31111111/u, "204 exec:/// kill notice vanishes on T+2");
    } finally {
        await db.close();
    }
});
});
