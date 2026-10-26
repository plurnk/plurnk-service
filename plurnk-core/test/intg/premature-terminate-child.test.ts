// {§send-premature-terminate} extended to child sessions — completion while a spawned child is still
// live is premature exactly as completion with an open stream is (children and streams are the same
// kind of "live thing the session holds", {§session-loop-lifecycle}). Engine-level A/B so it's race-free.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertSession, insertLoop, seedEntryWithChannel } from "./_db.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import type { ParsedPath } from "@plurnk/plurnk-contracts";
import { completeStmt, execStmt, killStmt, dispositionStmt, readStmt, sendStmt, urlPath, noteStmt } from "./_dsl.ts";
import DispatchAsPlurnk from "../../src/server/dispatch-as-plurnk.ts";
import { isExecutionOp } from "@plurnk/plurnk-contracts";

const knownPath = (pathname: string): ParsedPath => ({
    kind: "url", raw: `workspace:///${pathname}`, scheme: "workspace",
    username: null, password: null, hostname: null, port: null, pathname, query: null, fragment: null,
});

test("{§completion-joins-live-work} completion with a live child session joins it on the record (no erasure), never a strike", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `prem-child-${crypto.randomUUID()}`);
        const parentSession = await insertSession(db, workspaceId);
        const parentLoop = await insertLoop(db, parentSession, 1, "parent");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const send200 = (loopId: number) => engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt("Complete.")] } }] }),
            workspaceId, sessionId: parentSession, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });

        // Baseline: no child → completed inventory can conclude.
        const clean = await send200(parentLoop);
        assert.equal(clean.status, 200, "with no live child, completed inventory terminates cleanly");

        // Spawn a live child session (parent_session_id = parentSession, a non-terminal loop — default status 102).
        const childSession = await insertSession(db, workspaceId, parentSession);
        await insertLoop(db, childSession, 1, "child");

        // Completion over a live child is a join ({§completion-joins-live-work}): the loop parks.
        const joiningLoop = await insertLoop(db, parentSession, 2, "parent again");
        const premature = await send200(joiningLoop);
        assert.equal(premature.status, 202, "the completion joins the live child: the loop parks, it never went terminal");

        const rows = await db.test_log_entries_by_turn.all<{ status_rx: number; op: string; origin: string }>({ turn_id: premature.turnId });
        const modelRows = rows.filter(({ origin }) => origin === "model");
        const completion = modelRows.find((r) => r.op === "SEND");
        assert.deepEqual(modelRows.map(({ op }) => op), ["SEND"], "joining adds no fictional operation");
        assert.equal(completion?.status_rx, 200, "the reply is delivered while the loop joins the child");
    } finally { await db.close(); }
});

test("{§send-administrative-terminal} an _plurnk administrative completion closes only its own loop while model work remains live", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `admin-terminal-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const modelLoopId = await insertLoop(db, sessionId, 1, "model work");
        const childSessionId = await insertSession(db, workspaceId, sessionId);
        const childLoopId = await insertLoop(db, childSessionId, 1, "child work");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        await DispatchAsPlurnk.dispatch(engine, db, workspaceId, sessionId, [noteStmt("Maintenance.")]);
        const loops = await db.test_loop_queue_by_session.all<{ id: number; status: number }>({ session_id: sessionId });
        assert.ok(loops.some(({ id, status }) => id !== modelLoopId && status === 200),
            "the administrative transaction closes despite unrelated model work");
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: modelLoopId }))?.status, 102, "the model loop remains live");
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: childLoopId }))?.status, 102, "the child obligation remains live");
    } finally { await db.close(); }
});

test("{§completion-defers-to-results} a newer terminal loop cannot mask a child's older unresolved work", async () => {
    // A real fork clamps inherited loops terminal before creating its own work.
    // This deliberately inconsistent fixture proves that every unresolved loop
    // remains a live obligation regardless of newer history.
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `prem-concluded-${crypto.randomUUID()}`);
        const parentSession = await insertSession(db, workspaceId);
        const parentLoop = await insertLoop(db, parentSession, 1, "parent");
        const childSession = await insertSession(db, workspaceId, parentSession);
        const unresolvedLoop = await insertLoop(db, childSession, 1, "unresolved");
        const ownLoop = await insertLoop(db, childSession, 2, "own work");        // seq 2 — the child's actual loop
        await db.test_set_loop_status.run({
            id: ownLoop,
            status: 200,
            terminal_result: JSON.stringify({ status: 200 }),
        }); // it concluded

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const refused = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt("Complete.")] } }] }),
            workspaceId, sessionId: parentSession, loopId: parentLoop,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(refused.status, 202, "the older unresolved loop keeps the child live: the completion joins it");

        await db.test_set_loop_status.run({
            id: unresolvedLoop,
            status: 200,
            terminal_result: JSON.stringify({ status: 200 }),
        });
        await new LoopLifecycle(db).wake(parentLoop);
        assert.equal((await db.drain_claim_next_loop.get<{ id: number }>({ session_id: parentSession }))?.id, parentLoop);
        const completed = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null } }] }),
            workspaceId, sessionId: parentSession, loopId: parentLoop,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(completed.status, 200, "completion succeeds only after every child loop is terminal");
    } finally { await db.close(); }
});

// {§completion-defers-to-results}: settlement follows the entire admitted program.

test("{§completion-defers-to-results}: READ + completed inventory in the same turn is deferred — the pending set includes this turn's retrievals", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pend-read-${crypto.randomUUID()}`);
        const parentSession = await insertSession(db, workspaceId);
        const parentLoop = await insertLoop(db, parentSession, 1, "parent");
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/config.json", channel: "body", content: '{"host":"db.internal"}', mimetype: "application/json", state: "static" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [readStmt(knownPath("/config.json")), sendStmt(null, "the host is db.internal")] } }] }),
            workspaceId, sessionId: parentSession, loopId: parentLoop,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(result.status, 102, "the turn stays a continue — the loop never went terminal");
        const rows = await db.test_log_sequencees_by_turn.all<{ status_rx: number; op: string }>({ turn_id: result.turnId });
        assert.equal(rows.find((r) => r.op === "SEND")?.status_rx, 200, "successful delivery is not rewritten to describe loop continuation");
        // The STORED record agrees with the return: the close persists the provisional status
        // pre-dispatch, and the refusal demotes the stored row too.
        const storedTurn = await db.test_get_turn.get<{ status: number }>({ id: result.turnId });
        assert.equal(storedTurn?.status, 102, "the persisted turns.status is demoted — the digest surface never lies");
    } finally { await db.close(); }
});

test("{§send-wait-scope} WAIT ignores a non-duration decoration and continues without live work", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `park-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "wait");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "```WAIT <-1>\nstanding by\n```", reasoning: null } }] }),
            workspaceId, sessionId, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(result.status, 102);
        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 102, "an ignored scope does not invent a future wake");
        const row = await db.test_disposition_rows_for_session.all<{ status_rx: number; rx: string }>({ session_id: sessionId });
        assert.equal(row.length, 1);
        assert.equal(row[0].status_rx, 102);
        assert.equal(JSON.parse(row[0].rx).problem, undefined);
        assert.equal(JSON.parse(row[0].rx).detail, "Nothing is in flight. Continuing."); // {§pinned-wording-core}
    } finally { await db.close(); }
});

test("{§send-wait-scope} a decorated WAIT keeps its sibling, source evidence, and ordinary result", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `next-scope-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "read the note");
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/note.txt", channel: "body", content: "the note", mimetype: "text/plain", state: "static" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const content = "````READ (workspace:///note.txt)````\n````WAIT (sh:///missing) [60] [{\"timeout\":42}]\nstanding by\n````";
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content, reasoning: null } }] }),
            workspaceId, sessionId, loopId,
            messages: [{ role: "user", content: "read the note" }],
        });
        assert.equal(result.status, 102);
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; status_rx: number; rx: string }>({ turn_id: result.turnId });
        assert.equal(rows.find(({ op }) => op === "READ")?.status_rx, 200, "the valid sibling executes");
        assert.equal(rows.some(({ op }) => op === "error"), false);
        const task = rows.find(({ op }) => op === "WAIT");
        assert.equal(task?.status_rx, 102);
        assert.equal(JSON.parse(task.rx).problem, undefined);
        assert.equal(JSON.parse(task.rx).detail, "Nothing is in flight. Continuing."); // {§pinned-wording-core}
        const packet = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        assert.ok(packet);
        assert.equal(JSON.parse(packet.packet).assistant.content, content);
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: result.turnId });
        assert.equal(attempts[0]?.accepted, 1);
        const diagnostics = JSON.parse(attempts[0].parse_errors) as Array<{ message: string }>;
        assert.deepEqual(diagnostics, []);
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status, 102);
    } finally { await db.close(); }
});

test("{§send-premature-terminate} waiting cannot complete an empty join over a same-turn failed operation", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `join-failure-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "wait");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const result = await engine.runTurn({
            provider: new Mock({
                contextWindow: 100000,
                responses: [{
                    assistant: {
                        content: "",
                        reasoning: null,
                        ops: [
                            execStmt("unregistered-runtime", "build"),
                            dispositionStmt("WAIT", "awaiting the build"),
                        ],
                    },
                }],
            }),
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });

        assert.equal(result.status, 102, "the failed operation remains unobserved, so the turn continues");
        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 102, "the loop never records a false successful terminal");
        const rows = await db.test_log_sequencees_by_turn.all<{ status_rx: number; op: string }>({ turn_id: result.turnId });
        assert.ok((rows.find((row) => isExecutionOp(row.op))?.status_rx ?? 0) >= 400, "the original operation failure is preserved");
        assert.equal(rows.find((row) => row.op === "WAIT")?.status_rx, 102, "the failed result enters the next packet without an additional correction");
    } finally { await db.close(); }
});

test("{§send-premature-terminate} a successful same-turn scoped KILL continues an empty wait and permits explicit completion", async () => {
    const db = await openMigrated();
    try {
        const run = async (status: 200 | 202) => {
            const workspaceId = await insertWorkspace(db, `fold-disposition-${status}-${crypto.randomUUID()}`);
            const sessionId = await insertSession(db, workspaceId);
            const loopId = await insertLoop(db, sessionId, 1, "curate");
            await seedEntryWithChannel(db, {
                workspaceId,
                scheme: "workspace",
                pathname: "/notes.md",
                channel: "body",
                content: "context to curate",
                mimetype: "text/markdown",
                state: "static",
            });
            const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
            const primed = await engine.runTurn({
                provider: new Mock({
                    contextWindow: 100000,
                    responses: [{ assistant: { content: "", reasoning: null, ops: [readStmt(knownPath("/notes.md")), noteStmt("Continue.")] } }],
                }),
                workspaceId,
                sessionId,
                loopId,
                messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
            });
            const rows = await db.test_log_sequencees_by_turn.all<{ sequence: number; op: string }>({ turn_id: primed.turnId });
            const read = rows.find((row) => row.op === "READ");
            assert.ok(read, "the prior READ provides one open log row to curate");
            const primedTurn = await db.test_get_turn.get<{ sequence: number }>({ id: primed.turnId });
            assert.ok(primedTurn, "the model turn has a durable loop coordinate");
            const result = await engine.runTurn({
                provider: new Mock({
                    contextWindow: 100000,
                    responses: [{
                        assistant: {
                            content: "",
                            reasoning: null,
                            ops: [
                                killStmt(urlPath("log", `/1/${primedTurn.sequence}/${read.sequence}/READ`), { marks: [1, -1] }),
                                status === 202 ? dispositionStmt("WAIT", "continue after curation") : sendStmt(null, "curation complete"),
                            ],
                        },
                    }],
                }),
                workspaceId,
                sessionId,
                loopId,
                messages: [{ role: "system", content: "SD" }, { role: "user", content: "continue" }],
            });
            return { loopId, result };
        };

        const continued = await run(202);
        assert.equal(continued.result.status, 102, "log curation makes the next packet meaningful, so an empty wait continues");
        assert.equal(
            (await db.test_get_loop_status.get<{ status: number }>({ id: continued.loopId }))?.status,
            102,
            "the curated loop remains available for its next reasoning turn",
        );

        const concluded = await run(200);
        assert.equal(concluded.result.status, 102, "curation executes, but a progress SEND leaves the message unresolved");
    } finally { await db.close(); }
});

test("{§send-premature-terminate} a READ with a NOTE continues while its message remains unanswered", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `prem-read-ok-${crypto.randomUUID()}`);
        const parentSession = await insertSession(db, workspaceId);
        const parentLoop = await insertLoop(db, parentSession, 1, "parent");
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/config.json", channel: "body", content: '{"host":"db.internal"}', mimetype: "application/json", state: "static" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [readStmt(knownPath("/config.json")), noteStmt("Continue.")] } }] }),
            workspaceId, sessionId: parentSession, loopId: parentLoop,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(result.status, 102, "READ with a NOTE does not answer the assignment");
    } finally { await db.close(); }
});

test("{§completion-joins-live-work} a model declaring done with a live child parks on the first claim: no false 200, no spin", async () => {
    // The 200-vs-202 robustness: a model that declares done while its child works is joined to that
    // work — the loop parks and the wake brings the result — so it can never falsely complete, and it
    // never spins through turns claiming done.
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `prem-strike-${crypto.randomUUID()}`);
        const parentSession = await insertSession(db, workspaceId);
        const parentLoop = await insertLoop(db, parentSession, 1, "parent");
        // A persistently live child (its loop stays non-terminal through the parent's whole loop).
        const childSession = await insertSession(db, workspaceId, parentSession);
        await insertLoop(db, childSession, 1, "child");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: Array.from({ length: 6 }, () => ({ assistant: { content: "", reasoning: null, ops: [completeStmt("Complete.")] } })) });
        const result = await engine.runLoop({ provider, workspaceId, sessionId: parentSession, loopId: parentLoop, messages: [], maxTurns: 10, maxStrikes: 3 });
        assert.equal(result.result.status, 202, "the first claim joins the live child: the loop parks");
        assert.equal(provider.received.length, 1, "no further turn runs until the child concludes and wakes the loop");
        assert.notEqual(result.result.status, 200, "a model declaring done with work running NEVER gets a false 200");
    } finally { await db.close(); }
});

test("{§completion-defers-to-results} 499 is never gated by live work: it recursively cancels unresolved descendants", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `guard-499-${crypto.randomUUID()}`);
        const parentSession = await insertSession(db, workspaceId);
        const parentLoop = await insertLoop(db, parentSession, 1, "parent");
        const childSession = await insertSession(db, workspaceId, parentSession);
        const childLoop = await insertLoop(db, childSession, 1, "child"); // live child
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/config.json", channel: "body", content: '{"host":"x"}', mimetype: "application/json", state: "static" });
        const lifecycle = new LoopLifecycle(db);
        const engine = new Engine({
            db,
            schemes: new SchemeRegistry(),
            mimetypes: DEFAULT_MIMETYPES,
            cancelSession: async (root, reason) => { await lifecycle.cancelTree(root, reason, true); },
        });
        const parent = await db.envelope_get_session_by_id.get<{ name: string }>({ id: parentSession });
        assert.ok(parent);
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [killStmt({ ...urlPath("session", ""), hostname: parent.name, raw: `session://${parent.name}` })] } }] }),
            workspaceId, sessionId: parentSession, loopId: parentLoop,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(result.status, 499, "the abandon lands — live work never gates a 499 ({§completion-defers-to-results} defers only settled results)");
        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: parentLoop }))?.status;
        assert.equal(loopStatus, 499, "the loop is terminal");
        const childStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: childLoop }))?.status;
        assert.equal(childStatus, 499, "the unresolved child is cancelled with its abandoned parent scope");
        const rows = await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; origin: string }>({ turn_id: result.turnId });
        assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op, status_rx }) => [op, status_rx]), [["KILL", 200]],
            "cancellation is the actual KILL, not an invented failure operation");
    } finally { await db.close(); }
});
