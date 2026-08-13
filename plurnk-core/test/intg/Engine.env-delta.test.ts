// Contract specimens for {§env-delta-log-pull} and
// {§env-delta-worker-entry-visibility}. #67 retains the model-facing actor-name gap.

import test from "node:test";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Engine from "../../src/core/Engine.ts";
import Fork from "../../src/core/fork.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Results from "../../src/core/results.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Log from "../../src/schemes/Log.ts";
import Owner from "../../src/core/Owner.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import type { SendStatement, EditStatement, UrlPath } from "@plurnk/plurnk-contracts";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, logEntries, makeSchemeCtx, rootWorkspace } from "./_helpers.ts";

const execFileP = promisify(execFile);

const okSend = (): MockResponse => ({
    assistant: {
        content: "",
        ops: [{ op: "SEND", suffix: "", signal: 200, target: null, lineMarker: null, body: { raw: "ok", json: null }, position: { line: 1, column: 1 } } as SendStatement],
        reasoning: null,
    },
});
const MESSAGES = [{ role: "system" as const, content: "You are an agent." }, { role: "user" as const, content: "go" }];

// {§tokenomics-window-partition} — the envelope rides the provider; the wide Mock windows in this file keep the grinder out.
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
    return new Proxy(db as unknown as object, {
        get(target, property) {
            return property === statementName ? wrapped : Reflect.get(target, property, target);
        },
    }) as Db;
};

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});
const workerPath = (authority: string, pathname: string): UrlPath => ({
    kind: "url", raw: `worker://${authority}${pathname}`, scheme: "worker",
    username: null, password: null, hostname: authority, port: null,
    pathname, query: null, fragment: null,
});
const editStmt = (target: UrlPath, body: string, tags: string[] | null = null): EditStatement => ({
    op: "EDIT", suffix: "", signal: tags, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

test("observer-local log classifications cannot rewrite an ambient occurrence", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ambient-tags-${crypto.randomUUID()}`);
        const sourceId = await insertWorker(db, workspaceId, null, "source");
        const sourceLoopId = await insertLoop(db, sourceId, 1, "publish");
        const sourceTurnId = await insertTurn(db, sourceLoopId, 1);
        const firstObserverId = await insertWorker(db, workspaceId, null, "first-observer");
        const firstObserverLoopId = await insertLoop(db, firstObserverId, 1, "observe");
        const secondObserverId = await insertWorker(db, workspaceId, null, "second-observer");
        const secondObserverLoopId = await insertLoop(db, secondObserverId, 1, "observe");
        const engine = makeEngine(db);
        const provider = new Mock({
            contextWindow: 4096,
            responses: [okSend(), okSend(), okSend(), okSend()],
        });

        await engine.runTurn({ provider, workspaceId, workerId: firstObserverId, loopId: firstObserverLoopId, messages: MESSAGES, turnNumber: 1 });
        await engine.runTurn({ provider, workspaceId, workerId: secondObserverId, loopId: secondObserverLoopId, messages: MESSAGES, turnNumber: 1 });
        assert.equal((await engine.dispatch({
            statement: editStmt(urlPath("worker", "/classified.md"), "shared", ["+research"]),
            workspaceId,
            workerId: sourceId,
            loopId: sourceLoopId,
            turnId: sourceTurnId,
            sequence: 1,
            origin: "model",
        })).status, 201);

        await engine.runTurn({ provider, workspaceId, workerId: firstObserverId, loopId: firstObserverLoopId, messages: MESSAGES, turnNumber: 2 });
        const firstRows = await db.engine_render_log.all<{
            id: number;
            origin: string;
            op: string;
            pathname: string | null;
        }>({ worker_id: firstObserverId });
        const firstDelta = firstRows.find((row) => row.origin === "plurnk"
            && row.op === "EDIT"
            && row.pathname === "/classified.md");
        assert.ok(firstDelta, "the first observer materialized the source occurrence");
        await db.log_write_tag.run({ log_entry_id: firstDelta.id, tag: "overflow" });

        await engine.runTurn({ provider, workspaceId, workerId: secondObserverId, loopId: secondObserverLoopId, messages: MESSAGES, turnNumber: 2 });
        const secondRows = await db.engine_render_log.all<{
            origin: string;
            op: string;
            pathname: string | null;
            tags: string;
        }>({ worker_id: secondObserverId });
        const secondDelta = secondRows.find((row) => row.origin === "plurnk"
            && row.op === "EDIT"
            && row.pathname === "/classified.md");
        assert.ok(secondDelta, "the second observer materialized the same source occurrence");
        assert.deepEqual(JSON.parse(secondDelta.tags), ["research"], "observer policy remains local to its own log");
    } finally { await db.close(); }
});

test("an observer cannot capture an EDIT occurrence between its row and classifications", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ambient-tag-atomicity-${crypto.randomUUID()}`);
        const sourceId = await insertWorker(db, workspaceId, null, "source");
        const sourceLoopId = await insertLoop(db, sourceId, 1, "publish");
        const sourceTurnId = await insertTurn(db, sourceLoopId, 1);
        const observerId = await insertWorker(db, workspaceId, null, "observer");
        const observerLoopId = await insertLoop(db, observerId, 1, "observe");
        const observerEngine = makeEngine(db);
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend()] });

        await observerEngine.runTurn({ provider, workspaceId, workerId: observerId, loopId: observerLoopId, messages: MESSAGES, turnNumber: 1 });
        let capturedTags: unknown;
        const sourceDb = afterFirstStatement(db, "engine_insert_log_entry", "get", async () => {
            await observerEngine.runTurn({ provider, workspaceId, workerId: observerId, loopId: observerLoopId, messages: MESSAGES, turnNumber: 2 });
            const rows = await db.engine_render_log.all<{
                origin: string;
                op: string;
                pathname: string | null;
                tags: string;
            }>({ worker_id: observerId });
            const delta = rows.find((row) => row.origin === "plurnk"
                && row.op === "EDIT"
                && row.pathname === "/classified.md");
            assert.ok(delta, "the interleaved observer captured the source occurrence");
            capturedTags = JSON.parse(delta.tags);
        });
        const sourceEngine = makeEngine(sourceDb);

        assert.equal((await sourceEngine.dispatch({
            statement: editStmt(urlPath("worker", "/classified.md"), "shared", ["+research"]),
            workspaceId,
            workerId: sourceId,
            loopId: sourceLoopId,
            turnId: sourceTurnId,
            sequence: 1,
            origin: "model",
        })).status, 201);
        assert.deepEqual(capturedTags, ["research"], "the durable occurrence commits with its initial classification");
    } finally { await db.close(); }
});

test("worker-entry deltas follow shared visibility without leaking private scratch", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `owner-delta-${crypto.randomUUID()}`);
        const observer = await insertWorker(db, workspaceId, null, "observer");
        const observerLoop = await insertLoop(db, observer, 1, "go");
        const sibling = await insertWorker(db, workspaceId, observer, "sibling");
        const siblingLoop = await insertLoop(db, sibling, 1);
        const siblingTurn = await insertTurn(db, siblingLoop, 1);
        const kernel = await insertWorker(db, workspaceId, null, "plurnk");
        const kernelLoop = await insertLoop(db, kernel, 1);
        const kernelTurn = await insertTurn(db, kernelLoop, 1);
        const eng = makeEngine(db);
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend()] });

        await eng.runTurn({ provider, workspaceId, workerId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 1 });
        assert.equal((await eng.dispatch({
            statement: editStmt(urlPath("worker", "/shared.md"), "shared bulletin"),
            workspaceId, workerId: sibling, loopId: siblingLoop, turnId: siblingTurn, sequence: 1, origin: "model",
        })).status, 201, "the sibling creates a commons entry");
        assert.equal((await eng.dispatch({
            statement: editStmt(workerPath("~", "/secret.md"), "private tilde scratch"),
            workspaceId, workerId: sibling, loopId: siblingLoop, turnId: siblingTurn, sequence: 2, origin: "model",
        })).status, 201, "the sibling creates current-worker scratch");
        assert.equal((await eng.dispatch({
            statement: editStmt(workerPath("sibling", "/named-secret.md"), "private named scratch"),
            workspaceId, workerId: sibling, loopId: siblingLoop, turnId: siblingTurn, sequence: 3, origin: "model",
        })).status, 201, "the sibling creates the same private space through its literal name");
        assert.equal((await eng.dispatch({
            statement: editStmt(workerPath("plurnk", "/bulletin.md"), "kernel bulletin"),
            workspaceId, workerId: kernel, loopId: kernelLoop, turnId: kernelTurn, sequence: 1, origin: "plurnk",
        })).status, 201, "the kernel creates a published entry");

        await eng.runTurn({ provider, workspaceId, workerId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 2 });
        const rows = await db.engine_render_log.all<{
            origin: string; op: string; scheme: string | null; hostname: string | null;
            pathname: string | null; source: string | null; rx: string;
        }>({ worker_id: observer });
        const deltas = rows.filter((row) => row.origin === "plurnk" && row.op === "EDIT");

        assert.deepEqual(
            deltas
                .filter((row) => row.scheme === "worker")
                .map(({ hostname, pathname, source }) => ({ hostname, pathname, source }))
                .sort((a, b) => (a.pathname ?? "").localeCompare(b.pathname ?? "")),
            [
                { hostname: "plurnk", pathname: "/bulletin.md", source: "worker://plurnk" },
                { hostname: null, pathname: "/shared.md", source: "worker://sibling" },
            ],
            "only commons and the published kernel surface cross, under their original addresses",
        );
        assert.doesNotMatch(JSON.stringify(deltas), /private (?:tilde|named) scratch/, "private receipt content never reaches the observer log");
    } finally {
        await db.close();
    }
});

test("a worker learns a sibling's edit through its own log — pulled from the shared log, no per-worker snapshot", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `xrun-${crypto.randomUUID()}`);
        const workerA = await insertWorker(db, workspaceId, null, "observer");
        const loopA = await insertLoop(db, workerA, 1, "go");
        const workerB = await insertWorker(db, workspaceId, null, "sibling");
        const loopB = await insertLoop(db, workerB, 1);
        const turnB = await insertTurn(db, loopB, 1);
        const eng = makeEngine(db);
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend()] });

        // A's turn 1 sets its "last looked" boundary; nothing happened before it, so no deltas.
        await eng.runTurn({ provider, workspaceId, workerId: workerA, loopId: loopA, messages: MESSAGES, turnNumber: 1 });
        // B edits a shared entry — a real EDIT row in B's own log.
        const edit = await eng.dispatch({ statement: editStmt(urlPath("worker", "/shared.md"), "from sibling B"), workspaceId, workerId: workerB, loopId: loopB, turnId: turnB, sequence: 1, origin: "model" });
        assert.ok(edit.status === 200 || edit.status === 201, "B's edit to the shared entry lands");

        // A's turn 2 pulls B's edit from the shared log as a FOLDED delta — A consulted no
        // per-worker snapshot; it learned its world moved purely through its own log.
        const turn = await eng.runTurn({ provider, workspaceId, workerId: workerA, loopId: loopA, messages: MESSAGES, turnNumber: 2 });
        const rows = await db.engine_render_log.all<{ scheme: string | null; origin: string; op: string; pathname: string; source: string | null; expanded: number }>({ worker_id: workerA });
        const delta = rows.find((r) => r.op === "EDIT" && r.origin === "plurnk" && r.scheme === "worker" && r.pathname === "/shared.md");
        assert.ok(delta, "A's turn-2 log carries a delta for B's edit");
        assert.equal(delta!.source, "worker://sibling", "the durable delta uses the sibling's addressable identity");
        assert.equal(delta!.expanded, 0, "the broadcast delta lands FOLDED — listed, collapsed until the model OPENs it");

        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turn.turnId }))!.packet);
        const packetDelta = logEntries(packet).find((entry) => entry.target === "worker:///shared.md" && String(entry.path).endsWith("/EDIT"));
        assert.equal(packetDelta?.source, "worker://sibling", "the model sees the same worker identity used by worker control");
    } finally {
        await db.close();
    }
});

test("ambient delivery follows monotonic occurrence identity, never wall-clock order", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `event-id-${crypto.randomUUID()}`);
        const observer = await insertWorker(db, workspaceId, null, "observer");
        const observerLoop = await insertLoop(db, observer, 1, "observe");
        const producer = await insertWorker(db, workspaceId, null, "producer");
        const producerLoop = await insertLoop(db, producer, 1, "produce");
        const producerTurn = await insertTurn(db, producerLoop, 1);
        const eng = makeEngine(db);
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend(), okSend()] });

        await eng.runTurn({ provider, workspaceId, workerId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 1 });

        const sameOldTime = "2000-01-01T00:00:00.000Z";
        for (const [index, pathname] of ["/equal-a.md", "/equal-b.md"].entries()) {
            await db.test_insert_shared_edit_at.get({
                worker_id: producer,
                loop_id: producerLoop,
                turn_id: producerTurn,
                sequence: index + 1,
                at: sameOldTime,
                pathname,
                rx: JSON.stringify({ status: 201, span: `1:${pathname}` }),
            });
        }

        await eng.runTurn({ provider, workspaceId, workerId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 2 });
        await eng.runTurn({ provider, workspaceId, workerId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 3 });

        const rows = await db.engine_render_log.all<{ origin: string; op: string; pathname: string | null }>({ worker_id: observer });
        const observed = rows
            .filter((row) => row.origin === "plurnk" && row.op === "EDIT" && row.pathname?.startsWith("/equal-") === true)
            .map((row) => row.pathname)
            .sort();
        assert.deepEqual(observed, ["/equal-a.md", "/equal-b.md"], "both equal-time events arrive, once each");

        const links = async (workerId: number) => (await db.test_log_entries_by_worker.all<{
            ambient_event_id: number | null; pathname: string | null;
        }>({ worker_id: workerId }))
            .filter((row) => row.pathname?.startsWith("/equal-") === true)
            .map(({ pathname, ambient_event_id }) => ({ pathname, eventId: ambient_event_id }))
            .sort((a, b) => (a.pathname ?? "").localeCompare(b.pathname ?? ""));
        const produced = await links(producer);
        assert.ok(produced.every(({ eventId }) => eventId !== null), "each source row is atomically linked to its occurrence");
        assert.ok((produced[0]?.eventId ?? 0) < (produced[1]?.eventId ?? 0), "equal wall time does not disturb total occurrence order");
        assert.deepEqual(await links(observer), produced, "observer rows carry the same stable event identities as their sources");
    } finally {
        await db.close();
    }
});

test("a proposed shared EDIT publishes only on successful resolution", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `proposal-event-${crypto.randomUUID()}`);
        const observer = await insertWorker(db, workspaceId, null, "observer");
        const observerLoop = await insertLoop(db, observer, 1, "observe");
        const producer = await insertWorker(db, workspaceId, null, "producer");
        const producerLoop = await insertLoop(db, producer, 1, "propose");
        const producerTurn = await insertTurn(db, producerLoop, 1);
        const eng = makeEngine(db);
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend()] });
        await eng.runTurn({ provider, workspaceId, workerId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 1 });

        const propose = async (sequence: number, pathname: string): Promise<number> => {
            const row = await db.engine_insert_log_entry.get<{ id: number }>({
                worker_id: producer, loop_id: producerLoop, turn_id: producerTurn, sequence,
                origin: "model", source: null, op: "EDIT", suffix: "", signal: null,
                scheme: "worker", username: null, password: null, hostname: null, port: null,
                pathname, query: null, fragment: null, lineMarker: null,
                tx: "", mimetype_tx: "text/plain", rx: JSON.stringify({ status: 202 }),
                mimetype_rx: "application/json", status_rx: 202, tokens: 0,
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
        });
        await db.engine_resolve_log_entry.run({
            id: rejected, state: "failed", outcome: "rejected", status_rx: 403,
            rx: JSON.stringify({ status: 403 }),
        });

        await eng.runTurn({ provider, workspaceId, workerId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 2 });
        const rows = await db.engine_render_log.all<{ origin: string; op: string; pathname: string | null }>({ worker_id: observer });
        const observed = rows
            .filter((row) => row.origin === "plurnk" && row.op === "EDIT" && row.pathname?.endsWith("-proposal.md") === true)
            .map((row) => row.pathname);
        assert.deepEqual(observed, ["/accepted-proposal.md"], "acceptance publishes once; rejection never becomes ambient state");
    } finally {
        await db.close();
    }
});

test("a closed pull boundary assigns before, during, and after races exactly once", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `closed-boundary-${crypto.randomUUID()}`);
        const observer = await insertWorker(db, workspaceId, null, "observer");
        const observerLoop = await insertLoop(db, observer, 1, "observe");
        const producer = await insertWorker(db, workspaceId, null, "producer");
        const producerLoop = await insertLoop(db, producer, 1, "produce");
        const producerTurn = await insertTurn(db, producerLoop, 1);
        const eng = makeEngine(db);
        let producerSequence = 1;
        const emit = async (pathname: string): Promise<void> => {
            const result = await eng.dispatch({
                statement: editStmt(urlPath("worker", pathname), pathname),
                workspaceId,
                workerId: producer,
                loopId: producerLoop,
                turnId: producerTurn,
                sequence: producerSequence++,
                origin: "model",
            });
            assert.ok(result.status === 200 || result.status === 201);
        };

        await eng.runTurn({
            provider: new Mock({ contextWindow: 4096, responses: [okSend()] }),
            workspaceId, workerId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 1,
        });

        let racedDb = afterFirstStatement(db, "engine_open_turn", "get", () => emit("/before-boundary.md"));
        racedDb = afterFirstStatement(racedDb, "engine_pull_ambient_events", "all", () => emit("/during-boundary.md"));
        await makeEngine(racedDb).runTurn({
            provider: new Mock({ contextWindow: 4096, responses: [okSend()] }),
            workspaceId, workerId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 2,
        });
        await emit("/after-boundary.md");

        const tailProvider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend()] });
        await eng.runTurn({ provider: tailProvider, workspaceId, workerId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 3 });
        await eng.runTurn({ provider: tailProvider, workspaceId, workerId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 4 });

        const rows = await db.engine_render_log.all<{
            turn_seq: number; origin: string; op: string; pathname: string | null;
        }>({ worker_id: observer });
        assert.deepEqual(
            rows
                .filter((row) => row.origin === "plurnk" && row.op === "EDIT" && row.pathname?.endsWith("-boundary.md") === true)
                .map(({ turn_seq, pathname }) => ({ turn: turn_seq, pathname }))
                .sort((a, b) => (a.pathname ?? "").localeCompare(b.pathname ?? "")),
            [
                { turn: 3, pathname: "/after-boundary.md" },
                { turn: 2, pathname: "/before-boundary.md" },
                { turn: 3, pathname: "/during-boundary.md" },
            ],
            "the captured window owns only the event already inside it; both later events wait for the next pull",
        );
    } finally {
        await db.close();
    }
});

test("a fresh worker baselines history but retains an event racing its first packet", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `first-boundary-${crypto.randomUUID()}`);
        const observer = await insertWorker(db, workspaceId, null, "observer");
        const observerLoop = await insertLoop(db, observer, 1, "observe");
        const producer = await insertWorker(db, workspaceId, null, "producer");
        const producerLoop = await insertLoop(db, producer, 1, "produce");
        const producerTurn = await insertTurn(db, producerLoop, 1);
        const eng = makeEngine(db);
        let producerSequence = 1;
        const emit = async (pathname: string): Promise<void> => {
            await eng.dispatch({
                statement: editStmt(urlPath("worker", pathname), pathname),
                workspaceId, workerId: producer, loopId: producerLoop, turnId: producerTurn,
                sequence: producerSequence++, origin: "model",
            });
        };

        await emit("/historical.md");
        const racedDb = afterFirstStatement(db, "engine_initialize_ambient_cursor", "get", () => emit("/first-turn-race.md"));
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend()] });
        await makeEngine(racedDb).runTurn({
            provider, workspaceId, workerId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 1,
        });
        await eng.runTurn({ provider, workspaceId, workerId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 2 });

        const rows = await db.engine_render_log.all<{ origin: string; op: string; pathname: string | null }>({ worker_id: observer });
        const observed = rows
            .filter((row) => row.origin === "plurnk" && row.op === "EDIT" && ["/historical.md", "/first-turn-race.md"].includes(row.pathname ?? ""))
            .map((row) => row.pathname);
        assert.deepEqual(observed, ["/first-turn-race.md"], "pre-baseline history stays out; a post-baseline race remains deliverable once");
    } finally {
        await db.close();
    }
});

test("ambient occurrence evidence survives source-log curation", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `curated-source-${crypto.randomUUID()}`);
        const observer = await insertWorker(db, workspaceId, null, "observer");
        const observerLoop = await insertLoop(db, observer, 1, "observe");
        const producer = await insertWorker(db, workspaceId, null, "producer");
        const producerLoop = await insertLoop(db, producer, 1, "produce");
        const producerTurn = await insertTurn(db, producerLoop, 1);
        const eng = makeEngine(db);
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend()] });

        await eng.runTurn({ provider, workspaceId, workerId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 1 });
        await eng.dispatch({
            statement: editStmt(urlPath("worker", "/curated.md"), "durable occurrence"),
            workspaceId, workerId: producer, loopId: producerLoop, turnId: producerTurn, sequence: 1, origin: "model",
        });
        const killed = await new Log().kill("/1/1/1", null, makeSchemeCtx({
            db, workspaceId, workerId: producer, loopId: producerLoop, turnId: producerTurn, writer: "model",
        }));
        assert.equal(killed.status, 200, "the producer really curated away its source row");

        await eng.runTurn({ provider, workspaceId, workerId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 2 });
        const rows = await db.engine_render_log.all<{ origin: string; op: string; pathname: string | null; rx: string }>({ worker_id: observer });
        const delta = rows.find((row) => row.origin === "plurnk" && row.op === "EDIT" && row.pathname === "/curated.md");
        assert.match(delta?.rx ?? "", /durable occurrence/, "curating the producer's log cannot erase the ambient event");
        await db.test_workspaces_delete.run({ id: workspaceId });
    } finally {
        await db.close();
    }
});

test("a fork inherits observed progress and independently receives pending events", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fork-cursor-${crypto.randomUUID()}`);
        const parent = await insertWorker(db, workspaceId, null, "parent");
        const parentLoop = await insertLoop(db, parent, 1, "observe");
        const producer = await insertWorker(db, workspaceId, null, "producer");
        const producerLoop = await insertLoop(db, producer, 1, "produce");
        const producerTurn = await insertTurn(db, producerLoop, 1);
        const eng = makeEngine(db);
        const parentProvider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend(), okSend()] });

        await eng.runTurn({ provider: parentProvider, workspaceId, workerId: parent, loopId: parentLoop, messages: MESSAGES, turnNumber: 1 });
        await eng.dispatch({
            statement: editStmt(urlPath("worker", "/seen-before-fork.md"), "seen"),
            workspaceId, workerId: producer, loopId: producerLoop, turnId: producerTurn, sequence: 1, origin: "model",
        });
        await eng.runTurn({ provider: parentProvider, workspaceId, workerId: parent, loopId: parentLoop, messages: MESSAGES, turnNumber: 2 });
        await eng.dispatch({
            statement: editStmt(urlPath("worker", "/pending-at-fork.md"), "pending"),
            workspaceId, workerId: producer, loopId: producerLoop, turnId: producerTurn, sequence: 2, origin: "model",
        });

        const branch = await Fork.fork(db, parent, "branch");
        const branchLoop = await insertLoop(db, branch, 2, "continue");
        await eng.runTurn({
            provider: new Mock({ contextWindow: 4096, responses: [okSend()] }),
            workspaceId, workerId: branch, loopId: branchLoop, messages: MESSAGES, turnNumber: 1,
        });
        await eng.runTurn({ provider: parentProvider, workspaceId, workerId: parent, loopId: parentLoop, messages: MESSAGES, turnNumber: 3 });

        for (const [workerId, label] of [[branch, "branch"], [parent, "parent"]] as const) {
            const rows = await db.engine_render_log.all<{ origin: string; op: string; pathname: string | null; source: string | null }>({ worker_id: workerId });
            const paths = rows
                .filter((row) => row.origin === "plurnk" && row.op === "EDIT" && row.pathname?.endsWith("-fork.md") === true)
                .map(({ pathname, source }) => ({ pathname, source }))
                .sort((a, b) => (a.pathname ?? "").localeCompare(b.pathname ?? ""));
            assert.deepEqual(paths, [
                { pathname: "/pending-at-fork.md", source: "worker://producer" },
                { pathname: "/seen-before-fork.md", source: "worker://producer" },
            ], `${label} preserves the public cause across copied history and pending delivery`);
        }
    } finally {
        await db.close();
    }
});

test("an environment delta preserves typed source attributes for model-facing projection", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `typed-delta-${crypto.randomUUID()}`);
        const observer = await insertWorker(db, workspaceId, null, "observer");
        const observerLoop = await insertLoop(db, observer, 1, "go");
        const plurnk = await insertWorker(db, workspaceId, null, "plurnk");
        const plurnkLoop = await insertLoop(db, plurnk, 1);
        const plurnkTurn = await insertTurn(db, plurnkLoop, 1);
        const eng = makeEngine(db);
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend()] });

        await eng.runTurn({ provider, workspaceId, workerId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 1 });
        const inserted = await db.engine_insert_log_entry.get<{ id: number }>({
            worker_id: plurnk, loop_id: plurnkLoop, turn_id: plurnkTurn, sequence: 1,
            origin: "plurnk", source: "worker://observer", op: "EDIT", suffix: "", signal: JSON.stringify(["+query"]),
            scheme: "https", username: null, password: null, hostname: "example.org", port: null,
            pathname: "/page", query: null, fragment: null, lineMarker: null,
            tx: JSON.stringify({ op: "EDIT", body: "page" }), mimetype_tx: "application/json",
            rx: JSON.stringify({ status: 201, span: "1:page" }), mimetype_rx: "application/json",
            status_rx: 201, tokens: 1, state: "resolved", outcome: null,
            attrs: JSON.stringify({ kind: "entry_materialized" }),
        });
        assert.ok(inserted !== undefined);

        await eng.runTurn({ provider, workspaceId, workerId: observer, loopId: observerLoop, messages: MESSAGES, turnNumber: 2 });
        const rows = await db.engine_render_log.all<{ origin: string; op: string; pathname: string; source: string | null; attrs: string; tags: string }>({ worker_id: observer });
        const delta = rows.find((row) => row.origin === "plurnk" && row.op === "EDIT" && row.pathname === "/page");
        assert.equal(delta?.source, "worker://observer");
        assert.deepEqual(JSON.parse(delta?.attrs ?? "{}"), { kind: "entry_materialized" });
        assert.deepEqual(JSON.parse(delta?.tags ?? "[]"), ["query"]);
    } finally {
        await db.close();
    }
});

test("exactly two cross-worker channels — state via the env-delta, a message via inject", async () => {
    // Both doors in one place: inject and IRC resume parked workers in place
    // under {§methods-loop-run-fold-consistency}. No third channel — by design.
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `two-doors-${crypto.randomUUID()}`);
        const workerA = await insertWorker(db, workspaceId, null, "observer");
        const loopA = await insertLoop(db, workerA, 1, "go");
        const workerB = await insertWorker(db, workspaceId, null, "sibling");
        const loopB = await insertLoop(db, workerB, 1);
        const turnB = await insertTurn(db, loopB, 1);
        const eng = makeEngine(db);
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend()] });

        await eng.runTurn({ provider, workspaceId, workerId: workerA, loopId: loopA, messages: MESSAGES, turnNumber: 1 });
        // ENVIRONMENT DOOR — *state*: B's edit to a shared entry crosses to A as a FOLDED delta, not a message.
        await eng.dispatch({ statement: editStmt(urlPath("worker", "/shared.md"), "from sibling B"), workspaceId, workerId: workerB, loopId: loopB, turnId: turnB, sequence: 1, origin: "model" });
        const turn2 = await eng.runTurn({ provider, workspaceId, workerId: workerA, loopId: loopA, messages: MESSAGES, turnNumber: 2 });
        const rows = await db.engine_render_log.all<{ origin: string; op: string; pathname: string; source: string | null }>({ worker_id: workerA });
        assert.ok(
            rows.some((r) => r.op === "EDIT" && r.origin === "plurnk" && r.pathname === "/shared.md" && r.source === "worker://sibling"),
            "environment door: B's shared-entry edit crossed to A as a delta (state, ambient)",
        );

        // VOICE DOOR — *message*: an inject delivers a directed message onto A's own loop's next turn.
        await db.test_set_loop_status.run({ id: loopA, status: 102, terminal_result: null }); // A is the active loop
        const injected = await eng.inject(workerA, "a directed message for A");
        assert.notEqual(injected, null, "voice door: the inject found A's loop and delivered");
        assert.equal(injected!.loopId, loopA, "the message landed on A's loop — directed, not ambient");
    } finally {
        await db.close();
    }
});

test("an out-of-band disk change surfaces as a source=file delta narrated by the plurnk worker", async () => {
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
        const workerA = await insertWorker(db, workspaceId);
        const loopA = await insertLoop(db, workerA, 1, "go");
        const eng = makeEngine(db);
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend()] });

        // Turn 1 materializes notes.md from disk (first sight — no divergence).
        await eng.runTurn({ provider, workspaceId, workerId: workerA, loopId: loopA, messages: MESSAGES, turnNumber: 1 });
        const afterT1 = await db.engine_render_log.all<{ origin: string; op: string; source: string | null }>({ worker_id: workerA });
        assert.ok(!afterT1.some((r) => r.origin === "plurnk" && r.op === "EDIT" && r.source === "file"), "first sight reconciles silently — no fs delta");
        // The file changes out-of-band (an external editor, a git pull).
        await writeFile(join(root, "notes.md"), "line1\nline2\nline3-external\n");

        // Turn 2 — the plurnk worker logs the divergence as a source=file EDIT; A pulls it.
        const turn2 = await eng.runTurn({ provider, workspaceId, workerId: workerA, loopId: loopA, messages: MESSAGES, turnNumber: 2 });
        const rows = await db.engine_render_log.all<{ origin: string; op: string; source: string | null; rx: string; pathname: string; expanded: number; attrs: string }>({ worker_id: workerA });
        const delta = rows.find((r) => r.origin === "plurnk" && r.op === "EDIT" && r.source === "file");
        assert.ok(delta, "the out-of-band disk change surfaced as a source=file delta");
        assert.equal(delta!.pathname, "notes.md", "the delta names the diverged file");
        assert.equal(delta!.expanded, 0, "the fs delta lands folded");
        assert.match(JSON.parse(delta!.rx).span as string, /line3-external/, "the delta carries the changed span ({§env-delta-filesystem-narration})");
        assert.equal((JSON.parse(delta!.attrs) as { git?: string }).git, " M", "the event preserves Git's exact unstaged coordinate");
        const packet = await db.test_get_packet.get<{ packet: string }>({ id: turn2.turnId });
        const log = (JSON.parse(packet!.packet) as { sections: Array<{ name: string; content: string }> }).sections.find(({ name }) => name === "log")!.content;
        assert.match(log, /"git":" M"/, "the durable attribute is deliberately projected into model-facing row metadata");
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§membership-change-gated-sync}: deletion removes stale readable content and narrates the Git state", async () => {
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
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = makeEngine(db);
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend()] });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        await rm(join(root, "removed.md"));
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });

        const channel = await db.ops_read_channel.get({ workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: "file", pathname: "removed.md", channel: "body" });
        assert.equal(channel, undefined, "a deleted file cannot remain READable from a stale body channel");
        const rows = await db.engine_render_log.all<{ source: string | null; pathname: string; rx: string; attrs: string }>({ worker_id: workerId });
        const delta = rows.find((row) => row.source === "file" && row.pathname === "removed.md");
        assert.ok(delta, "the observed deletion is a durable environment event");
        assert.equal((JSON.parse(delta!.rx) as { span: string }).span, "", "the deleted resource has no resulting text to project");
        assert.equal((JSON.parse(delta!.attrs) as { git?: string }).git, " D", "Git classifies the observed worktree deletion exactly");
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

// {§worker-scheme-collect} loop-termination rides the same ambient log rail: when a sibling's loop
// reaches a terminal status, the observer pulls it at pre-turn as a FOLDED SEND from
// worker://<name> carrying the loop's exact terminal result. The terminated_at
// trigger stamps every death-path uniformly, so a graceful 200 and an uncommon
// failure status surface through the same mechanism.
test("a sibling's loop-termination surfaces — a 2xx deliverable born OPEN + awakening, a failure folded", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `loopterm-${crypto.randomUUID()}`);
        const workerA = await insertWorker(db, workspaceId);                       // the observer
        const loopA = await insertLoop(db, workerA, 1, "go");
        const worker = await insertWorker(db, workspaceId, null, "worker");      // finishes gracefully
        const workerLoop = await insertLoop(db, worker, 1, "investigate the bug");
        const failedWorker = await insertWorker(db, workspaceId, null, "failed-worker");
        const failedLoop = await insertLoop(db, failedWorker, 1, "call provider");
        const eng = makeEngine(db);
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend()] });

        // A's turn 1 sets its "last looked" boundary; the siblings are still running.
        await eng.runTurn({ provider, workspaceId, workerId: workerA, loopId: loopA, messages: MESSAGES, turnNumber: 1 });
        // One worker delivers successfully; the other retains an uncommon exact
        // provider status even though the scheduler projects it to lifecycle 500.
        const lifecycle = new LoopLifecycle(db);
        const deliverable = { status: 200, content: "the answer is 42", mimetype: "text/markdown" };
        assert.deepEqual(await lifecycle.finish(workerLoop, deliverable), deliverable);
        assert.equal(
            (await lifecycle.finish(
                failedLoop,
                Results.failure("engine:provider", "provider-failed", 502, "provider_failure"),
            ))?.status,
            502,
        );

        // A's turn 2 pulls both terminations from the shared log: the 2xx
        // deliverable born open, the failure folded.
        await eng.runTurn({ provider, workspaceId, workerId: workerA, loopId: loopA, messages: MESSAGES, turnNumber: 2 });
        const rows = await db.engine_render_log.all<{ scheme: string | null; origin: string; op: string; pathname: string; source: string | null; status_rx: number | null; rx: string; expanded: number }>({ worker_id: workerA });

        const win = rows.find((r) => r.op === "SEND" && r.scheme === "worker" && r.pathname === "/worker");
        assert.ok(win, "worker's SEND[200] termination surfaced as a worker delta in A's log");
        assert.equal(win!.origin, "plurnk", "the termination delta is the engine's narration");
        assert.equal(win!.source, "worker://worker", "attributed with the terminating worker's control identity");
        assert.equal(win!.status_rx, 200, "the terminal status rides");
        assert.deepEqual(JSON.parse(win!.rx), deliverable, "the exact terminal result rides the parent edge");
        assert.equal(win!.expanded, 1, "born OPEN — a child's 2xx deliverable reaches the parent open + awakening, not hidden behind a fold");

        const failed = rows.find((r) => r.op === "SEND" && r.scheme === "worker" && r.pathname === "/failed-worker");
        assert.ok(failed, "the failed loop surfaced too — every death-path stamps terminated_at uniformly");
        assert.equal(failed!.status_rx, 502, "the parent edge carries the exact status, not scheduler class 500");
        const failure = JSON.parse(failed!.rx) as { status: number; problem?: { detail?: string } };
        assert.equal(failure.status, 502, "the exact failure status survives the parent edge");
        assert.equal(failure.problem?.detail, "provider_failure", "the exact Problem survives the parent edge");
        assert.equal(failed!.source, "worker://failed-worker", "attributed with the failed worker's control identity");
        assert.equal(failed!.expanded, 0, "a failure stays folded — only a 2xx deliverable is born open");
    } finally {
        await db.close();
    }
});
