// {§send-premature-terminate} extended to child workers — completion while a spawned child is still
// live is premature exactly as completion with an open stream is (children and streams are the same
// kind of "live thing the worker holds", {§worker-loop-lifecycle}). Engine-level A/B so it's race-free.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertOperationTurn, seedEntryWithChannel, DEFAULT_MIMETYPES } from "./_helpers.ts";
import type { ParsedPath } from "@plurnk/plurnk-contracts";
import { execStmt, killStmt, dispositionStmt, readStmt, sendStmt, urlPath } from "./_dsl.ts";
import { parseLogRecords } from "../LogRecords.ts";
import { isExecutionOp } from "@plurnk/plurnk-contracts";

const knownPath = (pathname: string): ParsedPath => ({
    kind: "url", raw: `worker:///${pathname}`, scheme: "worker",
    username: null, password: null, hostname: null, port: null, pathname, query: null, fragment: null,
});

test("{§completion-joins-live-work} completion with a live child worker joins it on the record (no erasure), never a strike", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `prem-child-${crypto.randomUUID()}`);
        const parentWorker = await insertWorker(db, workspaceId);
        const parentLoop = await insertLoop(db, parentWorker, 1, "parent");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const send200 = (loopId: number) => engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [dispositionStmt("completed")] } }] }),
            workspaceId, workerId: parentWorker, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });

        // Baseline: no child → completed inventory can conclude.
        const clean = await send200(parentLoop);
        assert.equal(clean.status, 200, "with no live child, completed inventory terminates cleanly");

        // Spawn a live child worker (parent_worker_id = parentWorker, a non-terminal loop — default status 102).
        const childWorker = await insertWorker(db, workspaceId, parentWorker);
        await insertLoop(db, childWorker, 1, "child");

        // Completion over a live child is a join ({§completion-joins-live-work}): the loop parks.
        const joiningLoop = await insertLoop(db, parentWorker, 2, "parent again");
        const premature = await send200(joiningLoop);
        assert.equal(premature.status, 202, "the completion joins the live child: the loop parks, it never went terminal");

        // The record is faithful, NOT erased: the TASK row keeps its completed inventory and is
        // stamped 202, the park, preserving the model's completion intent.
        const rows = await db.test_log_sequencees_by_turn.all<{ status_rx: number; op: string }>({ turn_id: premature.turnId });
        const sendRow = rows.find((r) => r.op === "TASK");
        assert.equal(sendRow?.status_rx, 202, "the TASK row records the join as 202, preserving the model's completion intent");
    } finally { await db.close(); }
});

test("an _plurnk administrative completion closes only its own loop while model work remains live", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `admin-terminal-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const modelLoopId = await insertLoop(db, workerId, 1, "model work");
        const childWorkerId = await insertWorker(db, workspaceId, workerId);
        const childLoopId = await insertLoop(db, childWorkerId, 1, "child work");
        const adminLoopId = await insertLoop(db, workerId, 2, "functionality materialization");
        const adminTurnId = await insertOperationTurn(db, adminLoopId, 1, "_plurnk", 102);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });

        const result = await engine.dispatch({
            statement: dispositionStmt("completed"),
            workspaceId,
            workerId,
            loopId: adminLoopId,
            turnId: adminTurnId,
            sequence: 1,
            origin: "_plurnk",
        });

        assert.equal(result.status, 200, "the maintenance transaction concludes despite unrelated pending model work");
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: adminLoopId }))?.status, 200, "the administrative loop closes");
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: modelLoopId }))?.status, 102, "the model loop remains live");
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: childLoopId }))?.status, 102, "the child obligation remains live");
    } finally { await db.close(); }
});

test("a newer terminal loop cannot mask a child's older unresolved work", async () => {
    // A real fork clamps inherited loops terminal before creating its own work.
    // This deliberately inconsistent fixture proves that every unresolved loop
    // remains a live obligation regardless of newer history.
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `prem-concluded-${crypto.randomUUID()}`);
        const parentWorker = await insertWorker(db, workspaceId);
        const parentLoop = await insertLoop(db, parentWorker, 1, "parent");
        const childWorker = await insertWorker(db, workspaceId, parentWorker);
        const unresolvedLoop = await insertLoop(db, childWorker, 1, "unresolved");
        const ownLoop = await insertLoop(db, childWorker, 2, "own work");        // seq 2 — the child's actual loop
        await db.test_set_loop_status.run({
            id: ownLoop,
            status: 200,
            terminal_result: JSON.stringify({ status: 200 }),
        }); // it concluded

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const refused = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [dispositionStmt("completed")] } }] }),
            workspaceId, workerId: parentWorker, loopId: parentLoop,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(refused.status, 202, "the older unresolved loop keeps the child live: the completion joins it");

        await db.test_set_loop_status.run({
            id: unresolvedLoop,
            status: 200,
            terminal_result: JSON.stringify({ status: 200 }),
        });
        const completed = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [dispositionStmt("completed")] } }] }),
            workspaceId, workerId: parentWorker, loopId: parentLoop,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(completed.status, 200, "completion succeeds only after every child loop is terminal");
    } finally { await db.close(); }
});

// The unified PENDING SET (grammar 0.75.0 / the terminal redesign): a [200] is judged at its own
// dispatch, post-batch — streams, live children, and this turn's retrievals are ONE rule.

test("{§completion-defers-to-results}: READ + completed inventory in the same turn is deferred — the pending set includes this turn's retrievals", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pend-read-${crypto.randomUUID()}`);
        const parentWorker = await insertWorker(db, workspaceId);
        const parentLoop = await insertLoop(db, parentWorker, 1, "parent");
        await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/config.json", channel: "body", content: '{"host":"db.internal"}', mimetype: "application/json", state: "static" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [readStmt(knownPath("/config.json")), dispositionStmt("completed", "the host is db.internal")] } }] }),
            workspaceId, workerId: parentWorker, loopId: parentLoop,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(result.status, 102, "the turn stays a continue — the loop never went terminal");
        const rows = await db.test_log_sequencees_by_turn.all<{ status_rx: number; op: string }>({ turn_id: result.turnId });
        assert.equal(rows.find((r) => r.op === "TASK")?.status_rx, 102, "the TASK row records the deferral");
        // The STORED record agrees with the return (run20's T3 bug: the close persists the
        // provisional status pre-dispatch; the refusal must demote the row too, not just the return).
        const storedTurn = await db.test_get_turn.get<{ status: number }>({ id: result.turnId });
        assert.equal(storedTurn?.status, 102, "the persisted turns.status is demoted — the digest surface never lies");
    } finally { await db.close(); }
});

test("a direct actionable TASK ignores wait timing with factual feedback", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `park-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "wait");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const wait = { ...dispositionStmt("in_progress", "standing by"), lineMarker: { marks: [-1] } };
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [wait] } }] }),
            workspaceId, workerId, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(result.status, 102);
        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 102, "timing never overrides the actionable inventory");
        const row = await db.test_disposition_rows_for_worker.all<{ status_rx: number; rx: string }>({ worker_id: workerId });
        assert.equal(row.length, 1);
        assert.equal(row[0].status_rx, 102);
        assert.equal(JSON.parse(row[0].rx).detail, "Wait timing was not applied because no waiting intent was selected.");
    } finally { await db.close(); }
});

test("model actionable TASK with timing retains valid work and reports unapplied timing", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `next-scope-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "read the note");
        await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/note.txt", channel: "body", content: "the note", mimetype: "text/plain", state: "static" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const content = "```READ (worker:///note.txt)```\n```TASK <-1>\n[{\"content\":\"standing by\",\"status\":\"in_progress\"}]\n```";
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content, reasoning: null } }] }),
            workspaceId, workerId, loopId,
            messages: [{ role: "user", content: "read the note" }],
        });
        assert.equal(result.status, 102);
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; status_rx: number; rx: string }>({ turn_id: result.turnId });
        assert.equal(rows.find(({ op }) => op === "READ")?.status_rx, 200, "the valid sibling executes");
        assert.equal(rows.some(({ op }) => op === "error"), false);
        const task = rows.find(({ op }) => op === "TASK");
        assert.equal(task?.status_rx, 102);
        assert.equal(JSON.parse(task!.rx).detail, "Wait timing was not applied because no waiting intent was selected.");
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: result.turnId });
        assert.equal(attempts[0]?.accepted, 1);
        const diagnostics = JSON.parse(attempts[0]!.parse_errors) as Array<{ message: string }>;
        assert.deepEqual(diagnostics, []);
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status, 102);
    } finally { await db.close(); }
});

test("waiting cannot complete an empty join over a same-turn failed operation", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `join-failure-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "wait");
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
                            dispositionStmt("waiting", "awaiting the build"),
                        ],
                    },
                }],
            }),
            workspaceId,
            workerId,
            loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });

        assert.equal(result.status, 102, "the failed operation remains unobserved, so the turn continues");
        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 102, "the loop never records a false successful terminal");
        const rows = await db.test_log_sequencees_by_turn.all<{ status_rx: number; op: string }>({ turn_id: result.turnId });
        assert.ok((rows.find((row) => isExecutionOp(row.op))?.status_rx ?? 0) >= 400, "the original operation failure is preserved");
        assert.equal(rows.find((row) => row.op === "TASK")?.status_rx, 102, "the failed result enters the next packet without an additional correction");
    } finally { await db.close(); }
});

test("a successful same-turn scoped KILL continues an empty wait and permits explicit completion", async () => {
    const db = await openMigrated();
    try {
        const run = async (status: 200 | 202) => {
            const workspaceId = await insertWorkspace(db, `fold-disposition-${status}-${crypto.randomUUID()}`);
            const workerId = await insertWorker(db, workspaceId);
            const loopId = await insertLoop(db, workerId, 1, "curate");
            await seedEntryWithChannel(db, {
                workspaceId,
                scheme: "worker",
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
                    responses: [{ assistant: { content: "", reasoning: null, ops: [readStmt(knownPath("/notes.md")), dispositionStmt("in_progress")] } }],
                }),
                workspaceId,
                workerId,
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
                                dispositionStmt(status === 202 ? "waiting" : "completed", status === 202 ? "continue after curation" : "curation complete"),
                            ],
                        },
                    }],
                }),
                workspaceId,
                workerId,
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
        assert.equal(concluded.result.status, 200, "log curation is permitted in a completion turn");
    } finally { await db.close(); }
});

test("a READ with in_progress TASK inventory continues without a completion strike", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `prem-read-ok-${crypto.randomUUID()}`);
        const parentWorker = await insertWorker(db, workspaceId);
        const parentLoop = await insertLoop(db, parentWorker, 1, "parent");
        await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/config.json", channel: "body", content: '{"host":"db.internal"}', mimetype: "application/json", state: "static" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [readStmt(knownPath("/config.json")), dispositionStmt("in_progress")] } }] }),
            workspaceId, workerId: parentWorker, loopId: parentLoop,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(result.status, 102, "READ with an in_progress inventory continues; no completion is claimed");
    } finally { await db.close(); }
});

test("{§completion-joins-live-work} a model declaring done with a live child parks on the first claim: no false 200, no spin", async () => {
    // The 200-vs-202 robustness: a model that declares done while its child works is joined to that
    // work — the loop parks and the wake brings the result — so it can never falsely complete, and it
    // never spins through turns claiming done.
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `prem-strike-${crypto.randomUUID()}`);
        const parentWorker = await insertWorker(db, workspaceId);
        const parentLoop = await insertLoop(db, parentWorker, 1, "parent");
        // A persistently live child (its loop stays non-terminal through the parent's whole loop).
        const childWorker = await insertWorker(db, workspaceId, parentWorker);
        await insertLoop(db, childWorker, 1, "child");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: Array.from({ length: 6 }, () => ({ assistant: { content: "", reasoning: null, ops: [dispositionStmt("completed")] } })) });
        const result = await engine.runLoop({ provider, workspaceId, workerId: parentWorker, loopId: parentLoop, messages: [], maxTurns: 10, maxStrikes: 3 });
        assert.equal(result.result.status, 202, "the first claim joins the live child: the loop parks");
        assert.equal(provider.received.length, 1, "no further turn runs until the child concludes and wakes the loop");
        assert.notEqual(result.result.status, 200, "a model declaring done with work running NEVER gets a false 200");
    } finally { await db.close(); }
});

test("499 is never gated by live work: it recursively cancels unresolved descendants", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `guard-499-${crypto.randomUUID()}`);
        const parentWorker = await insertWorker(db, workspaceId);
        const parentLoop = await insertLoop(db, parentWorker, 1, "parent");
        const childWorker = await insertWorker(db, workspaceId, parentWorker);
        const childLoop = await insertLoop(db, childWorker, 1, "child"); // live child
        await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/config.json", channel: "body", content: '{"host":"x"}', mimetype: "application/json", state: "static" });
        const lifecycle = new LoopLifecycle(db);
        const engine = new Engine({
            db,
            schemes: new SchemeRegistry(),
            mimetypes: DEFAULT_MIMETYPES,
            cancelDescendants: async (root, reason) => { await lifecycle.cancelTree(root, reason, false); },
        });
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [dispositionStmt("failed", "abandoning")] } }] }),
            workspaceId, workerId: parentWorker, loopId: parentLoop,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(result.status, 499, "the abandon lands — live work never gates a 499 ({§completion-defers-to-results} defers only settled results)");
        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: parentLoop }))?.status;
        assert.equal(loopStatus, 499, "the loop is terminal");
        const childStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: childLoop }))?.status;
        assert.equal(childStatus, 499, "the unresolved child is cancelled with its abandoned parent scope");
        const sends = await db.test_disposition_rows_for_worker.all<{ rx: string; status_rx: number }>({ worker_id: parentWorker });
        const abandoned = sends.find(({ status_rx }) => status_rx === 499);
        assert.ok(abandoned);
        const problem = (JSON.parse(abandoned.rx) as { problem?: Record<string, unknown> }).problem;
        assert.equal(problem?.detail, "All tasks in the final inventory failed.");
        assert.equal(problem?.reason, "abandoning");
        assert.doesNotMatch(String(problem?.detail), /abandoning/, "the authored SEND body is not duplicated into Problem prose");
    } finally { await db.close(); }
});


test("{§completion-defers-to-results}: a retrieval-only deferral states the observation boundary, not a live-work remedy menu", async () => {
    // Name the actual observation boundary without a remedy menu.
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `steer-ret-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/page.html", channel: "body", content: "<h1>Hi</h1>", mimetype: "text/html", state: "static" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [readStmt(knownPath("/page.html")), dispositionStmt("completed", "the answer is Hi")] } }] }),
            workspaceId, workerId, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        const rows = await db.test_disposition_rows_for_worker.all<{ rx: string; status_rx: number }>({ worker_id: workerId });
        const deferred = rows.find((r) => r.status_rx === 102);
        assert.ok(deferred, "the retrieval gate deferred");
        const deferral = JSON.parse(deferred!.rx) as { problem?: unknown; detail?: string; attrs?: { pending?: string[] }; recovery?: unknown };
        assert.equal(deferral.problem, undefined, "a deferral carries no Problem and no strike");
        assert.equal(
            deferral.detail,
            "Completion deferred until READ reached a packet. It is in this packet; a TASK now completes.",
        );
        assert.deepEqual(deferral.attrs?.pending, ["receipts"]);
        assert.equal(deferral.recovery, undefined);
        assert.doesNotMatch(deferred!.rx, /KILL/, "no remedy menu for a leverless kind");
    } finally { await db.close(); }
});

for (const statuses of [["completed"], ["failed", "completed"]] as const) {
    test(`{§completion-defers-to-results}: ${statuses.join(" + ")} beside new work each turn defers each turn and completes once the claim stands alone`, async () => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `preemie-${crypto.randomUUID()}`);
            const workerId = await insertWorker(db, workspaceId);
            const loopId = await insertLoop(db, workerId, 1, "go");
            const paths = Array.from({ length: 10 }, (_, index) => `/page-${index}.html`);
            for (const pathname of paths) {
                await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname, channel: "body", content: `<h1>${pathname}</h1>`, mimetype: "text/html", state: "static" });
            }
            const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
            const provider = new Mock({
                contextWindow: 100000,
                responses: [
                    ...paths.map((pathname) => ({
                        assistant: { content: "", reasoning: null, ops: [
                            readStmt(knownPath(pathname)), sendStmt(null, `read ${pathname}`),
                            { ...dispositionStmt("completed"), body: statuses.map((status) => ({ content: `read ${pathname}`, status })) },
                        ] },
                    })),
                    { assistant: { content: "", reasoning: null, ops: [
                        sendStmt(null, "read them all"),
                        { ...dispositionStmt("completed"), body: statuses.map((status) => ({ content: "read them all", status })) },
                    ] } },
                ],
            });
            const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [], maxTurns: 11, maxStrikes: 1 });

            assert.equal(result.result.status, 200, "ten deferrals never struck: at one strike any refusal would have ended the loop");
            assert.equal(result.result.content, "read them all", "the last delivered message is the response; the deferred turns' messages stay log rows");
            assert.equal(result.turnIds.length, 12, "initialization, ten deferred claims, and the accepted conclusion form the chronology");
            const rows = await db.test_disposition_rows_for_worker.all<{ status_rx: number }>({ worker_id: workerId });
            assert.deepEqual(rows.map((r) => r.status_rx), [...Array.from({ length: 10 }, () => 102), 200], "every early claim is a deferral, never a refusal");
        } finally { await db.close(); }
    });
}

test("{§inventory-only-turn} a retrieval deferral does not make subsequent inventory-only turns invalid", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `grace-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/page.html", channel: "body", content: "<h1>Hi</h1>", mimetype: "text/html", state: "static" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const idle = () => ({ assistant: { content: "", reasoning: null, ops: [dispositionStmt("in_progress", "Wait for the retrieval result.")] } });
        const provider = new Mock({ contextWindow: 100000, responses: [
            { assistant: { content: "", reasoning: null, ops: [readStmt(knownPath("/page.html")), dispositionStmt("completed", "Hi")] } },
            idle(), idle(), idle(), idle(),
        ] });
        for (let i = 0; i < 5; i++) {
            const turn = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
            assert.equal(turn.status, 102);
        }
        const errRows = await db.test_error_rows_for_worker.all<{ rx: string }>({ worker_id: workerId });
        const idleStrikes = errRows.filter((r) => /engine\/rail\/idle-turn/.test(r.rx)).length;
        assert.equal(idleStrikes, 0, "no operationless-turn error is manufactured");
        const rows = await db.test_disposition_rows_for_worker.all<{ status_rx: number }>({ worker_id: workerId });
        assert.deepEqual(rows.map(({ status_rx }) => status_rx), [102, 102, 102, 102, 102]);
    } finally { await db.close(); }
});

test("a deferred TASK row carries its deferral detail on its META LINE — the record states its why, suppressed or visible", async () => {
    // {§log-row-self-explains}: a row's why stays on its metadata line even when its body is
    // suppressed; a deferral's detail rides there exactly as a Problem would.
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `steer-meta-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/page.html", channel: "body", content: "<h1>Hi</h1>", mimetype: "text/html", state: "static" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [
                { assistant: { content: "", reasoning: null, ops: [readStmt(knownPath("/page.html")), dispositionStmt("completed", "the answer is Hi")] } },
                { assistant: { content: "", reasoning: null, ops: [dispositionStmt("completed", "done")] } },
            ] }),
            workspaceId, workerId, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        // The next packet renders the deferred TASK row with its detail on the metadata line.
        const t2 = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [dispositionStmt("completed", "done")] } }] }),
            workspaceId, workerId, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: t2.turnId }))!.packet) as { sections?: Array<{ name: string; content?: string }> };
        const log = packet.sections?.find((x) => x.name === "log")?.content ?? "";
        const inventory = parseLogRecords(log).find((record) => typeof record.path === "string" && record.path.endsWith("/TASK")
            && record.status === 102 && typeof (record as { detail?: unknown }).detail === "string");
        assert.ok(inventory !== undefined, "the deferred TASK row renders");
        assert.equal((inventory as { detail?: string }).detail, "Completion deferred until READ reached a packet. It is in this packet; a TASK now completes.", "the compact detail rides the metadata line - visible in every packet, never hidden with the body");
        assert.equal((inventory as { problem?: unknown }).problem, undefined, "a deferral carries no Problem");
        // And NO minted action_failure item exists — the row is the one record.
        const errs = await db.test_error_rows_for_worker.all<{ rx: string }>({ worker_id: workerId });
        assert.ok(!errs.some((e) => e.rx.includes("action_failure")), "no separate minted item — the op row is the model's op result");
    } finally { await db.close(); }
});
