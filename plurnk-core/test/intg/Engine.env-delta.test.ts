import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Engine, { type LoopUsage } from "../../src/core/Engine.ts";
import Fork from "../../src/core/fork.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Turn, { type TurnKind, type TurnProducer } from "../../src/core/Turn.ts";
import Results from "../../src/core/results.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Log from "../../src/schemes/Log.ts";
import LogEntryProjection from "../../src/core/LogEntryProjection.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import LogBody from "../../src/core/LogBody.ts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentWeight } from "../../src/core/content-weight.ts";
import { Mock, type MockResponse, chatMessageText } from "@plurnk/plurnk-providers";
import { type EditStatement, type UrlPath, Validator } from "@plurnk/plurnk-contracts";
import { type Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn, rootWorkspace, seedEntryWithChannel, sendingOperation, holdChild } from "./_db.ts";
import { logEntries, packetSection } from "./_packet.ts";
import { makeSchemeCtx, DEFAULT_MIMETYPES, readLog } from "./_scheme.ts";
import { killStmt, noteStmt, readStmt, urlPath } from "./_dsl.ts";
import { serverProposals } from "./_approval.ts";
import { rpcCall, subscribeNotifications, connect, withDaemon, runLoopToTerminal, waitFor, waitForDb } from "./_rpc.ts";
import { makeMockResponse, makeRawMockResponse } from "./_mock.ts";
import { namedModelSession } from "./_sessions.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { viableWindow } from "./_provider.ts";
import { parseLogRecords } from "../LogRecords.ts";

describe("Engine.env-delta", () => {
const execFileP = promisify(execFile);

const okSend = (): MockResponse => ({
    assistant: {
        content: "",
        ops: [noteStmt("Observed the workspace activity.")],
        reasoning: null,
    },
});
const MESSAGES = [{ role: "system" as const, content: "You are an agent." }, { role: "user" as const, content: "go" }];

// {§tokenomics} — the envelope rides the provider; the wide Mock windows in this file keep overflow recovery out.
const makeEngine = (db: Db): Engine => new Engine({ db, schemes: new SchemeRegistry() });

// Controlled concurrency specimen: let one real prepared statement finish, then
// inject an occurrence before Engine can consume its result. This fixes the race
// at the exact persistence boundary without sleeps or an Engine-only test seam.
const afterFirstStatement = (
    db: Db,
    statementName: string,
    methodName: "all" | "get" | "run",
    after: () => Promise<void>,
): Db => {
    type Statement = Record<string, (...args: unknown[]) => Promise<unknown>>;
    const statement = (db as unknown as Record<string, Statement>)[statementName];
    if (statement === undefined) throw new Error(`missing prepared statement ${statementName}`);
    let pending = true;
    const wrapped = new Proxy(statement, {
        get(target, property) {
            const value = Reflect.get(target, property, target) as unknown;
            if (property !== methodName || typeof value !== "function") return value;
            return async (...args: unknown[]) => {
                const result = await Reflect.apply(value, target, args) as unknown;
                if (pending) {
                    pending = false;
                    await after();
                }
                return result;
            };
        },
    });
    return new Proxy(db, {
        get(target, property) {
            return property === statementName ? wrapped : Reflect.get(target, property, target);
        },
    });
};

const sessionPath = (authority: string, pathname: string): UrlPath => ({
    kind: "url", raw: `session://${authority}${pathname}`, scheme: "session",
    username: null, password: null, hostname: authority, port: null,
    pathname, query: null, fragment: null,
});
const editStmt = (target: UrlPath, body: string): EditStatement => ({
    metadata: null,
    op: "EDIT", aside: null, target, lineMarker: null, body,
    matcher: null, position: { line: 1, column: 1 },
});
test("{§env-delta} a parent receives all direct-child entry activity while an independent runtime session stays private", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `owner-delta-${crypto.randomUUID()}`);
        const observer = await insertSession(db, workspaceId, null, "observer");
        const observerLoop = await insertLoop(db, observer, 1, "go");
        const sibling = await insertSession(db, workspaceId, observer, "sibling");
        const siblingLoop = await insertLoop(db, sibling, 1);
        const siblingTurn = await insertTurn(db, siblingLoop, 1);
        const kernel = await insertSession(db, workspaceId, null, "plurnk");
        const kernelLoop = await insertLoop(db, kernel, 1);
        const kernelTurn = await insertTurn(db, kernelLoop, 1);
        const eng = makeEngine(db);
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend()] });

        await eng.runTurn({ provider, workspaceId, sessionId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 1 });
        assert.equal((await eng.dispatch({
            statement: editStmt(urlPath("workspace", "/shared.md"), "shared bulletin"),
            workspaceId, sessionId: sibling, loopId: siblingLoop, turnId: siblingTurn, sequence: 1, origin: "model",
        })).status, 201, "the sibling creates a commons entry");
        assert.equal((await eng.dispatch({
            statement: editStmt(sessionPath("sibling", "/secret.md"), "named scratch"),
            workspaceId, sessionId: sibling, loopId: siblingLoop, turnId: siblingTurn, sequence: 2, origin: "model",
        })).status, 201, "the sibling creates current-session scratch");
        assert.equal((await eng.dispatch({
            statement: editStmt(sessionPath("sibling", "/named-secret.md"), "named scratch"),
            workspaceId, sessionId: sibling, loopId: siblingLoop, turnId: siblingTurn, sequence: 3, origin: "model",
        })).status, 201, "named scratch is writable");
        assert.equal((await eng.dispatch({
            statement: editStmt(sessionPath("plurnk", "/bulletin.md"), "runtime bulletin"),
            workspaceId, sessionId: kernel, loopId: kernelLoop, turnId: kernelTurn, sequence: 1, origin: "_plurnk",
        })).status, 201, "the runtime actor writes ordinary named scratch");

        await eng.runTurn({ provider, workspaceId, sessionId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 2 });
        const rows = await db.engine_render_log.all<{
            origin: string; op: string; scheme: string | null; hostname: string | null;
            pathname: string | null; source: string | null; rx: string;
        }>({ session_id: observer });
        const deltas = rows.filter((row) => row.origin === "_plurnk" && row.op === "EDIT");

        assert.deepEqual(
            deltas
                .filter((row) => row.scheme === "session" || row.scheme === "workspace")
                .map(({ hostname, pathname, source }) => ({ hostname, pathname, source }))
                .toSorted((a, b) => (a.pathname ?? "").localeCompare(b.pathname ?? "")),
            [
                { hostname: "sibling", pathname: "/named-secret.md", source: "session://sibling" },
                { hostname: "sibling", pathname: "/secret.md", source: "session://sibling" },
                { hostname: null, pathname: "/shared.md", source: "session://sibling" },
            ],
            "lineage supervision carries every child operation, including private-entry activity",
        );
        assert.doesNotMatch(JSON.stringify(deltas), /runtime bulletin/, "an independent runtime actor does not broadcast its private mutation");
    } finally {
        await db.close();
    }
});

test("{§env-delta}: child log curation stays with the child, including failures", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `curation-observation-${crypto.randomUUID()}`);
        const parent = await insertSession(db, workspaceId, null, "parent");
        const parentLoop = await insertLoop(db, parent, 1, "Observe the child.");
        const child = await insertSession(db, workspaceId, parent, "child");
        const childLoop = await insertLoop(db, child, 1);
        const childTurn = await insertTurn(db, childLoop, 1);
        const engine = makeEngine(db);
        const dispatch = (statement: Parameters<Engine["dispatch"]>[0]["statement"], sequence: number) => engine.dispatch({
            statement, workspaceId, sessionId: child, loopId: childLoop,
            turnId: childTurn, sequence, origin: "model",
        });
        assert.equal((await dispatch(editStmt(sessionPath("child", "/note"), "child note"), 1)).status, 201);
        assert.equal((await dispatch(killStmt(urlPath("log", "/1/1/1/EDIT")), 2)).status, 200);
        assert.equal((await dispatch(killStmt(urlPath("log", "/9/9/9")), 3)).status, 404);
        const turn = await engine.runTurn({
            provider: new Mock({ contextWindow: 32768, responses: [okSend()] }),
            workspaceId, sessionId: parent, loopId: parentLoop, messages: MESSAGES,
        });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turn.turnId }))!.packet);
        const kills = logEntries(packet).filter(({ logPath: path }) => path.endsWith("/KILL"));
        assert.deepEqual(kills, [], "neither successful nor failed log curation becomes parent activity");
        const observations = await db.test_log_entries_by_session.all<{ op: string; source: string; status_rx: number }>({ session_id: parent });
        assert.deepEqual(observations.filter(({ op }) => op === "KILL"), []);
        assert.ok(observations.some(({ op, source }) => op === "EDIT" && source === "session://child"), "the actual edit still reaches the parent");
        const childHistory = await db.test_log_entries_by_session.all<{ op: string; status_rx: number }>({ session_id: child });
        assert.deepEqual(childHistory.filter(({ op }) => op === "KILL").map(({ status_rx }) => status_rx), [200, 404],
            "both curation outcomes remain durable for the child and forensics");
    } finally {
        await db.close();
    }
});

test("{§env-delta} a session learns a sibling's edit through its own log — pulled from the shared log, no per-session snapshot", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `xrun-${crypto.randomUUID()}`);
        const sessionA = await insertSession(db, workspaceId, null, "observer");
        const loopA = await insertLoop(db, sessionA, 1, "go");
        const sessionB = await insertSession(db, workspaceId, null, "sibling");
        const loopB = await insertLoop(db, sessionB, 1);
        const turnB = await insertTurn(db, loopB, 1);
        const eng = makeEngine(db);
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend()] });

        // A's turn 1 sets its "last looked" boundary; nothing happened before it, so no deltas.
        await eng.runTurn({ provider, workspaceId, sessionId: sessionA, loopId: loopA, messages: MESSAGES, turnNumber: 1 });
        // B edits a shared entry — a real EDIT row in B's own log.
        const edit = await eng.dispatch({ statement: editStmt(urlPath("workspace", "/shared.md"), "from sibling B"), workspaceId, sessionId: sessionB, loopId: loopB, turnId: turnB, sequence: 1, origin: "model" });
        assert.ok(edit.status === 200 || edit.status === 201, "B's edit to the shared entry lands");

        // A's turn 2 pulls B's edit from the shared log as a body-suppressed delta — A consulted no
        // per-session snapshot; it learned its workspace moved purely through its own log.
        const turn = await eng.runTurn({ provider, workspaceId, sessionId: sessionA, loopId: loopA, messages: MESSAGES, turnNumber: 2 });
        const rows = await db.engine_render_log.all<{ scheme: string | null; origin: string; op: string; pathname: string; source: string | null; initial_folded: string; folded: string }>({ session_id: sessionA });
        const delta = rows.find((r) => r.op === "EDIT" && r.origin === "_plurnk" && r.scheme === "workspace" && r.pathname === "/shared.md");
        assert.ok(delta, "A's turn-2 log carries a delta for B's edit");
        assert.equal(delta.source, "session://sibling", "the durable delta uses the sibling's addressable identity");
        assert.equal(delta.initial_folded, "[[1,-1]]", "the broadcast delta lands body-suppressed — listed until the model READs what it needs");
        assert.equal(delta.folded, "[]", "the broadcast does not trim the readable delta");

        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turn.turnId }))!.packet);
        const packetDelta = logEntries(packet).find((entry) => entry.path === "workspace:///shared.md" && entry.logPath.endsWith("/EDIT"));
        assert.equal(packetDelta?.source, "session://sibling", "the model sees the same session identity used by session control");
    } finally {
        await db.close();
    }
});

test("{§env-delta} ambient delivery follows monotonic occurrence identity, never wall-clock order", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `event-id-${crypto.randomUUID()}`);
        const observer = await insertSession(db, workspaceId, null, "observer");
        const observerLoop = await insertLoop(db, observer, 1, "observe");
        const producer = await insertSession(db, workspaceId, null, "producer");
        const producerLoop = await insertLoop(db, producer, 1, "produce");
        const producerTurn = await insertTurn(db, producerLoop, 1);
        const eng = makeEngine(db);
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend(), okSend()] });

        await eng.runTurn({ provider, workspaceId, sessionId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 1 });

        const sameOldTime = "2000-01-01T00:00:00.000Z";
        for (const [index, pathname] of ["/equal-a.md", "/equal-b.md"].entries()) {
            await db.test_insert_shared_edit_at.get({
                session_id: producer,
                loop_id: producerLoop,
                turn_id: producerTurn,
                sequence: index + 1,
                at: sameOldTime,
                pathname,
                rx: JSON.stringify({ status: 201, span: `1:${pathname}` }),
            });
        }

        await eng.runTurn({ provider, workspaceId, sessionId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 2 });
        await eng.runTurn({ provider, workspaceId, sessionId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 3 });

        const rows = await db.engine_render_log.all<{ origin: string; op: string; pathname: string | null }>({ session_id: observer });
        const observed = rows
            .flatMap(({ origin, op, pathname }) => origin === "_plurnk" && op === "EDIT" && pathname?.startsWith("/equal-") === true ? [pathname] : [])
            .toSorted();
        assert.deepEqual(observed, ["/equal-a.md", "/equal-b.md"], "both equal-time events arrive, once each");

        const links = async (sessionId: number) => (await db.test_log_entries_by_session.all<{
            ambient_event_id: number | null; pathname: string | null;
        }>({ session_id: sessionId }))
            .filter((row) => row.pathname?.startsWith("/equal-") === true)
            .map(({ pathname, ambient_event_id }) => ({ pathname, eventId: ambient_event_id }))
            .toSorted((a, b) => (a.pathname ?? "").localeCompare(b.pathname ?? ""));
        const produced = await links(producer);
        assert.ok(produced.every(({ eventId }) => eventId !== null), "each source row is atomically linked to its occurrence");
        assert.ok((produced[0]?.eventId ?? 0) < (produced[1]?.eventId ?? 0), "equal wall time does not disturb total occurrence order");
        assert.deepEqual(await links(observer), produced, "observer rows carry the same stable event identities as their sources");
    } finally {
        await db.close();
    }
});

test("{§env-delta} a settled child proposal reaches its parent while only a landed commons effect broadcasts", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `proposal-event-${crypto.randomUUID()}`);
        const observer = await insertSession(db, workspaceId, null, "observer");
        const observerLoop = await insertLoop(db, observer, 1, "observe");
        const independent = await insertSession(db, workspaceId, null, "independent");
        const independentLoop = await insertLoop(db, independent, 1, "observe");
        const producer = await insertSession(db, workspaceId, observer, "producer");
        const producerLoop = await insertLoop(db, producer, 1, "propose");
        const producerTurn = await insertTurn(db, producerLoop, 1);
        const eng = makeEngine(db);
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend(), okSend(), okSend()] });
        await eng.runTurn({ provider, workspaceId, sessionId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 1 });
        await eng.runTurn({ provider, workspaceId, sessionId: independent, loopId: independentLoop, messages: MESSAGES, turnNumber: 1 });

        const propose = async (sequence: number, pathname: string): Promise<number> => {
            const row = await db.engine_insert_log_entry.get<{ id: number }>({
                session_id: producer, loop_id: producerLoop, turn_id: producerTurn, sequence,
                origin: "model", source: null, model_call_id: null, op: "EDIT",
                scheme: "workspace", username: null, password: null, hostname: null, port: null,
                pathname, query: null, fragment: null, lineMarker: null,
                tx: "", mimetype_tx: "text/plain", rx: JSON.stringify({ status: 202 }),
                mimetype_rx: "application/json", status_rx: 202, weight: 0,
                state: "proposed", outcome: null, attrs: "{}",
            });
            if (row === undefined) throw new Error("proposal fixture was not persisted");
            return row.id;
        };
        const accepted = await propose(1, "/accepted-proposal.md");
        const rejected = await propose(2, "/rejected-proposal.md");
        await db.engine_resolve_log_entry.run({
            id: accepted, state: "resolved", outcome: "accepted", status_rx: 201,
            rx: JSON.stringify({ status: 201, span: "1:accepted" }),
            weight: contentWeight("1:accepted"),
        });
        await db.engine_resolve_log_entry.run({
            id: rejected, state: "failed", outcome: "rejected", status_rx: 403,
            rx: JSON.stringify(Results.failure("engine:test", "proposal-rejected", 403, "The proposal was rejected.")),
            weight: 0,
        });

        await eng.runTurn({ provider, workspaceId, sessionId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 2 });
        await eng.runTurn({ provider, workspaceId, sessionId: independent, loopId: independentLoop, messages: MESSAGES, turnNumber: 2 });
        const observed = async (sessionId: number) => (await db.engine_render_log.all<{
            origin: string; op: string; pathname: string | null; source: string | null;
        }>({ session_id: sessionId }))
            .filter((row) => row.origin === "_plurnk" && row.source === "session://producer" && row.op === "EDIT" && row.pathname?.endsWith("-proposal.md") === true)
            .map((row) => row.pathname);
        assert.deepEqual(await observed(observer), ["/accepted-proposal.md", "/rejected-proposal.md"], "the parent supervises both final proposal outcomes");
        assert.deepEqual(await observed(independent), ["/accepted-proposal.md"], "only the successfully landed commons effect broadcasts");
    } finally {
        await db.close();
    }
});

test("{§env-delta} a closed pull boundary assigns before, during, and after races exactly once", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `closed-boundary-${crypto.randomUUID()}`);
        const observer = await insertSession(db, workspaceId, null, "observer");
        const observerLoop = await insertLoop(db, observer, 1, "observe");
        const producer = await insertSession(db, workspaceId, null, "producer");
        const producerLoop = await insertLoop(db, producer, 1, "produce");
        const producerTurn = await insertTurn(db, producerLoop, 1);
        const eng = makeEngine(db);
        let producerSequence = 1;
        const emit = async (pathname: string): Promise<void> => {
            const result = await eng.dispatch({
                statement: editStmt(urlPath("workspace", pathname), pathname),
                workspaceId,
                sessionId: producer,
                loopId: producerLoop,
                turnId: producerTurn,
                sequence: producerSequence++,
                origin: "model",
            });
            assert.ok(result.status === 200 || result.status === 201);
        };

        await eng.runTurn({
            provider: new Mock({ contextWindow: 4096, responses: [okSend()] }),
            workspaceId, sessionId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 1,
        });

        let racedDb = afterFirstStatement(db, "turn_open", "get", () => emit("/before-boundary.md"));
        racedDb = afterFirstStatement(racedDb, "engine_pull_ambient_events", "all", () => emit("/during-boundary.md"));
        await makeEngine(racedDb).runTurn({
            provider: new Mock({ contextWindow: 4096, responses: [okSend()] }),
            workspaceId, sessionId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 2,
        });
        await emit("/after-boundary.md");

        const tailProvider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend()] });
        await eng.runTurn({ provider: tailProvider, workspaceId, sessionId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 3 });
        await eng.runTurn({ provider: tailProvider, workspaceId, sessionId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 4 });

        const rows = await db.engine_render_log.all<{
            turn_seq: number; origin: string; op: string; pathname: string | null;
        }>({ session_id: observer });
        assert.deepEqual(
            rows
                .filter((row) => row.origin === "_plurnk" && row.op === "EDIT" && row.pathname?.endsWith("-boundary.md") === true)
                .map(({ turn_seq, pathname }) => ({ turn: turn_seq, pathname }))
                .toSorted((a, b) => (a.pathname ?? "").localeCompare(b.pathname ?? "")),
            [
                { turn: 4, pathname: "/after-boundary.md" },
                { turn: 3, pathname: "/before-boundary.md" },
                { turn: 4, pathname: "/during-boundary.md" },
            ],
            "after packetless initialization, the captured window owns only the event already inside it; both later events wait for the next pull",
        );
    } finally {
        await db.close();
    }
});

test("{§env-delta} a fresh session baselines history but retains an event racing its first packet", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `first-boundary-${crypto.randomUUID()}`);
        const producer = await insertSession(db, workspaceId, null, "producer");
        const producerLoop = await insertLoop(db, producer, 1, "produce");
        const producerTurn = await insertTurn(db, producerLoop, 1);
        const eng = makeEngine(db);
        let producerSequence = 1;
        const emit = async (pathname: string): Promise<void> => {
            await eng.dispatch({
                statement: editStmt(urlPath("workspace", pathname), pathname),
                workspaceId, sessionId: producer, loopId: producerLoop, turnId: producerTurn,
                sequence: producerSequence++, origin: "model",
            });
        };

        await emit("/historical.md");
        const observer = await insertSession(db, workspaceId, null, "observer");
        const observerLoop = await insertLoop(db, observer, 1, "observe");
        const racedDb = afterFirstStatement(db, "engine_initialize_ambient_cursor", "get", () => emit("/first-turn-race.md"));
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend()] });
        await makeEngine(racedDb).runTurn({
            provider, workspaceId, sessionId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 1,
        });
        await eng.runTurn({ provider, workspaceId, sessionId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 2 });

        const rows = await db.engine_render_log.all<{ origin: string; op: string; pathname: string | null }>({ session_id: observer });
        const observed = rows
            .filter((row) => row.origin === "_plurnk" && row.op === "EDIT" && ["/historical.md", "/first-turn-race.md"].includes(row.pathname ?? ""))
            .map((row) => row.pathname);
        assert.deepEqual(observed, ["/first-turn-race.md"], "pre-baseline history stays out; a post-baseline race remains deliverable once");
    } finally {
        await db.close();
    }
});

test("{§env-delta} ambient occurrence evidence survives source-log curation", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `curated-source-${crypto.randomUUID()}`);
        const observer = await insertSession(db, workspaceId, null, "observer");
        const observerLoop = await insertLoop(db, observer, 1, "observe");
        const producer = await insertSession(db, workspaceId, null, "producer");
        const producerLoop = await insertLoop(db, producer, 1, "produce");
        const producerTurn = await insertTurn(db, producerLoop, 1);
        const eng = makeEngine(db);
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend()] });

        await eng.runTurn({ provider, workspaceId, sessionId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 1 });
        await eng.dispatch({
            statement: editStmt(urlPath("workspace", "/curated.md"), "durable occurrence"),
            workspaceId, sessionId: producer, loopId: producerLoop, turnId: producerTurn, sequence: 1, origin: "model",
        });
        const killed = await new Log().kill(killStmt(urlPath("log", "/1/1/1")), makeSchemeCtx({
            db, workspaceId, sessionId: producer, loopId: producerLoop, turnId: producerTurn, writer: "model",
        }));
        assert.equal(killed.status, 200, "the producer really curated away its source row");

        await eng.runTurn({ provider, workspaceId, sessionId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 2 });
        const rows = await db.engine_render_log.all<{ origin: string; op: string; pathname: string | null; rx: string }>({ session_id: observer });
        const delta = rows.find((row) => row.origin === "_plurnk" && row.op === "EDIT" && row.pathname === "/curated.md");
        assert.match(delta?.rx ?? "", /durable occurrence/, "curating the producer's log cannot erase the ambient event");
        await db.test_workspaces_delete.run({ id: workspaceId });
    } finally {
        await db.close();
    }
});

test("{§env-delta} a fork inherits observed progress and independently receives pending events", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fork-cursor-${crypto.randomUUID()}`);
        const parent = await insertSession(db, workspaceId, null, "parent");
        const parentLoop = await insertLoop(db, parent, 1, "observe");
        const producer = await insertSession(db, workspaceId, null, "producer");
        const producerLoop = await insertLoop(db, producer, 1, "produce");
        const producerTurn = await insertTurn(db, producerLoop, 1);
        const eng = makeEngine(db);
        const parentProvider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend(), okSend()] });

        await eng.runTurn({ provider: parentProvider, workspaceId, sessionId: parent, loopId: parentLoop, messages: MESSAGES, turnNumber: 1 });
        await eng.dispatch({
            statement: editStmt(urlPath("workspace", "/seen-before-fork.md"), "seen"),
            workspaceId, sessionId: producer, loopId: producerLoop, turnId: producerTurn, sequence: 1, origin: "model",
        });
        await eng.runTurn({ provider: parentProvider, workspaceId, sessionId: parent, loopId: parentLoop, messages: MESSAGES, turnNumber: 2 });
        await eng.dispatch({
            statement: editStmt(urlPath("workspace", "/pending-at-fork.md"), "pending"),
            workspaceId, sessionId: producer, loopId: producerLoop, turnId: producerTurn, sequence: 2, origin: "model",
        });

        const branch = await Fork.fork(db, parent, "branch");
        const branchLoop = await insertLoop(db, branch, 2, "continue");
        await eng.runTurn({
            provider: new Mock({ contextWindow: 4096, responses: [okSend()] }),
            workspaceId, sessionId: branch, loopId: branchLoop, messages: MESSAGES, turnNumber: 1,
        });
        await eng.runTurn({ provider: parentProvider, workspaceId, sessionId: parent, loopId: parentLoop, messages: MESSAGES, turnNumber: 3 });

        for (const [sessionId, label] of [[branch, "branch"], [parent, "parent"]] as const) {
            const rows = await db.engine_render_log.all<{ origin: string; op: string; pathname: string | null; source: string | null }>({ session_id: sessionId });
            const paths = rows
                .filter((row) => row.origin === "_plurnk" && row.op === "EDIT" && row.pathname?.endsWith("-fork.md") === true)
                .map(({ pathname, source }) => ({ pathname, source }))
                .toSorted((a, b) => (a.pathname ?? "").localeCompare(b.pathname ?? ""));
            assert.deepEqual(paths, [
                { pathname: "/pending-at-fork.md", source: "session://producer" },
                { pathname: "/seen-before-fork.md", source: "session://producer" },
            ], `${label} preserves the public cause across copied history and pending delivery`);
        }
    } finally {
        await db.close();
    }
});

test("{§env-delta} a child-activity delta preserves typed attributes and initial classifications", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `typed-delta-${crypto.randomUUID()}`);
        const observer = await insertSession(db, workspaceId, null, "observer");
        const observerLoop = await insertLoop(db, observer, 1, "go");
        const producer = await insertSession(db, workspaceId, observer, "producer");
        const producerLoop = await insertLoop(db, producer, 1);
        const producerTurn = await insertTurn(db, producerLoop, 1);
        const eng = makeEngine(db);
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend()] });

        await eng.runTurn({ provider, workspaceId, sessionId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 1 });
        const inserted = await db.engine_insert_log_entry.get<{ id: number }>({
            session_id: producer, loop_id: producerLoop, turn_id: producerTurn, sequence: 1,
            origin: "_plurnk", source: "session://observer", model_call_id: null,
            op: "EDIT", signal: JSON.stringify(["+query"]),
            scheme: "https", username: null, password: null, hostname: "example.org", port: null,
            pathname: "/page", query: null, fragment: null, lineMarker: null,
            tx: JSON.stringify({ op: "EDIT", matcher: null, body: "page" }), mimetype_tx: "application/json",
            rx: JSON.stringify({ status: 201, span: "1:page" }), mimetype_rx: "application/json",
            status_rx: 201, weight: 1, state: "resolved", outcome: null,
            attrs: JSON.stringify({ kind: "entry_materialized" }),
        });
        assert.ok(inserted !== undefined);

        await eng.runTurn({ provider, workspaceId, sessionId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 2 });
        const rows = await db.engine_render_log.all<{ origin: string; op: string; pathname: string; source: string | null; attrs: string }>({ session_id: observer });
        const delta = rows.find((row) => row.origin === "_plurnk" && row.op === "EDIT" && row.pathname === "/page");
        assert.equal(delta?.source, "session://producer");
        assert.deepEqual(JSON.parse(delta?.attrs ?? "{}"), { kind: "entry_materialized" });
    } finally {
        await db.close();
    }
});

test("{§methods-workspace-create} exactly two cross-session channels — state via the env-delta, a message via inject", async () => {
    // Both doors in one place: inject and IRC resume parked sessions in place
    // under {§methods-workspace-create}. No third channel — by design.
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `two-doors-${crypto.randomUUID()}`);
        const sessionA = await insertSession(db, workspaceId, null, "observer");
        const loopA = await insertLoop(db, sessionA, 1, "go");
        const sessionB = await insertSession(db, workspaceId, null, "sibling");
        const loopB = await insertLoop(db, sessionB, 1);
        const turnB = await insertTurn(db, loopB, 1);
        const eng = makeEngine(db);
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend()] });

        await eng.runTurn({ provider, workspaceId, sessionId: sessionA, loopId: loopA, messages: MESSAGES, turnNumber: 1 });
        // ENVIRONMENT DOOR — *state*: B's edit to a shared entry crosses to A as a body-suppressed delta, not a message.
        await eng.dispatch({ statement: editStmt(urlPath("workspace", "/shared.md"), "from sibling B"), workspaceId, sessionId: sessionB, loopId: loopB, turnId: turnB, sequence: 1, origin: "model" });
        await eng.runTurn({ provider, workspaceId, sessionId: sessionA, loopId: loopA, messages: MESSAGES, turnNumber: 2 });
        const rows = await db.engine_render_log.all<{ origin: string; op: string; pathname: string; source: string | null; weight: number }>({ session_id: sessionA });
        const ambient = rows.find((r) => r.op === "EDIT" && r.origin === "_plurnk" && r.pathname === "/shared.md" && r.source === "session://sibling");
        assert.ok(ambient, "environment door: B's shared-entry edit crossed to A as a delta (state, ambient)");
        assert.ok(ambient.weight > 0, "the ambient copy retains the source event's canonical body weight");

        // VOICE DOOR — *message*: an inject delivers a directed message onto A's own loop's next turn.
        await db.test_set_loop_status.run({ id: loopA, status: 102, terminal_result: null }); // A is the active loop
        const injected = await eng.injectIntoLoop(loopA, "a directed message for A");
        assert.notEqual(injected, null, "voice door: the inject found A's loop and delivered");
        assert.equal(injected!.loopId, loopA, "the message landed on A's loop — directed, not ambient");
    } finally {
        await db.close();
    }
});

test("{§env-delta} an out-of-band disk change is runtime evidence, not a workspace broadcast", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-envdelta-"));
    const db = await openMigrated();
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "notes.md"), "line1\nline2\n");
        await execFileP("git", ["add", "notes.md"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env: hermeticGitEnv() });

        const workspaceId = await insertWorkspace(db, `envfs-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const sessionA = await insertSession(db, workspaceId);
        const loopA = await insertLoop(db, sessionA, 1, "go");
        const eng = makeEngine(db);
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend()] });

        // Turn 1 materializes notes.md from disk (first sight — no divergence).
        await eng.runTurn({ provider, workspaceId, sessionId: sessionA, loopId: loopA, messages: MESSAGES, turnNumber: 1 });
        const afterT1 = await db.engine_render_log.all<{ origin: string; op: string; source: string | null }>({ session_id: sessionA });
        assert.ok(!afterT1.some((r) => r.origin === "_plurnk" && r.op === "EDIT" && r.source === "file"), "first sight reconciles silently — no fs delta");
        // The file changes out-of-band (an external editor, a git pull).
        await writeFile(join(root, "notes.md"), "line1\nline2\nline3-external\n");

        // Turn 2 — the runtime actor records the divergence, but the unrelated
        // model session does not receive ambient filesystem noise.
        const turn2 = await eng.runTurn({ provider, workspaceId, sessionId: sessionA, loopId: loopA, messages: MESSAGES, turnNumber: 2 });
        const rows = await db.engine_render_log.all<{ origin: string; op: string; source: string | null; rx: string; pathname: string; folded: string; attrs: string; weight: number }>({ session_id: sessionA });
        assert.ok(!rows.some((r) => r.source === "file"), "project-file divergence does not enter an unrelated session log");
        const runtimeSession = await db.envelope_get_session_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "_plurnk" });
        assert.ok(runtimeSession, "the runtime actor owns the reconciliation evidence");
        const runtimeRows = await db.engine_render_log.all<{ source: string | null; pathname: string; rx: string; attrs: string; weight: number }>({ session_id: runtimeSession.id });
        const delta = runtimeRows.find((row) => row.source === "file" && row.pathname === "notes.md");
        assert.ok(delta, "the runtime log retains exact source=file evidence");
        const span = JSON.parse(delta.rx).span as string;
        assert.match(span, /line3-external/, "the delta carries the changed span ({§env-delta})");
        assert.equal(delta.weight, contentWeight(span), "the fs delta stores the weight of its canonical changed span");
        assert.equal((JSON.parse(delta.attrs) as { git?: string }).git, " M", "the event preserves Git's exact unstaged coordinate");
        const packet = await db.test_get_packet.get<{ packet: string }>({ id: turn2.turnId });
        const log = packetSection(JSON.parse(packet!.packet), "log");
        assert.doesNotMatch(log, /"git":" M"/, "runtime reconciliation evidence is not projected into the unrelated model packet");
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§file-snapshot-revision}: deletion removes stale content and records private runtime evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-envdelta-delete-"));
    const db = await openMigrated();
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "removed.md"), "present\n");
        await execFileP("git", ["add", "removed.md"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env: hermeticGitEnv() });

        const workspaceId = await insertWorkspace(db, `envfs-delete-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = makeEngine(db);
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend()] });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: MESSAGES, turnNumber: 1 });
        await rm(join(root, "removed.md"));
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: MESSAGES, turnNumber: 2 });

        const channel = await db.ops_read_channel.get({ workspace_id: workspaceId, scheme: "file", authority: "", pathname: "removed.md", channel: "body" });
        assert.equal(channel, undefined, "a deleted file cannot remain READable from a stale body channel");
        const rows = await db.engine_render_log.all<{ source: string | null; pathname: string }>({ session_id: sessionId });
        assert.ok(!rows.some((row) => row.source === "file"), "the deletion does not broadcast into the model session");
        const runtimeSession = await db.envelope_get_session_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "_plurnk" });
        assert.ok(runtimeSession);
        const runtimeRows = await db.engine_render_log.all<{ source: string | null; pathname: string; rx: string; attrs: string }>({ session_id: runtimeSession.id });
        const delta = runtimeRows.find((row) => row.source === "file" && row.pathname === "removed.md");
        assert.ok(delta, "the observed deletion remains durable runtime evidence");
        assert.equal((JSON.parse(delta.rx) as { span: string }).span, "", "the deleted resource has no resulting text to project");
        assert.equal((JSON.parse(delta.attrs) as { git?: string }).git, " D", "Git classifies the observed worktree deletion exactly");
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

// {§session-scheme} / {§env-delta}
test("{§env-delta} administrative loops stay private without hiding real model-free or pre-turn conclusions", async (t) => {
    type Authorship = { producer: TurnProducer; kind: TurnKind };
    const maintenance: Authorship = { producer: "_plurnk", kind: "maintenance" };
    const operation: Authorship = { producer: "_plurnk", kind: "operation" };
    const inference: Authorship = { producer: "model", kind: "inference" };
    const cases: Array<{ name: string; turns: Authorship[]; delivered: boolean }> = [
        { name: "maintenance", turns: [maintenance], delivered: false },
        { name: "administrative operation", turns: [operation], delivered: false },
        { name: "mixed administrative turns", turns: [maintenance, operation], delivered: false },
        { name: "model inference", turns: [inference], delivered: true },
        { name: "model work after maintenance", turns: [maintenance, inference], delivered: true },
        { name: "initialization without inference", turns: [{ producer: "_plurnk", kind: "initialization" }], delivered: true },
        { name: "client program", turns: [{ producer: "client", kind: "operation" }], delivered: true },
        { name: "before the first turn", turns: [], delivered: true },
    ];
    for (const specimen of cases) {
        for (const status of [200, 502]) {
            await t.test(`{§env-delta} ${specimen.name}, ${status}`, async () => {
                const db = await openMigrated();
                try {
                    const workspaceId = await insertWorkspace(db, `terminal-kind-${crypto.randomUUID()}`);
                    const parent = await insertSession(db, workspaceId, null, "parent");
                    const parentLoop = await insertLoop(db, parent, 1, "collect");
                    const child = await insertSession(db, workspaceId, parent, "child");
                    const childLoop = await insertLoop(db, child, 1, "work");
                    for (const authorship of specimen.turns) {
                        const turn = await Turn.open(db, { loopId: childLoop, ...authorship });
                        await Turn.complete(db, turn.id, status);
                    }
                    const result = await new LoopLifecycle(db).finish(childLoop, status === 200
                        ? { status: 200, content: "child deliverable", mimetype: "text/plain" }
                        : Results.failure("engine:provider", "provider-failed", status, "child provider unavailable"));
                    assert.ok(result);
                    assert.equal((await db.engine_session_has_undelivered_child_term.get({ session_id: parent })) !== undefined,
                        specimen.delivered, "the pending-result rail follows the actual conclusion audience");
                    const engine = makeEngine(db);
                    await engine.runTurn({
                        provider: new Mock({ contextWindow: 100000, responses: [okSend()] }),
                        workspaceId, sessionId: parent, loopId: parentLoop, messages: MESSAGES,
                    });
                    const rows = await db.engine_render_log.all<{ source: string | null; rx: string }>({ session_id: parent });
                    const outcomes = rows.filter(({ source }) => source === "session://child").map(({ rx }) => JSON.parse(rx));
                    assert.equal(outcomes.length, Number(specimen.delivered));
                    if (specimen.delivered) {
                        assert.equal(outcomes[0].resource, "ops://child/1");
                        assert.equal(outcomes[0].status, result.status);
                        assert.deepEqual(outcomes[0].problem, result.problem);
                        assert.equal(outcomes[0].content, result.content ?? result.problem?.detail);
                    }
                    assert.equal(await db.engine_session_has_undelivered_child_term.get({ session_id: parent }), undefined,
                        "the parent consumes every eligible result through its ordinary observation boundary");
                } finally { await db.close(); }
            });
        }
    }
});

test("{§session-scheme} a child's loop termination reaches only its parent with success, failure, and cancellation bodies visible", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `loopterm-${crypto.randomUUID()}`);
        const sessionA = await insertSession(db, workspaceId);                       // the observer
        const loopA = await insertLoop(db, sessionA, 1, "go");
        const session = await insertSession(db, workspaceId, sessionA, "session");      // finishes gracefully
        const sessionLoop = await insertLoop(db, session, 1, "investigate the bug");
        const failedSession = await insertSession(db, workspaceId, sessionA, "failed-session");
        const failedLoop = await insertLoop(db, failedSession, 1, "call provider");
        const cancelledSession = await insertSession(db, workspaceId, sessionA, "cancelled-session");
        const cancelledLoop = await insertLoop(db, cancelledSession, 1, "get killed");
        const independent = await insertSession(db, workspaceId, null, "independent");
        const independentLoop = await insertLoop(db, independent, 1, "unrelated");
        const eng = makeEngine(db);
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend(), okSend(), okSend()] });

        // A's turn 1 sets its "last looked" boundary; the siblings are still running.
        await eng.runTurn({ provider, workspaceId, sessionId: sessionA, loopId: loopA, messages: MESSAGES, turnNumber: 1 });
        await eng.runTurn({ provider, workspaceId, sessionId: independent, loopId: independentLoop, messages: MESSAGES, turnNumber: 1 });
        // One session delivers successfully; the other retains an uncommon exact
        // provider status even though the scheduler projects it to lifecycle 500.
        const lifecycle = new LoopLifecycle(db);
        const deliverable = { status: 200, content: "the answer is 42", mimetype: "text/markdown" };
        await insertTurn(db, sessionLoop, 1, 102);
        await insertTurn(db, failedLoop, 1, 102);
        await insertTurn(db, cancelledLoop, 1, 102);
        assert.deepEqual(await lifecycle.finish(sessionLoop, deliverable), deliverable);
        assert.equal(
            (await lifecycle.finish(
                failedLoop,
                Results.failure("engine:provider", "provider-failed", 502, "provider_failure"),
            ))?.status,
            502,
        );
        assert.equal(
            (await lifecycle.finish(
                cancelledLoop,
                Results.failure("daemon:loop", "cancelled", 499, "Cancelled by the client."),
                { terminatedBy: "cancel" },
            ))?.status,
            499,
        );

        // A's turn 2 pulls every termination from the shared log: each conclusion born
        // visible, a failure with its Problem beside its message ({§session-scheme}).
        await eng.runTurn({ provider, workspaceId, sessionId: sessionA, loopId: loopA, messages: MESSAGES, turnNumber: 2 });
        await eng.runTurn({ provider, workspaceId, sessionId: independent, loopId: independentLoop, messages: MESSAGES, turnNumber: 2 });
        const rows = await db.engine_render_log.all<{ scheme: string | null; origin: string; op: string; pathname: string | null; source: string | null; status_rx: number | null; rx: string; initial_folded: string; folded: string; attrs: string }>({ session_id: sessionA });

        // {§env-delta}: actor and execution have distinct addresses.
        const terminations = rows.filter((r) => r.origin === "_plurnk" && r.op === "READ" && r.source?.startsWith("session://") === true);
        assert.deepEqual(
            terminations.map(({ source, scheme, pathname, status_rx }) => ({ source, scheme, pathname, status_rx })),
            [
                { source: "session://session", scheme: "ops", pathname: "/1", status_rx: 200 },
                { source: "session://failed-session", scheme: "ops", pathname: "/1", status_rx: 502 },
                { source: "session://cancelled-session", scheme: "ops", pathname: "/1", status_rx: 499 },
            ],
            "every conclusion selects its exact loop, in occurrence order, attributed to the concluding session",
        );
        const win = terminations.find((r) => r.source === "session://session");
        assert.ok(win, "session's completion surfaced as a session delta in A's log");
        assert.equal(win.origin, "_plurnk", "the termination delta is the engine's narration");
        assert.equal(win.source, "session://session", "attributed with the terminating session's control identity");
        assert.equal(win.status_rx, 200, "the terminal status rides");
        const projected = JSON.parse(win.rx);
        assert.equal(projected.status, deliverable.status);
        assert.equal(projected.content, deliverable.content);
        assert.equal(projected.resource, "ops://session/1");
        assert.equal(win.initial_folded, "[]", "initially visible — a child's 2xx deliverable reaches the parent with its body + awakening");
        assert.equal(win.folded, "[]", "the deliverable is untrimmed");

        const failed = terminations.find((r) => r.source === "session://failed-session");
        assert.ok(failed, "the failed loop surfaced too — every death-path stamps terminated_at uniformly");
        assert.equal(failed.status_rx, 502, "the parent edge carries the exact status, not scheduler class 500");
        const failure = JSON.parse(failed.rx) as { status: number; problem?: { detail?: string } };
        assert.equal(failure.status, 502, "the exact failure status survives the parent edge");
        assert.equal(failure.problem?.detail, "provider_failure", "the exact Problem survives the parent edge");
        assert.equal(failed.source, "session://failed-session", "attributed with the failed session's control identity");
        assert.equal(failed.initial_folded, "[]", "a failure is born visible too — its explanation is the deliverable");
        assert.equal(failed.folded, "[]", "the failure is still READable");
        const cancelled = terminations.find((r) => r.source === "session://cancelled-session");
        assert.ok(cancelled, "a KILLed child concludes to its parent through the same retained-outcome READ");
        assert.equal((JSON.parse(cancelled.attrs) as { terminatedBy?: string }).terminatedBy, "cancel", "cancellation authorship rides the attrs, not a target");
        assert.equal(cancelled.initial_folded, "[]", "a cancellation is born visible like every conclusion");
        const independentRows = await db.engine_render_log.all<{ source: string | null }>({ session_id: independent });
        assert.equal(
            independentRows.some(({ source }) => source?.startsWith("session://") === true),
            false,
            "child terminal results never broadcast to an independent root",
        );
        // A fork copies observed conclusions verbatim, retaining their original targets.
        const branch = await Fork.fork(db, sessionA, "branch");
        const branchRows = await db.engine_render_log.all<{ origin: string; op: string; scheme: string | null; pathname: string | null; source: string | null; status_rx: number | null }>({ session_id: branch });
        assert.deepEqual(
            branchRows.filter((r) => r.origin === "_plurnk" && r.op === "READ" && r.source?.startsWith("session://") === true)
                .map(({ source, scheme, pathname, status_rx }) => ({ source, scheme, pathname, status_rx })),
            terminations.map(({ source, scheme, pathname, status_rx }) => ({ source, scheme, pathname, status_rx })),
            "a fork inherits observed conclusions verbatim, including their original source and target",
        );
    } finally {
        await db.close();
    }
});
});

describe("Daemon.loop", () => {
test("{§loop-completion} loop.run accepts immediately (100); the loop's outcome arrives via loop/terminated", async () => {
    const dsl = "````EDIT (workspace:///france/capital)\nParis\n````\n\n````SEND\nParis is the capital.\n````";
    // {§loop-completion} — observe the EDIT receipt before the final SEND.
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse(dsl, 142), makeMockResponse("````SEND [200]\nParis is the capital.\n````", 0)] });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "loop-test" });
            // loop.run accepts and returns immediately (100 + loopId); the terminal outcome —
            // result, turnIds, usage — rides loop/terminated, surfaced here by the helper.
            const result = await runLoopToTerminal(ws, 2, { prompt: "what is the capital of france?" });
            assert.equal(result.accepted, 100, "loop.run returns immediately — accepted, not the terminal");
            assert.equal(result.result.status, 200);
            assert.equal(result.hitMaxTurns, false);
            assert.equal(result.turnIds?.length, 3, "packetless initialization and both model turns are durable chronology (the edit receipt forced the second)");
            // {§notifications}: loop/terminated carries usage summed over the loop's turns.
            assert.equal(result.usage?.accounting.usage?.outputTokens, 142, "output tokens sum the physical request evidence");
            assert.equal(result.usage?.accounting.usage?.inputTokens, 0);
            assert.equal(result.usage?.accounting.usage?.outputTokenDetails?.reasoningTokens, 0);
            assert.equal(result.usage?.accounting.usage?.inputTokenDetails?.cacheReadTokens, 0);
            assert.equal(result.usage?.accounting.costUsd, "0");
            assert.deepEqual(result.attributions, [], "attribution remains a top-level terminal projection, separate from usage");

            const read = await rpcCall(ws, 3, "entry.read", { target: "workspace:///france/capital" });
            const materialized = Validator.assertEntryReadResult(read.result);
            assert.equal(materialized.status, 200);
            assert.equal(materialized.entry?.channels.body?.content, "Paris");
        } finally { ws.close(); }
    });
});

test("{§message-arrival}: a trusted adapter source survives message publication", async () => {
    const mock = new Mock({
        contextWindow: 16384,
        responses: [makeMockResponse("````SEND [200]\ndone\n````", 10)],
    });

    await withDaemon(mock, async (_db, daemon) => {
        const workspace = await daemon.createWorkspace({
            name: `prompt-source-${crypto.randomUUID()}`,
            projectRoot: null,
        });
        const sessionId = await namedModelSession(daemon, workspace.workspaceId, "main");
        const terminated: Array<{ loopId: number }> = [];
        const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => {
            if (method === "loop/terminated") terminated.push(params as { loopId: number });
        });
        try {
            const accepted = await daemon.runLoop({
                workspaceId: workspace.workspaceId,
                sessionId,
                prompt: "external work",
                source: "acp://session42",
            });
            await waitFor(
                () => terminated,
                (events) => events.some(({ loopId }) => loopId === accepted.loopId),
            );
            const prompt = (await daemon.readLog({
                workspaceId: workspace.workspaceId,
                sessionId,
                loopId: accepted.loopId,
            })).find((entry) => entry.op === "SEND" && entry.origin === "_plurnk");
            assert.equal(prompt?.origin, "_plurnk", "the harness remains the arrival-row producer");
            assert.equal(prompt?.source, "acp://session42", "the external actor remains its causal source");
        } finally {
            unsubscribe();
        }
    });
});

test("{§operation-results} loop.inject speaks into an existing session; errors when there's none", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````SEND [200]\nfirst done\n````", 10),
        makeMockResponse("````SEND [200]\ninjected done\n````", 10),
    ] });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "loop-inject" });

            // No model session yet → inject has nothing to talk to (loop.run starts one).
            const noSession = await rpcCall(ws, 2, "loop.inject", { prompt: "too early" });
            const noSessionResult = noSession.result as { status: number; problem: { type: string; detail: string } };
            assert.equal(noSessionResult.status, 409);
            assert.equal(noSessionResult.problem.type, "https://problems.plurnk.xyz/daemon/session/model-session-required");
            assert.equal(noSessionResult.problem.detail, "No model session exists for prompt injection."); // {§operation-results}

            // Start a session; completed inventory ends its loop, leaving the session idle. Wait for the terminal
            // (loop.run does not block) so the session is genuinely idle before we inject.
            await runLoopToTerminal(ws, 3, { prompt: "first" });

            // Inject into the idle session → enqueues a fresh loop, returns immediately.
            const injected = await rpcCall(ws, 4, "loop.inject", { prompt: "BTW, the config is TOML" });
            const result = injected.result as { action: string; loopId: number; modelSessionId: number };
            assert.equal(result.action, "enqueued_new_loop", "idle session → a fresh enqueued loop");
            assert.ok(typeof result.loopId === "number", "returns the loopId");
            assert.ok(typeof result.modelSessionId === "number", "returns the session it spoke into");

            // empty prompt is a contract violation.
            const empty = await rpcCall(ws, 5, "loop.inject", { prompt: "" });
            const emptyResult = empty.result as { status: number; problem: { type: string } };
            assert.equal(emptyResult.status, 400);
            assert.equal(emptyResult.problem.type, "https://problems.plurnk.xyz/daemon/input/prompt-invalid");
        } finally { ws.close(); }
    });
});

test("{§operation-results} run.fork branches the model session into a named session; errors with no session", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("````EDIT (workspace:///x)\nhi\n````\n\n````SEND\ndone\n````", 10), makeMockResponse("````SEND [200]\ndone\n````", 10)] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "fork-test" });

            // No model session yet → nothing to fork.
            const noSession = await rpcCall(ws, 2, "run.fork", {});
            const noSessionResult = noSession.result as { status: number; problem: { type: string; detail: string } };
            assert.equal(noSessionResult.status, 409);
            assert.equal(noSessionResult.problem.type, "https://problems.plurnk.xyz/daemon/session/model-session-required");
            assert.equal(noSessionResult.problem.detail, "No model session exists to fork."); // {§operation-results}

            // A loop builds the model session + its log; forking branches it. Wait for the
            // terminal so the log is settled before the fork copies it.
            await runLoopToTerminal(ws, 3, { prompt: "do a thing" });
            const fork = await rpcCall(ws, 4, "run.fork", {});
            const r = fork.result as { sessionId: number; sessionName: string | null; parentSessionId: number };
            assert.ok(typeof r.sessionId === "number" && typeof r.parentSessionId === "number", "returns new and parent session ids");
            assert.notEqual(r.sessionId, r.parentSessionId, "the fork is a distinct session");
            assert.match(r.sessionName ?? "", /^[a-f0-9]{8}$/, "an unnamed fork gets the ordinary opaque session identity");

            // {§session-scheme} — an explicit branch name is immutable after instantiation.
            const named = await rpcCall(ws, 5, "run.fork", { name: "harvest" });
            assert.equal((named.result as { sessionName: string | null }).sessionName, "harvest", "an explicit name names the branch");

            // Unmintable + taken names are refused up front (sessions.name is UNIQUE per workspace) —
            // mirrors workspace.attach, never falling through to the insert.
            const runtimeName = await rpcCall(ws, 6, "run.fork", { name: "_plurnk" });
            const runtimeNameResult = runtimeName.result as { status: number; problem: { type: string } };
            assert.equal(runtimeNameResult.status, 400);
            assert.equal(runtimeNameResult.problem.type, "https://problems.plurnk.xyz/daemon/session/name-invalid");

            const taken = await rpcCall(ws, 7, "run.fork", { name: "harvest" });
            const takenResult = taken.result as { status: number; problem: { type: string } };
            assert.equal(takenResult.status, 409);
            assert.equal(takenResult.problem.type, "https://problems.plurnk.xyz/daemon/session/name-conflict");

            const empty = await rpcCall(ws, 8, "run.fork", { name: "" });
            const emptyResult = empty.result as { status: number; problem: { type: string } };
            assert.equal(emptyResult.status, 400);
            assert.equal(emptyResult.problem.type, "https://problems.plurnk.xyz/daemon/input/name-invalid");
        } finally { ws.close(); }
    });
});

test("{§turn-source-resources} loop.run streams log/entry notifications during execution", async () => {
    const dsl = "````EDIT (workspace:///x)\nhello\n````\n\n````SEND\ndone\n````";
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse(dsl, 50), makeMockResponse("````SEND [200]\ndone\n````", 0)] });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const logNotifs = subscribeNotifications(ws, "log/entry");
            await rpcCall(ws, 1, "workspace.create", { name: "stream-test" });
            // loop.run returns immediately; wait for the loop to terminate so all its
            // log/entry notifications have fired before we inspect them.
            const terminal = await runLoopToTerminal(ws, 2, { prompt: "test" });

            const captured = logNotifs().filter((event) => (event as { entry?: { loop_id?: unknown } }).entry?.loop_id === terminal.loopId);
            const harness = captured
                .map((event) => (event as { entry: { id: number; op: string | null; origin: string; status_rx: number; attrs: unknown } }).entry)
                .filter((entry) => entry.origin === "_plurnk" && entry.op !== "SEND");
            assert.equal(harness.some(LogEntryProjection.isEmission), false, "`_plurnk` initialization announces no content emission ({§turn-source-resources})");
            const initialization = harness;
            assert.equal(
                captured.some((event) => (event as { entry: { op: string | null } }).entry.op === null),
                false,
                "initialization has no synthetic actionless receipt",
            );
            assert.equal(new Set(initialization.map(({ id }) => id)).size, initialization.length, "initialization rows are ordinary settled operations, not later updates");
            assert.ok(initialization.filter(({ op }) => op === "READ").every(({ status_rx }) => status_rx === 200));
            const authored = captured.filter((event) => {
                const entry = (event as { entry: { op: string | null; origin: string } }).entry;
                return (entry.op === "SEND" && entry.origin === "_plurnk") || entry.origin === "model";
            });
            // {§loop-completion} — the EDIT receipt forces a second turn.
            assert.deepEqual(authored.map((event) => (event as { entry: { op: string } }).entry.op), ["SEND", "EDIT", "SEND", "SEND"], "each authored message and operation streams independently of initialization");
            const prompt = authored[0] as { entry: { op: string; origin: string } };
            assert.equal(prompt.entry.op, "SEND");
            assert.equal(prompt.entry.origin, "_plurnk");
            const first = authored[1] as { entry: { op: string; origin: string } };
            assert.equal(first.entry.op, "EDIT");
            assert.equal(first.entry.origin, "model");
            const firstReply = authored[2] as { entry: { op: string; status_rx: number } };
            assert.equal(firstReply.entry.op, "SEND");
            assert.equal(firstReply.entry.status_rx, 200, "delivery succeeds before the EDIT is observed");
            const observedReply = authored[3] as { entry: { op: string; status_rx: number } };
            assert.equal(observedReply.entry.op, "SEND");
            assert.equal(observedReply.entry.status_rx, 200, "the observation turn's reply is also delivered");
            assert.equal(terminal.finalStatus, 200);
        } finally { ws.close(); }
    });
});

test("{§notifications} loop.run fires loop/terminated notification on completion", async () => {
    const dsl = "````EDIT (workspace:///x)\nbody\n````\n\n````SEND\ndone\n````";
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse(dsl, 50), makeMockResponse("````SEND [200]\ndone\n````", 0)] });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const terminated = subscribeNotifications(ws, "loop/terminated");
            await rpcCall(ws, 1, "workspace.create", { name: "term-test" });
            // loop.run returns immediately (100 accepted); the loop's outcome rides loop/terminated.
            const accept = await rpcCall(ws, 2, "loop.run", { prompt: "test" });
            const ack = accept.result as { loopId: number; status: number };
            assert.equal(ack.status, 100, "loop.run accepts immediately, not the terminal");
            const captured = await waitFor(
                () => terminated() as Array<{ sessionId: number; loopId: number; result: { status: number }; hitMaxTurns: boolean; attributions: string[]; usage: LoopUsage }>,
                (ts) => ts.length >= 1,
            );
            assert.equal(captured.length, 1);
            const params = captured[0];
            assert.ok(params.sessionId > 0, "terminal carries its owning sessionId with the loopId");
            assert.equal(params.loopId, ack.loopId, "terminal coordinate matches the acknowledged loop");
            assert.equal(params.result.status, 200);
            assert.equal(params.hitMaxTurns, false);
            assert.deepEqual(params.attributions, []);
            // {§notifications}: loop/terminated carries the loop's usage totals.
            assert.equal(params.usage.accounting.usage?.outputTokens, 50);
            assert.equal(params.usage.accounting.usage?.outputTokenDetails?.reasoningTokens, 0);
            assert.equal(params.usage.accounting.usage?.inputTokenDetails?.cacheReadTokens, 0);
        } finally { ws.close(); }
    });
});

test("{§engine-rails} loop.run still fires loop/terminated when the loop throws — no client hang", async () => {
    // A loop that ERRORS must STILL broadcast loop/terminated: loop.run only acked 100, so it's the
    // async client's sole outcome channel. One non-terminal turn, then the Mock exhausts — each
    // exhausted call is an invalid response, one provider-response-contract strike ({§engine-rails}
    // Contract Strikes) — three consecutive strike out 500, and the drain must still publish it.
    const dsl = "````EDIT (workspace:///x)\niter\n````\n\n````NOTE\ncontinue\n````";
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse(dsl, 10)] });
    // The failure must reach daemon diagnostics too. Capture stderr around the loop.
    const logged: string[] = [];
    const realErr = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.map((x) => x instanceof Error ? x.stack ?? x.message : String(x)).join(" ")); };

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const terminated = subscribeNotifications(ws, "loop/terminated");
            await rpcCall(ws, 1, "workspace.create", { name: "errored-loop" });
            const accept = await rpcCall(ws, 2, "loop.run", { prompt: "go", maxTurns: 5 });
            assert.equal((accept.result as { status: number }).status, 100, "loop.run accepts immediately (100)");

            const captured = await waitFor(
                () => terminated() as Array<{ result: { status: number }; turnIds: number[]; hitMaxTurns: boolean; loopId: number }>,
                (ts) => ts.length >= 1,
            );
            assert.equal(captured.length, 1, "the errored loop fired loop/terminated — the client is not left hanging");
            assert.equal(captured[0].result.status, 500, "three provider-contract strikes terminate through the rail");
            assert.ok(captured[0].turnIds.length > 0, "every durable turn completed before the failure is accounted for");
            assert.equal(captured[0].hitMaxTurns, false);
            const exact = captured[0].result as { status: number; problem?: { type?: string; detail?: string } };
            assert.match(exact.problem?.type ?? "", /strike-threshold/, "the rail's verdict is the terminal");
            assert.match(exact.problem?.detail ?? "", /consecutive turns failed/, "the verdict names the streak, not one call");
            const loopRow = await _db.test_get_loop_status.get<{ status: number }>({ id: (captured[0] as { loopId: number }).loopId });
            assert.equal(loopRow?.status, 500, "the compact scheduler projection is terminal, never a live 102");
            assert.deepEqual(
                await new LoopLifecycle(_db).result((captured[0] as { loopId: number }).loopId),
                captured[0].result,
                "the durable loop result and emitted product result are identical",
            );
            const turns = await _db.test_list_turns_in_loop.all<{
                status: number;
                packet: string;
            }>({ loop_id: captured[0].loopId });
            const failedTurn = turns.at(-1);
            assert.equal(failedTurn?.status, 502, "the attempted provider turn is closed with the exact failure status");
            const failedPacket = JSON.parse(failedTurn?.packet ?? "{}") as {
                sections?: unknown;
                assistant?: unknown;
            };
            assert.ok(Array.isArray(failedPacket.sections), "the exact request packet survives forensics");
            assert.equal(failedPacket.assistant, undefined, "no empty assistant response is fabricated");
        } finally { ws.close(); }
    });
    console.error = realErr;
    // Contract Strikes: the loop does not throw for provider garbage — it
    // terminates cleanly through the rail, so no drain error is (or should be)
    // logged; the durable per-turn failure rows carry the diagnostics instead.
    assert.equal(logged.some((l) => /drain error/.test(l)), false, "a rail termination is clean — no swallowed-throw diagnostics needed");
});

test("{§operation-results} loop.run without a model selection returns 501", async (t) => {
    const selected = process.env.PLURNK_MODEL;
    delete process.env.PLURNK_MODEL;
    t.after(() => {
        if (selected === undefined) delete process.env.PLURNK_MODEL;
        else process.env.PLURNK_MODEL = selected;
    });
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "no-provider" });
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "anything" });
            const result = response.result as { status: number; problem?: { type?: string; detail?: string } };
            assert.equal(result.status, 501);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/daemon/provider/not-configured");
            assert.equal(result.problem?.detail, "No provider is configured for this session."); // {§operation-results}
        } finally { ws.close(); }
    });
});

test("{§operation-results} loop.run requires non-empty prompt", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "empty-test" });
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "" });
            const result = response.result as { status: number; problem?: { type?: string; detail?: string; field?: string } };
            assert.equal(result.status, 400);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/daemon/input/prompt-invalid");
            assert.equal(result.problem?.detail, "prompt is not a non-empty string."); // {§operation-results}
            assert.equal(result.problem?.field, "prompt");
        } finally { ws.close(); }
    });
});

test("{§tokenomics} loop.run respects maxTurns cap when model emits non-terminal statuses repeatedly", async () => {
    const dsl = "````EDIT (workspace:///x)\niter\n````\n\n````NOTE\ncontinue\n````";
    const responses = Array.from({ length: 5 }, () => makeMockResponse(dsl, 10));
    // Generous context: this test isolates the maxTurns ceiling, so the budget must NOT fire first.
    // At 8192 the 3-turn EDIT accumulation + the foisted docs tips into a 413 before turn 3's cap
    // (base-packet size drifts with grammar/scheme doc growth); the headroom keeps the test on-topic.
    const mock = new Mock({ contextWindow: 32768, responses });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "maxturns-test" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "iterate", maxTurns: 3 });
            assert.equal(result.accepted, 100, "loop.run accepts immediately");
            assert.equal(result.hitMaxTurns, true);
            assert.equal(result.result.status, 429, "max_turns exhausts the turn ceiling → 429");
            assert.equal(result.turnIds?.length, 4, "packetless initialization does not consume the three-model-turn cap");
        } finally { ws.close(); }
    });
});
test("{§methods-workspace-create}: a fresh loop foists one turn-zero READ per path", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("````SEND [200]\ndone\n````", 10)] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const logNotifs = subscribeNotifications(ws, "log/entry");
            await rpcCall(ws, 1, "workspace.create", { name: "openpaths" });
            // Headless workspace: the files needn't exist — what's asserted is that the daemon FOISTS a
            // turn-0 READ for each path (a missing path just surfaces its own 4xx in the log).
            const result = await runLoopToTerminal(ws, 2, { prompt: "look at these", openPaths: ["src/foo.ts", "README.md"] });
            // Bare file targets use scheme=NULL in log metadata even though the addressed
            // entry identity stores scheme='file'; origin plus the nullable target identifies the foists.
            const reads = (logNotifs() as Array<{ entry: { op: string; origin: string; scheme: string | null; pathname: string } }>)
                .map((c) => c.entry)
                .filter((e) => e.op === "READ" && e.origin === "_plurnk" && e.scheme === null);
            assert.deepEqual(reads.map((r) => r.pathname).toSorted(), ["README.md", "src/foo.ts"], "a plurnk-origin file READ foisted per openPath at turn 0 — columns in wire canon ({§fs-namespace})");
            const rows = await db.test_log_entries_by_loop.all<{
                op: string; origin: string; scheme: string | null; pathname: string; turn_id: number;
            }>({ loop_id: result.loopId });
            const frame = rows.find((row) => row.op === "SEND" && row.origin === "_plurnk");
            assert.ok(frame, "the initial message row exists");
            assert.ok(rows.filter((row) => row.op === "READ" && row.origin === "_plurnk" && row.scheme === null)
                .every((row) => row.turn_id === frame.turn_id),
            "every selected path is read in the same turn that publishes the initial message");
        } finally { ws.close(); }
    });
});

test("{§methods-workspace-create}: initial reads preserve file paths, scheme addresses and channels", async () => {
    const mock = new Mock({ contextWindow: 32_768, responses: [makeMockResponse("````SEND [200]\ndone\n````", 10)] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "openpaths-resources" });
            const { id: workspaceId } = created.result as { id: number };
            await seedEntryWithChannel(db, { workspaceId, scheme: "file", pathname: "literal (file).txt", content: "local-file-evidence" });
            await seedEntryWithChannel(db, { workspaceId, pathname: "/reference.txt", content: "scheme-channel-evidence" });
            const result = await runLoopToTerminal(ws, 2, {
                prompt: "Inspect the selected evidence.", openPaths: ["literal (file).txt", "workspace:///reference.txt#body"],
            });
            assert.equal(result.result.status, 200);
            const reads = (await db.test_log_entries_by_loop.all<{
                op: string; origin: string; scheme: string | null; pathname: string; status_rx: number;
            }>({ loop_id: result.loopId })).filter(({ op, origin }) => op === "READ" && origin === "_plurnk");
            assert.ok(reads.some(({ scheme, pathname, status_rx }) => scheme === null && pathname === "literal (file).txt" && status_rx === 200));
            assert.ok(reads.some(({ scheme, pathname, status_rx }) => scheme === "workspace" && pathname === "/reference.txt" && status_rx === 200), JSON.stringify(reads));
            const packet = mock.received[0].map(chatMessageText).join("\n");
            assert.match(packet, /local-file-evidence/u);
            assert.match(packet, /scheme-channel-evidence/u);
        } finally { ws.close(); }
    });
});

// {§methods}: a subscriber failure never propagates into engine control flow.
test("{§methods} a throwing seam subscriber never kills the loop — the transport's failure is its own", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("````SEND [200]\ndone\n````", 10)] });
    const logged: string[] = [];
    const realErr = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    await withDaemon(mock, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            daemon.subscribeToEvents(() => { throw new Error("transport socket died mid-send"); });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            await rpcCall(ws, 1, "workspace.create", { name: "sub-throws" });
            await rpcCall(ws, 2, "loop.run", { prompt: "go" });
            const t = await waitFor(() => terminated() as Array<{ result: { status: number } }>, (ts) => ts.length >= 1, { timeoutMs: 8000 });
            assert.equal(t[0].result.status, 200, "the loop concluded normally through a burst of throwing broadcasts");
        } finally { ws.close(); }
    });
    console.error = realErr;
    assert.ok(logged.some((l) => l.includes("seam subscriber failed")), "every subscriber failure logged loudly — never silent, never fatal");
});
});

describe("Engine.addressed-messages", () => {
const frame = PlurnkParser.frame;

test("{§message-source-scheme} restart retains source text and answered state after both observations are curated", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-message-restart-"));
    const path = join(root, "plurnk.db");
    let db = await openMigrated(path);
    try {
        const workspaceId = await insertWorkspace(db, "retained-message");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Keep this original assignment.");
        const [message] = await db.message_source_resources.all<{ path: string }>({ workspace_id: workspaceId, scheme: "message", target: null });
        const address = message.path;
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 100000, responses: [
            makeRawMockResponse([frame("SEND", "Original answer."), frame("SEND [200]", null)].join("\n\n")),
            makeRawMockResponse([frame("KILL (log:///**/SEND)", null), frame("SEND", "History curated.")].join("\n\n")),
            makeRawMockResponse(frame("SEND [200]", null)),
        ] });
        const answered = await engine.runTurn({ messages: [], provider, workspaceId, sessionId, loopId });
        assert.equal(answered.status, 200);
        const turn = await db.test_get_turn.get<{ sequence: number }>({ id: answered.turnId });
        const original = (await db.test_log_entries_by_turn.all<{ op: string; origin: string; sequence: number }>({ turn_id: answered.turnId }))
            .find(({ op, origin }) => op === "SEND" && origin === "model");
        assert.ok(turn && original);
        const originalLog = `log:///1/${turn.sequence}/${original.sequence}/SEND`;
        const curationLoop = await insertLoop(db, sessionId, 2, "Curate the earlier log.");
        assert.equal((await engine.runTurn({ messages: [], provider, workspaceId, sessionId, loopId: curationLoop })).status, 102);
        assert.equal((await engine.runTurn({ messages: [], provider, workspaceId, sessionId, loopId: curationLoop })).status, 200);
        await db.close();
        db = await openMigrated(path);
        const reopened = new Engine({ db, schemes: new SchemeRegistry() });
        const readingLoop = await insertLoop(db, sessionId, 3, "Inspect the original assignment.");
        const reader = new Mock({ contextWindow: 100000, responses: [makeRawMockResponse([
            frame(`READ (${address}) <1,-1>`, null),
            frame(`READ (${originalLog}) <1,-1>`, null),
        ].join("\n\n"))] });
        const read = await reopened.runTurn({ messages: [], provider: reader, workspaceId, sessionId, loopId: readingLoop });
        assert.deepEqual(read.outcomes.map(({ status }) => status), [200, 404], "the source survives while the curated log remains gone");
        const rows = await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; rx: string; attrs: string }>({ turn_id: read.turnId });
        const retained = rows.find((row) => row.op === "READ" && row.status_rx === 200 && !LogEntryProjection.isEmission(row));
        assert.ok(retained);
        assert.equal(JSON.parse(retained.rx).content, "Keep this original assignment.");
        assert.equal((await db.message_unanswered_count.get({ loop_id: loopId }))?.count, 0, "curation and restart do not revoke the answer");
        const history = await db.message_history.all<{ body: string }>({ workspace_id: workspaceId, session_id: sessionId, loop_id: loopId });
        assert.deepEqual(history.map(({ body }) => body), ["Keep this original assignment.", "Original answer."]);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§message-completion} failed exact delivery does not acknowledge the loop's assignment", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "reply-failure");
    const sessionId = await insertSession(db, workspaceId, null, "alice");
    const loopId = await insertLoop(db, sessionId, 1, "An unanswered assignment.");
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const provider = new Mock({ contextWindow: 100000, responses: [
        makeRawMockResponse(frame("SEND (message://alice/ffffffff)", "Not delivered.")),
        makeRawMockResponse(frame("SEND [200]", "The real answer.")),
    ] });
    const run = () => engine.runTurn({ messages: [], provider, workspaceId, sessionId, loopId });
    const failed = await run();
    assert.equal(failed.status, 102);
    assert.equal(failed.outcomes[0].status, 404);
    const rows = await db.test_log_entries_by_turn.all<{ origin: string; rx: string }>({ turn_id: failed.turnId });
    const row = rows.find(({ origin }) => origin === "model");
    assert.ok(row);
    assert.match(JSON.parse(row.rx).problem.type, /message-not-found$/);
    assert.equal((await db.message_unanswered_count.get({ loop_id: loopId }))?.count, 1);
    assert.equal((await run()).status, 200);
    const history = await db.message_history.all<{ direction: string; body: string }>({ workspace_id: workspaceId, session_id: sessionId, loop_id: loopId });
    assert.deepEqual(history.filter(({ direction }) => direction === "outbound").map(({ body }) => body), ["The real answer."]);
});

for (const delegated of [false, true]) for (const addressed of [false, true]) {
    test(`{§op-methods-op-dispatch} ${delegated ? "child" : "root"} recovers with ${addressed ? "an exact" : "a targetless"} reply`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "entry-send-recovery");
        const parentId = delegated ? await insertSession(db, workspaceId, null, "parent") : null;
        const parentLoop = parentId === null ? null : await insertLoop(db, parentId, 1, "Collect the answer.");
        const sessionId = await insertSession(db, workspaceId, parentId, "responder");
        const loopId = await insertLoop(db, sessionId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        await engine.injectIntoLoop(loopId, "The original request.", [], delegated ? "session://parent" : undefined);
        const requests = await db.message_source_resources.all<{ path: string; body: string }>({ workspace_id: workspaceId, scheme: "message", target: null });
        const request = requests.find(({ body }) => body === "The original request.");
        assert.ok(request);
        const address = request.path;
        const provider = new Mock({ contextWindow: 100000, responses: [
            makeRawMockResponse(frame("SEND (workspace:///_plurnk)", "Answer.")),
            makeRawMockResponse(frame(addressed ? `SEND (${address})` : "SEND", "Recovered answer.")),
            makeRawMockResponse(frame("SEND [200]", null)),
        ] });
        const run = () => engine.runTurn({ messages: [], provider, workspaceId, sessionId, loopId });
        const failed = await run();
        assert.equal(failed.status, 102);
        assert.equal(failed.outcomes[0].status, 501);
        const failedRows = await db.test_log_entries_by_turn.all<{ origin: string; rx: string }>({ turn_id: failed.turnId });
        const problem = JSON.parse(failedRows.find(({ origin }) => origin === "model")!.rx).problem;
        assert.match(problem.type, /message-not-implemented$/);
        assert.equal(problem.detail, "SEND does not deliver messages to workspace entries."); // {§operation-results}
        assert.equal(problem.recovery, "To reply, SEND to an Open Message address or omit the target. SEND (session://<name>) sends a new message."); // {§operation-results}
        assert.equal((await db.message_unanswered_count.get({ loop_id: loopId }))?.count, 1);

        assert.equal((await run()).status, 102, "both reply forms are messaging, not completion");
        assert.equal((await run()).status, 200, "the completion reply resolves the answered task");
        assert.equal((await db.message_unanswered_count.get({ loop_id: loopId }))?.count, 0);
        const history = await db.message_history.all<{ direction: string; body: string }>({ workspace_id: workspaceId, session_id: sessionId, loop_id: loopId });
        assert.deepEqual(history.map(({ direction, body }) => ({ direction, body })), [
            { direction: "inbound", body: "The original request." },
            { direction: "outbound", body: "Recovered answer." },
        ]);
        if (parentId !== null && parentLoop !== null) {
            const observed = await engine.runTurn({
                messages: [], workspaceId, sessionId: parentId, loopId: parentLoop,
                provider: new Mock({ contextWindow: 100000, responses: [makeRawMockResponse(frame("NOTE", "Observed."))] }),
            });
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: observed.turnId }))!.packet);
            // {§message-completion}: the parent hears the answer once, as the child's conclusion, never as a
            // second reply row.
            const delivered = logEntries(packet).filter(({ body }) => String(body).includes("Recovered answer."));
            assert.equal(delivered.length, 1, "the reply reaches the parent exactly once");
            assert.equal(delivered[0].path, "ops://responder/1");
            assert.equal(delivered[0].answers, undefined, "the conclusion is not another answer");
        }
    });
}

test("{§message-source-scheme} one source address identifies one immutable message per workspace", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const address = "acp://operator/threads/shared/messages/m1";
    const workspaces = await Promise.all(["first", "second"].map((name) => insertWorkspace(db, name)));
    for (const workspaceId of workspaces) {
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Initial assignment.");
        const envelope = { loop_id: loopId, source: address, body: "Accepted.", open_paths: "[]", evidence: "{}", address, opened_turn_id: null, opened_sequence: null };
        await db.drain_enqueue_message.get(envelope);
        await assert.rejects(db.drain_enqueue_message.get({ ...envelope, body: "Replacement." }),
            /message address already accepted in this workspace/);
        const retained = await db.message_source_by_address.get<{ body: string }>({ workspace_id: workspaceId, path: address });
        assert.equal(retained?.body, "Accepted.");
        const all = await db.message_source_resources.all({ workspace_id: workspaceId, scheme: "acp", target: address });
        assert.equal(all.length, 1);
    }
});

test("{§message-source-scheme} native message views reject mutations without cancelling their session", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "immutable-message");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Immutable input.");
        const [message] = await db.message_source_resources.all<{ path: string }>({ workspace_id: workspaceId, scheme: "message", target: null });
        const path = message.path;
        const provider = new Mock({ contextWindow: 100000, responses: [makeRawMockResponse([
            frame(`READ (${path}) <1,-1>`, null),
            frame(`EDIT (${path}) <1,-1>`, "Altered."),
            frame(`MOVE (${path}) (workspace:///moved.md)`, null),
            frame(`COPY (${path}) (${path})`, null),
            frame(`KILL (${path})`, null),
        ].join("\n\n"))] });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const turn = await engine.runTurn({ messages: [], provider, workspaceId, sessionId, loopId });
        assert.equal(turn.status, 102);
        assert.deepEqual(turn.outcomes.map(({ op, status }) => [op, status]), [
            ["READ", 200], ["EDIT", 405], ["MOVE", 405], ["COPY", 405], ["KILL", 405],
        ]);
        const rows = await db.test_log_entries_by_turn.all<{ op: string; rx: string }>({ turn_id: turn.turnId });
        for (const row of rows.filter(({ op }) => ["EDIT", "MOVE", "COPY", "KILL"].includes(op))) {
            assert.match(JSON.parse(row.rx).problem.type, /message-immutable$/);
        }
        // {§message-immutable} {§diagnostic-observation} — the refusal says what the message is and offers nothing.
        const kill = JSON.parse(rows.find(({ op }) => op === "KILL")!.rx).problem;
        assert.equal(kill.detail, `\`${path}\` is a received message; it cannot be edited, moved or killed.`);
        assert.equal(kill.recovery, undefined);
        const retained = await db.message_source_by_address.get<{ body: string }>({ workspace_id: workspaceId, path });
        assert.equal(retained!.body, "Immutable input.");
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))!.status, 102);
    } finally { await db.close(); }
});

for (const scope of ["", " <1,-1>"]) test(`{§message-arrival} curation${scope} preserves the native source; exact replies answer only their addressee`, async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "addressed-sources");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "First assignment.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        await engine.injectIntoLoop(loopId, "Second assignment.");
        const messages = await db.message_source_resources.all<{ path: string; body: string }>({
            workspace_id: workspaceId, scheme: "message", target: null,
        });
        const first = messages.find(({ body }) => body === "First assignment.")!.path;
        const second = messages.find(({ body }) => body === "Second assignment.")!.path;
        assert.match(first, /^message:\/\/alice\/[a-f0-9]{8}$/);
        const provider = new Mock({ contextWindow: 100000, responses: [
            makeRawMockResponse([
                frame(`KILL (log:///**/SEND)${scope}`, null),
                frame(`READ (${first}) <1,-1>`, null),
                frame(`COPY (${first}) (workspace:///copy.md)`, null),
                frame(`SEND (${first}) [200]`, "First answer."),
            ].join("\n\n")),
            makeRawMockResponse(frame("NOTE", "Observed the source and copy.")),
            makeRawMockResponse(frame(`SEND (${second}) [200]`, "Second answer.")),
        ] });
        const run = () => engine.runTurn({ messages: [], provider, workspaceId, sessionId, loopId });
        const one = await run();
        assert.equal(one.status, 102, "resource results require observation despite the reply");
        const initial = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: one.turnId }))!.packet);
        const initialLog = packetSection(initial, "log");
        for (const address of [first, second]) {
            assert.ok(initialLog.includes(`"resource":"${address}"`), "each arrival identifies its immutable Open Message source");
        }
        assert.deepEqual(one.outcomes.map(({ op, status }) => [op, status]), [
            ["KILL", 200], ["READ", 200], ["COPY", 201], ["SEND", 200],
        ]);
        const rows = await db.test_log_entries_by_turn.all<{ op: string; rx: string; attrs: string }>({ turn_id: one.turnId });
        assert.equal(JSON.parse(rows.find((row) => row.op === "READ" && !LogEntryProjection.isEmission(row))!.rx).content, "First assignment.");
        const two = await run();
        assert.equal(two.status, 102, "one addressed answer cannot conclude over the second assignment");
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: two.turnId }))!.packet);
        assert.match(packetSection(packet, "messages"), new RegExp(second.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.ok(!packetSection(packet, "messages").includes(first));
        assert.equal((await run()).status, 200, "the last completion reply discharges the remaining obligation");
        assert.equal((await db.message_unanswered_count.get<{ count: number }>({ loop_id: loopId }))!.count, 0);
    } finally { await db.close(); }
});

test("{§message-arrival} a targetless reply cannot acknowledge an arrival during inference", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "message-race");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Observed assignment.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 100000, responses: [
            makeRawMockResponse(frame("SEND [200]", "Answer to the observed assignment.")),
            makeRawMockResponse(frame("SEND [200]", "Answer to the later arrival.")),
        ] });
        const generate = provider.generate.bind(provider);
        let injected = false;
        provider.generate = async (args) => {
            if (!injected) {
                injected = true;
                await engine.injectIntoLoop(loopId, "Arrived during inference.");
            }
            return generate(args);
        };
        assert.equal((await engine.runTurn({ messages: [], provider, workspaceId, sessionId, loopId })).status, 102);
        assert.equal((await db.message_unanswered_count.get<{ count: number }>({ loop_id: loopId }))!.count, 1);
        assert.equal((await engine.runTurn({ messages: [], provider, workspaceId, sessionId, loopId })).status, 200);
    } finally { await db.close(); }
});

for (const child of [false, true]) test(`{§message-arrival} ${child ? "child" : "peer"} answers are visible once, not new requests`, async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `native-reply-${child}`);
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const peerId = await insertSession(db, workspaceId, child ? sessionId : null, "bob");
        const loopId = await insertLoop(db, sessionId, 1, "Summarize Bob's answer.");
        const peerLoop = await insertLoop(db, peerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        await engine.injectIntoLoop(peerLoop, "What did you find?", [], "session://alice", {}, undefined, await sendingOperation(db, loopId));
        const note = new Mock({ contextWindow: 100000, responses: [makeRawMockResponse(frame("NOTE", "Awaiting Bob."))] });
        assert.equal((await engine.runTurn({ messages: [], provider: note, workspaceId, sessionId, loopId })).status, 102);
        const answer = new Mock({ contextWindow: 100000, responses: [makeRawMockResponse(frame("SEND [200]", "Distinct answer from Bob."))] });
        assert.equal((await engine.runTurn({ messages: [], provider: answer, workspaceId, sessionId: peerId, loopId: peerLoop })).status, 200);
        const observed = new Mock({ contextWindow: 100000, responses: [makeRawMockResponse(frame("SEND [200]", "Bob's result is confirmed."))] });
        const completed = await engine.runTurn({ messages: [], provider: observed, workspaceId, sessionId, loopId });
        assert.equal(completed.status, 200);
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: completed.turnId }))!.packet);
        const replies = logEntries(packet).filter(({ body }) => String(body).includes("Distinct answer from Bob."));
        if (child) {
            // {§message-completion}: a child's answer to its parent's own task arrives once, as its conclusion.
            assert.equal(replies.length, 1, "once, not twice");
            assert.equal(replies[0].path, "ops://bob/1");
            assert.equal(replies[0].answers, undefined, "the conclusion is not another answer");
            return;
        }
        assert.equal(replies.length, 1, "one reply, not repeated as activity and terminal deliverable");
        assert.equal(replies[0].source, "session://bob");
        const answers = replies[0].answers;
        assert.ok(Array.isArray(answers), "the parent packet names answered messages as answers");
        assert.equal(answers.length, 1);
        const answered = await db.message_source_by_address.get<{ body: string; source: string }>({
            workspace_id: workspaceId, path: answers[0],
        });
        assert.equal(answered?.body, "What did you find?", "answers identifies the original request, not its recipient actor");
        assert.equal(answered?.source, "session://alice");
        assert.equal(Object.hasOwn(replies[0], "recipients"), false);
        const inbox = await db.test_messages_by_loop.all({ loop_id: loopId });
        assert.equal(inbox.length, 1, "reply never becomes a request to reply back to Bob");
    } finally { await db.close(); }
});

test("{§message-arrival} another session's addressed answer reaches both the sender and the assigned session", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "third-session-reply");
        const senderId = await insertSession(db, workspaceId, null, "alice");
        const ownerId = await insertSession(db, workspaceId, null, "bob");
        const responderId = await insertSession(db, workspaceId, null, "charlie");
        const senderLoop = await insertLoop(db, senderId, 1, "Collect the answer.");
        const ownerLoop = await insertLoop(db, ownerId, 1);
        const responderLoop = await insertLoop(db, responderId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        await engine.injectIntoLoop(ownerLoop, "A shared assignment.", [], "session://alice", {}, undefined, await sendingOperation(db, senderLoop));
        const messages = await db.message_source_resources.all<{ path: string; body: string }>({ workspace_id: workspaceId, scheme: "message", target: null });
        const path = messages.find(({ body }) => body === "A shared assignment.")!.path;
        const run = (sessionId: number, loopId: number, program: string) => engine.runTurn({
            messages: [], workspaceId, sessionId, loopId,
            provider: new Mock({ contextWindow: 100000, responses: [makeRawMockResponse(program)] }),
        });
        await run(senderId, senderLoop, frame("NOTE", "Waiting for the answer."));
        await run(ownerId, ownerLoop, frame("NOTE", "Reviewing the assignment."));
        assert.equal((await run(responderId, responderLoop, frame(`SEND (${path}) [200]`, "Charlie's answer."))).status, 200, "the responder has no remaining obligations");
        const history = await db.message_history.all<{ direction: string; body: string }>({ workspace_id: workspaceId, session_id: ownerId, loop_id: ownerLoop });
        assert.deepEqual(history.filter(({ direction }) => direction === "outbound").map(({ body }) => body), ["Charlie's answer."]);
        const completed = await run(ownerId, ownerLoop, "");
        assert.equal(completed.status, 200);
        const result = await db.lifecycle_loop_status.get<{ terminal_result: string }>({ loop_id: ownerLoop });
        assert.equal(JSON.parse(result!.terminal_result).content, undefined, "the answer remains a message, not an execution outcome");
        const observed = await run(senderId, senderLoop, frame("SEND", "Answer collected."));
        for (const turn of [completed, observed]) {
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turn.turnId }))!.packet);
            const replies = logEntries(packet).filter(({ body }) => String(body).includes("Charlie's answer."));
            assert.equal(replies.length, 1);
        }
    } finally { await db.close(); }
});
});

describe("arrival-fold", () => {
type LogRow = { origin: string; op: string; pathname: string; scheme: string; folded: string; turn_id: number };
const mock = () => new Mock({ contextWindow: viableWindow(), responses: [makeMockResponse("````SEND [200]\ndone\n````", 50)] });

test("{§message-arrival} the arrival row and a normal same-turn op are both born open", async () => {
    await withDaemon(mock(), async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "prompt-fold" });
            const resp = await runLoopToTerminal(ws, 2, { prompt: "hello there" });
            const { loopId } = resp as { loopId: number };
            const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
            const prompt = rows.find((r) => r.op === "SEND" && r.origin === "_plurnk");
            assert.ok(prompt !== undefined, "the message is logged once as an inbound SEND row");
            assert.equal(prompt.folded, "[]", "new message delivery is visible");
            const send = rows.find((r) => r.op === "SEND" && r.origin === "model" && r.turn_id === prompt.turn_id);
            assert.ok(send !== undefined, "the model's own op shares the turn");
            assert.equal(send.folded, "[]", "a normal op in the same turn stays visible");
        } finally { ws.close(); }
    });
});
});

describe("arrival-preview", () => {
const mock = (): Mock => new Mock({ contextWindow: 100000, responses: [makeMockResponse("````SEND [200]\ndone\n````", 40)] });

type LogRow = { op: string; origin: string; scheme: string | null; pathname: string | null; lineMarker: string | null; tx: string | null; rx: string | null; status_rx: number };

test("{§tokenomics} a short message lands as one inbound SEND row", async () => {
    await withDaemon(mock(), async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "par-short" });
            const resp = await runLoopToTerminal(ws, 2, { prompt: "three\nshort\nlines" });
            const { loopId } = resp as { loopId: number };
            const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
            const prompt = rows.find((r) => r.op === "SEND" && r.origin === "_plurnk");
            assert.ok(prompt, "the arrival row exists");
            assert.equal(prompt.lineMarker, null, "message delivery is not a synthetic scoped retrieval");
            assert.match(prompt.tx ?? "", /three/, "the complete durable body belongs to the arrival row's sent side");
            assert.equal(rows.filter((r) => r.op === "SEND" && r.origin === "_plurnk").length, 1, "initialization does not duplicate message delivery");
        } finally { ws.close(); }
    });
});

test("{§tokenomics}: a jumbo message lands folded with its size; Open Messages points to its complete log body", async () => {
    await withDaemon(mock(), async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "par-long" });
            const fat = Array.from({ length: 4_000 }, (_, i) => `prompt line ${i + 1}: ${"x".repeat(72)}`).join("\n");
            const resp = await runLoopToTerminal(ws, 2, { prompt: fat });
            const { loopId, turnIds } = resp as { loopId: number; turnIds: number[] };
            const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
            const prompt = rows.find((r) => r.op === "SEND" && r.origin === "_plurnk");
            assert.ok(prompt, "the arrival row exists");
            const row = await db.test_get_packet.get<{ packet: string }>({ id: turnIds[turnIds.length - 1] });
            const packet = JSON.parse(row!.packet) as { weight: number; sections?: Array<{ name: string; slot: string; header: string | null; content: string }> };
            const log = packetSection(packet, "log");
            const promptSection = (packet.sections ?? []).find((sec) => sec.name === "messages");
            assert.doesNotMatch(log, /prompt line 1:/, "a body that does not fit is not shown in part");
            const projectedPrompt = logEntries(packet).find((entry) => typeof entry.logPath === "string" && entry.logPath.endsWith("/SEND"));
            assert.ok(projectedPrompt, "the arrival row is in the packet");
            assert.equal(projectedPrompt.body, undefined, "folded: the row is its size and its address");
            assert.equal(projectedPrompt.preview, undefined, "nothing is previewed on the model's behalf");
            const size = projectedPrompt.size as { lines: number; tokens: number };
            assert.equal(size.lines, 4000, "the size names the lines the model can READ");
            const budgetSection = (packet.sections ?? []).find((sec) => sec.name === "budget")?.content ?? "";
            const budget = Number(/"budget":\s*(\d+)/.exec(budgetSection)?.[1]);
            assert.ok(Number.isFinite(budget) && size.tokens > budget - packet.weight, "it did not fit the remaining budget");
            assert.ok(packet.weight <= budget, "the packet itself fits");
            const bodyTarget = typeof projectedPrompt.logPath === "string" ? projectedPrompt.logPath : undefined;
            assert.match(bodyTarget ?? "", /^log:\/\/\/1\/2\/\d+\/SEND$/, "the message body is addressed in the first packet-bearing turn");
            const session = await db.test_get_session_id_by_loop.get<{ session_id: number }>({ loop_id: loopId });
            assert.ok(session, "the model session exists");
            const [workspace] = await daemon.listWorkspaces();
            assert.ok(workspace, "the model workspace exists");
            const recovered = await readLog(
                readStmt(urlPath("log", new URL(bodyTarget!).pathname), { marks: [1, -1] }),
                makeSchemeCtx({ db, workspaceId: workspace.id, sessionId: session.session_id, mimetypes: DEFAULT_MIMETYPES }),
            );
            assert.equal(recovered.status, 200);
            assert.equal(recovered.content, fat, "the advertised log READ returns the exact canonical prompt body");
            assert.ok(promptSection, "the messages section exists");
            assert.equal(promptSection.slot, "user", "the open-message pointers close the user-slot status clump");
            assert.equal(promptSection.header, "Open Messages");
            assert.match(promptSection.content, /^\[\{"path":"message:\/\/[^/]+\/[0-9a-f]{8}","origin":"user"\}\]$/, "an immutable message address, named as the operator's own request");
            assert.doesNotMatch(promptSection.content, /prompt line 5/, "no bodies in the section");
        } finally { ws.close(); }
    });
});

test("{§message-arrival}: the operator's message is named for the model; every other sender shows its address", () => {
    const countTokens = (s: string): number => Math.ceil(s.length / 4);
    const arrival = (coordinate: string, source: string | null, selfAddressed = false) => ({
        coordinate, origin: "_plurnk", op: "SEND", source, target: null, status: 200,
        tx: { body: "Replace the second line." }, rx: { status: 200, resource: `message://w/${coordinate.at(-1)}` },
        folded: [], attrs: { kind: "message", ...(selfAddressed ? { selfAddressed } : {}) },
    });
    const records = parseLogRecords(PacketWire.renderLog([
        arrival("1/2/1", null),
        arrival("1/2/2", "acp://operator/threads/t/messages/m", true),
        arrival("1/2/3", "session://peer"),
    ], countTokens));
    assert.deepEqual(records.map(({ origin, source }) => ({ origin, source })), [
        { origin: "user", source: undefined },
        { origin: "user", source: undefined },
        { origin: undefined, source: "session://peer" },
    ], "left bare, the operator's row reads as the model's own SEND");
});

test("{§packet}: a peer session's deliverable renders as its first page with the page of the whole named; the character bound cuts a single line exactly", () => {
    const countTokens = (s: string): number => Math.ceil(s.length / 4);
    const lines = Number(process.env.PLURNK_SERVICE_PREVIEW_LINES);
    const chars = Number(process.env.PLURNK_SERVICE_PREVIEW_CHARS);
    const bomb = Array.from({ length: 400 }, (_, i) => `deranged output line ${i + 1}`).join("\n");
    const row = {
        coordinate: "1/2/1", origin: "_plurnk", op: "SEND", source: "session://comparison-checker",
        target: { scheme: "workspace", username: null, password: null, hostname: null, port: null, pathname: "/comparison-checker", query: null, fragment: null },
        status: 200, rx: bomb, mimetype_rx: "text/markdown", tx: { body: "" }, folded: [], attrs: { kind: "message" },
    };
    const rendered = PacketWire.renderLog([row], countTokens);
    const [projected] = parseLogRecords(rendered);
    assert.match(String(projected?.body), /^ *1:deranged output line 1/m, "the first line is visible");
    assert.doesNotMatch(String(projected?.body), new RegExp(`deranged output line ${lines + 1}$`, "m"), "the page ends where the bound says");
    assert.equal(projected?.preview, `<1,${lines}> of 400 lines`, "{§log-wire-format}: the page of the whole, in the one notation");
    assert.equal(projected?.lines, undefined, "the preview fact replaces the redundant line count");
    const oneLine = PacketWire.renderLog([{ ...row, rx: "x".repeat(20_000) }], countTokens);
    const [single] = parseLogRecords(oneLine);
    assert.equal((String(single?.body).match(/x+/g) ?? []).reduce((n, m) => Math.max(n, m.length), 0), chars, "the character bound cuts a single line");
    assert.equal(single?.preview, `<1,1,1,${chars + 1}> of <1,1,1,20001>`, "the in-line cut is exact and addressable");
});

test("{§packet}: the operator's message and the model's own rows are never paged", () => {
    const countTokens = (s: string): number => Math.ceil(s.length / 4);
    const bomb = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join("\n");
    const target = { scheme: "workspace", username: null, password: null, hostname: null, port: null, pathname: "/x", query: null, fragment: null };
    const prompt = { coordinate: "1/2/1", origin: "_plurnk", op: "SEND", source: "acp://operator/threads/t/messages/m", target, status: 200, rx: bomb, mimetype_rx: "text/markdown", tx: { body: "" }, folded: [], attrs: { kind: "message" } };
    const note = { coordinate: "1/3/1", origin: "model", op: "NOTE", source: null, target: null, status: 200, rx: JSON.stringify({ status: 200 }), mimetype_rx: "application/json", tx: { op: "NOTE", body: bomb }, mimetype_tx: "application/json", folded: [], attrs: {} };
    for (const [row, who] of [[prompt, "the operator's message keeps its own rule"], [note, "a NOTE the model wrote stands whole"]] as const) {
        const [projected] = parseLogRecords(PacketWire.renderLog([row], countTokens));
        assert.match(String(projected?.body), /line 400$/m, who);
        assert.equal(projected?.preview, undefined, who);
    }
});

test("{§tokenomics} a small deliverable rides whole — whole-when-small is the common case, untouched", () => {
    const countTokens = (s: string): number => Math.ceil(s.length / 4);
    const row = {
        coordinate: "1/2/1", origin: "_plurnk", op: "SEND", source: "session://tidy",
        target: { scheme: "workspace", username: null, password: null, hostname: null, port: null, pathname: "/tidy", query: null, fragment: null },
        status: 200, rx: "answer: 42\nnotes: none", mimetype_rx: "text/markdown", tx: { body: "" }, folded: [], attrs: null,
    };
    const rendered = PacketWire.renderLog([row], countTokens);
    assert.ok(rendered.includes("answer: 42") && rendered.includes("notes: none"), "the whole deliverable rides");
    assert.ok(!rendered.includes("\"preview\""), "an in-bounds body has no preview extent");
});

test("{§tokenomics}: a single-line jumbo prompt lands folded with its size, and its body stays READable", async () => {
    await withDaemon(mock(), async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "par-bomb" });
            const bomb = `find the needle: ${"hay ".repeat(50_000)}needle`;
            const resp = await runLoopToTerminal(ws, 2, { prompt: bomb });
            const { turnIds } = resp as { loopId: number; turnIds: number[] };
            const row = await db.test_get_packet.get<{ packet: string }>({ id: turnIds.at(-1)! });
            const packet = JSON.parse(row!.packet) as { sections?: Array<{ name: string; content: string }> };
            const log = packetSection(packet, "log");
            assert.doesNotMatch(log, /hay hay/u, "the jumbo line is not stuffed into the packet, nor cut into it");
            const arrival = logEntries(packet).find((entry) => typeof entry.logPath === "string" && entry.logPath.endsWith("/SEND"));
            assert.ok(arrival);
            assert.deepEqual(Object.keys(arrival.size as object).toSorted(), ["lines", "tokens"], "the row states its size");
            assert.equal((arrival.size as { lines: number }).lines, 1);
            assert.equal(arrival.preview, undefined);
        } finally { ws.close(); }
    });
});
});

describe("child-completion-observation", () => {
const frame = (op: string, body = "") => `\`\`\`\`${op}\n${body}\n\`\`\`\``;

const fixture = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "completion-observation");
    const parent = await insertSession(db, workspaceId, null, "parent");
    const parentLoop = await insertLoop(db, parent, 1, "Collect the child's answer.");
    const child = await insertSession(db, workspaceId, parent, "child");
    const childLoop = await insertLoop(db, child, 1);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const lifecycle = new LoopLifecycle(db);
    const run = async (sessionId: number, loopId: number, content = frame("NOTE", "Observed.")) => {
        const result = await engine.runTurn({
            messages: [], workspaceId, sessionId, loopId,
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content, reasoning: null } }] }),
        });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet);
        return { result, packet, entries: logEntries(packet) };
    };
    return { db, workspaceId, parent, parentLoop, child, childLoop, engine, lifecycle, run };
};

for (const outcome of ["success", "failure", "cancel"] as const) {
    test(`{§message-completion}: the parent receives ${outcome} once, as the child's own loop answer`, async (t) => {
        const f = await fixture();
        t.after(() => f.db.close());
        await f.engine.injectIntoLoop(f.childLoop, "What did you find?", [], "session://parent", {}, undefined, await sendingOperation(f.db, f.parentLoop));
        await f.run(f.child, f.childLoop, frame("SEND", "The answer is 42.") + "\n\n" + frame("FIND (*)"));
        const before = await f.run(f.parent, f.parentLoop);
        assert.deepEqual(before.entries.filter(({ answers }) => Array.isArray(answers)), [],
            "the answer to the parent's own task is not delivered twice: it arrives with the conclusion");
        assert.equal(before.entries.filter(({ path: target }) => target === "ops://child/1").length, 0, "an answer before the conclusion implies no completion");

        const result = outcome === "success"
            ? { status: 200 }
            : Results.failure("test:child", outcome, outcome === "cancel" ? 499 : 502, "The child could not finish.");
        const exact = await f.lifecycle.finish(f.childLoop, result, { terminatedBy: outcome === "cancel" ? "cancel" : null });
        assert.ok(exact);
        const after = await f.run(f.parent, f.parentLoop);
        const observations = after.entries.filter(({ source }) => source === "session://child");
        assert.deepEqual(observations.map(({ logPath: path }) => path.split("/").at(-1)), ["READ"]);
        const completion = observations[0];
        assert.equal(completion.path, "ops://child/1");
        assert.equal(completion.origin, "_plurnk");
        assert.equal(completion.answers, undefined, "observation is not another answer");
        if (outcome === "success") {
            assert.match(String(completion.body), /The answer is 42\./, "the conclusion carries what the child said");
        } else {
            assert.equal(completion.status, exact.status);
            assert.match(JSON.stringify(completion), /The child could not finish\./);
            assert.ok(String(completion.body).length > 0, "a failure stays visible even after an answer was written");
            if (outcome === "cancel") assert.match(String(completion.body), /session cancelled/);
        }
        const history = await f.db.message_history.all<{ direction: string; body: string }>({ workspace_id: f.workspaceId, session_id: f.child, loop_id: f.childLoop });
        assert.deepEqual(history.filter(({ direction }) => direction === "outbound").map(({ body }) => body), ["The answer is 42."], "the reply is still the child's own outbound message");
    });
}

test("{§env-delta}: delayed observation preserves each completed loop after newer work starts", async (t) => {
    const f = await fixture();
    t.after(() => f.db.close());
    const first = Array.from({ length: 24 }, (_, i) => `First result line ${i + 1}`).join("\n");
    await insertTurn(f.db, f.childLoop, 1);
    assert.ok(await f.lifecycle.finish(f.childLoop, { status: 200, content: first, mimetype: "text/plain" }));
    const secondLoop = await insertLoop(f.db, f.child, 2);
    await insertTurn(f.db, secondLoop, 1);
    const failure = await f.lifecycle.finish(secondLoop, Results.failure("test:child", "second-loop-failed", 502, "Second loop failed."));
    assert.ok(failure);
    const thirdLoop = await insertLoop(f.db, f.child, 3, "Still running.");
    assert.equal(await f.lifecycle.status(thirdLoop), 102);

    const observed = await f.run(f.parent, f.parentLoop);
    const completions = observed.entries.filter(({ path: target }) => String(target).startsWith("ops://child/"));
    assert.equal(completions.length, 2);
    assert.ok(completions.every(({ logPath: path }) => path.endsWith("/READ")));
    assert.deepEqual(completions.map(({ path: target }) => target), ["ops://child/1", "ops://child/2"]);
    assert.match(String(completions[0].body), /First result line 1\n/);
    assert.match(String(completions[0].body), /First result line 24/, "automatic observation is a markerless READ: whole when it fits ({§tokenomics})");
    assert.equal(completions[0].preview, undefined, "nothing is previewed on the model's behalf");
    assert.match(String(completions[1].body), /Second loop failed\./);
    assert.equal(completions[1].status, 502);
    assert.equal((await f.db.engine_session_has_undelivered_child_term.get({ session_id: f.parent })), undefined);

    const curated = await f.run(f.parent, f.parentLoop,
        frame(`READ (${String(completions[0].path)}) <1,-1>`) + "\n\n"
        + frame(`KILL (${completions[0].logPath}) <2,-1>`));
    const rows = await f.db.test_log_entries_by_loop.all<{ turn_id: number; op: string; status_rx: number; rx: string; attrs: string }>({ loop_id: f.parentLoop });
    const actions = rows.filter((row) => row.turn_id === curated.result.turnId && !LogEntryProjection.isEmission(row));
    assert.deepEqual(actions.map(({ op, status_rx }) => [op, status_rx]), [["READ", 200], ["KILL", 200]]);
    assert.equal(JSON.parse(actions[0].rx).content, first, "source READ recovers the exact original result, never the current session loop");
    assert.equal((await f.lifecycle.result(f.childLoop))?.content, first, "curation never changes the producer's result");
    assert.deepEqual((await f.lifecycle.result(secondLoop))?.problem, failure.problem);
    const again = await f.run(f.parent, f.parentLoop);
    assert.equal(again.entries.filter(({ source, path }) => source === "session://child" && String(path).startsWith("ops://child/")).length, 2, "observing again creates no duplicate occurrences");
});
});

describe("session-send-scope", () => {
test("{§op-shapes}: a scoped session SEND is refused and admits no task", async () => {
    const provider = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("````SEND (session://scheduler) <0,60>\nUnadmitted scheduled instruction.\n````\n````NOTE\nInspect the refusal.\n````"),
        makeMockResponse("````SEND [200]\nThe scope was refused.\n````"),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "send-scope" });
        const sessionId = (await daemon.createSession({ workspaceId, name: "scheduler" })).sessionId;
        try {
            const initial = await daemon.runLoop({ workspaceId, sessionId, prompt: "Send yourself a scoped message." });
            await waitForDb(() => db.test_get_loop_status.get({ id: initial.loopId }), (row) => row?.status === 200);
            const receipts = await db.test_log_entries_by_loop.all<{ op: string; rx: string }>({ loop_id: initial.loopId });
            const refusal = receipts.map(({ rx }) => JSON.parse(rx)).find((rx) => rx.problem?.type.endsWith("/scope-unsupported"));
            assert.equal(refusal?.status, 400);
            assert.equal(refusal.problem.detail, "A session SEND takes no scope."); // {§operation-results}
            assert.deepEqual((await daemon.listSessionLoops({ workspaceId, sessionId }))
                .filter(({ prompt }) => prompt !== "").map(({ id }) => id), [initial.loopId], "the scoped SEND admitted no task");
            assert.equal(provider.received.length, 2);
        } finally { await daemon.cancelSession({ workspaceId, sessionId }); }
    });
});
});

describe("wait-projection", () => {
for (const [header, warning] of [
    ["WAIT 15", "`WAIT` body text was on the OP line and was taken as the body"],
    ["WAIT <10s>", "Ignored WAIT duration <10s>."],
] as const) {
    test(`{§operation-results} ${header} feedback survives parking, reaches only its loop, and drains once`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "wait-feedback");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Observe the child result.");
        const childLoopId = await holdChild(db, workspaceId, sessionId);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const lifecycle = new LoopLifecycle(db);
        const provider = new Mock({ contextWindow: 100_000, responses: [header, "WAIT [0.25]", "WAIT", "SEND [200]"].map((line) => ({
            assistant: { content: PlurnkParser.frame(line, null), reasoning: null },
        })) });
        const run = () => engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [] });
        const packet = async (turnId: number) => JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turnId }))!.packet);
        const resume = async () => {
            assert.equal(await lifecycle.wake(loopId), true);
            assert.equal((await db.drain_claim_next_loop.get({ session_id: sessionId }))?.id, loopId);
            return run();
        };

        assert.equal((await run()).result.status, 202);
        const siblingId = await insertSession(db, workspaceId);
        const siblingLoop = await insertLoop(db, siblingId, 1, "Finish this independent task.");
        const sibling = await engine.runLoop({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: PlurnkParser.frame("SEND [200]", null), reasoning: null } }] }),
            workspaceId, sessionId: siblingId, loopId: siblingLoop, messages: [],
        });
        assert.equal(sibling.result.status, 200);
        assert.equal(packetSection(await packet(sibling.turnIds.at(-1)!), "notices"), "", "another loop neither consumes nor receives the warning");

        const resumed = await resume();
        assert.equal(resumed.result.status, 202);
        const resumedPacket = await packet(resumed.turnIds.at(-1)!);
        const notices = packetSection(resumedPacket, "notices");
        assert.ok(notices.includes(`> YOU SHOULD write the canonical form. ${warning}`), notices); // {§operation-results}
        assert.equal(notices.match(/\[parse_advisory\]/gu)?.length, 1);
        const wait = logEntries(resumedPacket).find(({ logPath }) => logPath.endsWith("/WAIT"));
        assert.equal(wait?.waitSeconds, 300, "a duration was not supplied; the configured bound applies");
        if (header === "WAIT 15") assert.ok(packetSection(resumedPacket, "emission-history").includes(PlurnkParser.frame("WAIT", "15")), "the authored prose is retained in its operation");

        const next = await resume();
        assert.equal(next.result.status, 202);
        assert.doesNotMatch(packetSection(await packet(next.turnIds.at(-1)!), "notices"), /\[parse_advisory\]/u,
            "the warning drains on the first resumed packet only");
        await lifecycle.finish(childLoopId, { status: 200 });
        assert.equal((await resume()).result.status, 200);
    });
}

for (const headers of [["WAIT [0]"], ["WAIT [600]", "WAIT [0]"], ["WAIT [0]", "WAIT"]]) {
    test(`{§session-wait-timing} ${headers.join(" + ")} continues silently without parking or cancelling live work`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "zero-wait");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const childLoopId = await holdChild(db, workspaceId, sessionId);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const lifecycle = new LoopLifecycle(db);
        const run = (source: string) => engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: source, reasoning: null } }] }),
            workspaceId, sessionId, loopId, messages: [],
        });
        const result = await run([...headers.map((header) => PlurnkParser.frame(header, null)), PlurnkParser.frame("NOTE", "The child is still running.")].join("\n\n"));
        assert.equal(result.status, 102);
        assert.equal(await lifecycle.status(loopId), 102);
        assert.deepEqual(await lifecycle.parked(sessionId), [], "zero creates no parked wait or timer");
        assert.equal(await lifecycle.status(childLoopId), 102, "the child keeps running");
        assert.ok(result.outcomes.some(({ op, status }) => op === "NOTE" && status === 200), "the sibling operation executed");
        const next = await run(PlurnkParser.frame("WAIT", null));
        assert.equal(next.status, 202, "the zero bound does not leak into a later WAIT");
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: next.turnId }))!.packet);
        assert.equal(packetSection(packet, "notices"), "", "zero earns no correction");
        const zero = logEntries(packet).find((entry) => entry.logPath.endsWith("/WAIT") && entry.waitSeconds === 0);
        assert.ok(zero, "the no-wait receipt records the accepted zero");
        assert.equal(zero.status, 102);
    });
}

for (const [headers, seconds] of [
    [["WAIT"], 300],
    [["WAIT [600]"], 600],
    [["WAIT (session://missing) [0.25]"], 0.25],
    [["WAIT [0.0001]"], 0.0001],
    [["WAIT [600]", "WAIT [120]"], 120],
    [["WAIT [600]", "WAIT"], 300],
    [["SEND [200]"], 300],
] as const) {
    test(`{§session-wait-timing} ${headers.join(" + ")} bounds the child-only park to ${seconds} seconds`, async (t) => {
        t.mock.method(Date, "now", () => 10_000);
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "bounded-child-wait");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Observe the child result.");
        const childLoopId = await holdChild(db, workspaceId, sessionId);
        const result = await new Engine({ db, schemes: new SchemeRegistry() }).runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: {
                content: headers.map((header) => PlurnkParser.frame(header, null)).join("\n\n"), reasoning: null,
            } }] }),
            workspaceId, sessionId, loopId, messages: [],
        });
        assert.equal(result.status, 202);
        const lifecycle = new LoopLifecycle(db);
        const [parked] = await lifecycle.parked(sessionId);
        assert.equal(parked?.wait_poll_at, Math.ceil(10_000 + seconds * 1000));
        assert.equal(await lifecycle.wake(loopId, { revision: parked.wait_revision, dueAt: parked.wait_poll_at }), true);
        assert.equal(await lifecycle.status(loopId), 100, "expiry queues the same loop");
        assert.equal(await lifecycle.status(childLoopId), 102, "expiry does not cancel or conclude the child");
        assert.equal(await lifecycle.result(loopId), null);
        assert.equal(await lifecycle.result(childLoopId), null);
    });
}

test("{§session-wait-timing} an early wake retires the override; a later bare WAIT uses the configured default", async (t) => {
    let now = 10_000;
    t.mock.method(Date, "now", () => now);
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "one-park-override");
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1);
    await holdChild(db, workspaceId, sessionId);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const lifecycle = new LoopLifecycle(db);
    const run = (header: string) => engine.runTurn({
        provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: PlurnkParser.frame(header, null), reasoning: null } }] }),
        workspaceId, sessionId, loopId, messages: [],
    });
    assert.equal((await run("WAIT [600]")).status, 202);
    const [first] = await lifecycle.parked(sessionId);
    assert.equal(first?.wait_poll_at, 610_000);
    now += 1000;
    assert.equal(await lifecycle.wake(loopId), true);
    assert.deepEqual(await lifecycle.parked(sessionId), []);
    assert.equal((await db.drain_claim_next_loop.get({ session_id: sessionId }))?.id, loopId);
    assert.equal((await run("WAIT")).status, 202);
    const [second] = await lifecycle.parked(sessionId);
    assert.equal(second?.wait_poll_at, 311_000);
    assert.equal(second?.wait_revision, first.wait_revision + 1);
    assert.equal(await lifecycle.wake(loopId, { revision: first.wait_revision, dueAt: 610_000 }), false,
        "the previous timer cannot end the new park");
});

for (const header of ["WAIT", "WAIT (sh:///missing) <60,60> [{\"timeout\":42}]"]) {
    test(`{§op-shapes} {§loop-completion} ${header} parks on the actual live child, not the decoration`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "wait-obligations");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Await the child.");
        await holdChild(db, workspaceId, sessionId);
        const source = [PlurnkParser.frame(header, "Await results."), PlurnkParser.frame("NOTE", "The child is checking.")].join("\n\n");
        const result = await new Engine({ db, schemes: new SchemeRegistry() }).runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: source, reasoning: null } }] }),
            workspaceId, sessionId, loopId, messages: [],
        });
        assert.equal(result.status, 202);
        assert.equal(await new LoopLifecycle(db).status(loopId), 202);
        assert.deepEqual(result.outcomes.map(({ op, status }) => [op, status]), [["NOTE", 200], ["WAIT", 202]], "WAIT still settles after its sibling");
        const rows = await db.test_log_entries_by_turn.all<{ op: string; tx: string; rx: string }>({ turn_id: result.turnId });
        const wait = rows.find(({ op }) => op === "WAIT");
        assert.ok(wait);
        const tx = JSON.parse(wait.tx);
        assert.equal(tx.target?.raw ?? null, header === "WAIT" ? null : "sh:///missing");
        assert.equal(tx.lineMarker, null);
        assert.equal(tx.metadata, null);
        assert.equal(tx.body, "Await results.");
        assert.equal(JSON.parse(wait.rx).problem, undefined);
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: result.turnId });
        assert.deepEqual(attempts.map(({ accepted, parse_errors }) => [accepted, JSON.parse(parse_errors)]), [[1, []]]);
    });
}

test("{§op-shapes} {§loop-completion} WAIT retains literal prose without inventing a response", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "continuation-inventory");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Report the outcome.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const body = "Report the findings.";
        const source = PlurnkParser.frame("WAIT", body);
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: source, reasoning: null } }] }),
            workspaceId, sessionId, loopId, messages: [],
        });
        assert.equal(result.status, 102, "absence of live work does not complete a waiting task");
        const terminal = await new LoopLifecycle(db).result(loopId);
        assert.equal(terminal, null, "no deliverable is manufactured from a wait");
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; attrs: string; tx: string; rx: string; status_rx: number }>({ turn_id: result.turnId });
        assert.deepEqual(rows.filter((row) => row.origin === "model" && !LogEntryProjection.isEmission(row)).map(({ op }) => op), ["WAIT"]);
        const wait = rows.find(({ op }) => op === "WAIT")!;
        assert.equal(wait.status_rx, 102);
        assert.equal(JSON.parse(wait.rx).detail, "Nothing is in flight. Continuing."); // {§operation-results}
        assert.equal(JSON.parse(wait.tx).body, body);
        const projection = LogBody.resolve({ op: "WAIT", tx: JSON.parse(wait.tx), rx: JSON.parse(wait.rx) });
        assert.equal(projection.mimetype, "text/plain");
        assert.equal(projection.content, body);
    } finally { await db.close(); }
});

test("{§loop-completion} every idle WAIT receives the same plain receipt, however often it repeats", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `idle-wait-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Report the outcome.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const source = PlurnkParser.frame("WAIT", "Awaiting the answer.");
        const detailOf = async () => {
            const result = await engine.runTurn({
                provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: source, reasoning: null } }] }),
                workspaceId, sessionId, loopId, messages: [],
            });
            assert.equal(result.status, 102, "an idle WAIT neither parks nor resolves the open message");
            const rows = await db.test_log_entries_by_turn.all<{ op: string | null; rx: string }>({ turn_id: result.turnId });
            return JSON.parse(rows.find(({ op }) => op === "WAIT")!.rx).detail as string;
        };

        const details = [await detailOf(), await detailOf(), await detailOf()];
        assert.deepEqual(details, Array(3).fill("Nothing is in flight. Continuing."), "a repeated idle WAIT is never corrected"); // {§operation-results}
    } finally { await db.close(); }
});
});
