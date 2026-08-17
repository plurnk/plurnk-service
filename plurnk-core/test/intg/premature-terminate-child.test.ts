// {§send-premature-terminate} extended to child workers — a SEND[200] while a spawned child is still
// live is premature exactly as a SEND[200] with an open stream is (children and streams are the same
// kind of "live thing the worker holds", {§worker-loop-lifecycle}). Engine-level A/B so it's race-free.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, seedEntryWithChannel, DEFAULT_MIMETYPES } from "./_helpers.ts";
import type { ParsedPath } from "@plurnk/plurnk-contracts";
import { execStmt, foldStmt, sendStmt, readStmt, urlPath } from "./_dsl.ts";

const knownPath = (pathname: string): ParsedPath => ({
    kind: "url", raw: `worker:///${pathname}`, scheme: "worker",
    username: null, password: null, hostname: null, port: null, pathname, query: null, fragment: null,
});

test("SEND[200] with a live child worker is refused 409 on the record (no erasure) + steers", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `prem-child-${crypto.randomUUID()}`);
        const parentWorker = await insertWorker(db, workspaceId);
        const parentLoop = await insertLoop(db, parentWorker, 1, "parent");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const send200 = () => engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] }),
            workspaceId, workerId: parentWorker, loopId: parentLoop,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });

        // Baseline: no child → SEND[200] is a clean terminal.
        const clean = await send200();
        assert.equal(clean.status, 200, "with no live child, SEND[200] terminates cleanly");
        assert.equal(clean.steerStruck, false);

        // Spawn a live child worker (parent_worker_id = parentWorker, a non-terminal loop — default status 102).
        const childWorker = await insertWorker(db, workspaceId, parentWorker);
        await insertLoop(db, childWorker, 1, "child");

        // Now SEND[200] is premature — the child is still a live thing the worker holds.
        const premature = await send200();
        assert.equal(premature.status, 102, "the TURN stays a continue (102) — the loop never went terminal");
        assert.equal(premature.steerStruck, true, "and the premature-terminate steer fired");

        // The record is faithful, NOT erased: the SEND row keeps its [200] emission but is stamped 409
        // (refused — Conflict), auto-surfacing in the errors section (status≥400). The old downgrade
        // rewrote the row to 102, erasing what the model did.
        const rows = await db.test_log_sequencees_by_turn.all<{ status_rx: number; op: string }>({ turn_id: premature.turnId });
        const sendRow = rows.find((r) => r.op === "SEND");
        assert.equal(sendRow?.status_rx, 409, "the SEND row records the refusal as 409, preserving the model's termination attempt");
    } finally { await db.close(); }
});

test("a CONCLUDED child carrying an inherited non-terminal loop does NOT block terminate (the fanout 508 bug)", async () => {
    // The fork-fanout failure: a fork inherits the parent's loops, so a child whose OWN (latest) loop
    // concluded at 200 still carried a frozen seq-1 loop at 102. The any-loop 409 gate read it as
    // forever-live and refused SEND[200] — while the child-orientation (latest-loop) showed nothing, so
    // the model was refused for a child it couldn't see and struck out at 508. The gate now uses the
    // SAME latest-loop definition as the orientation: a concluded child never blocks, inherited history
    // never counts. (Fork.fork also now clamps inherited loops terminal — this asserts the gate itself.)
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `prem-concluded-${crypto.randomUUID()}`);
        const parentWorker = await insertWorker(db, workspaceId);
        const parentLoop = await insertLoop(db, parentWorker, 1, "parent");
        const childWorker = await insertWorker(db, workspaceId, parentWorker);
        await insertLoop(db, childWorker, 1, "inherited");                       // seq 1 — frozen at 102 (inherited history)
        const ownLoop = await insertLoop(db, childWorker, 2, "own work");        // seq 2 — the child's actual loop
        await db.test_set_loop_status.run({
            id: ownLoop,
            status: 200,
            terminal_result: JSON.stringify({ status: 200 }),
        }); // it concluded

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] }),
            workspaceId, workerId: parentWorker, loopId: parentLoop,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(result.status, 200, "the child's LATEST loop is terminal → SEND[200] terminates cleanly, no false 409");
        assert.equal(result.steerStruck, false, "no premature-terminate strike for a concluded child");
    } finally { await db.close(); }
});

// The unified PENDING SET (grammar 0.75.0 / the terminal redesign): a [200] is judged at its own
// dispatch, post-batch — streams, live children, and this turn's retrievals are ONE rule.

test("READ + SEND[200] same turn is refused 409 — the pending set includes this turn's retrievals", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pend-read-${crypto.randomUUID()}`);
        const parentWorker = await insertWorker(db, workspaceId);
        const parentLoop = await insertLoop(db, parentWorker, 1, "parent");
        await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/config.json", channel: "body", content: '{"host":"db.internal"}', mimetype: "application/json", state: "static" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [readStmt(knownPath("/config.json")), sendStmt(200, null, "the host is db.internal")] } }] }),
            workspaceId, workerId: parentWorker, loopId: parentLoop,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(result.status, 102, "the turn stays a continue — the loop never went terminal");
        assert.equal(result.steerStruck, true, "the false terminal claim strikes while the turn still demotes");
        const rows = await db.test_log_sequencees_by_turn.all<{ status_rx: number; op: string }>({ turn_id: result.turnId });
        assert.equal(rows.find((r) => r.op === "SEND")?.status_rx, 409, "the SEND[200] row records the refusal as 409");
        // The STORED record agrees with the return (run20's T3 bug: the close persists the
        // provisional status pre-dispatch; the refusal must demote the row too, not just the return).
        const storedTurn = await db.test_get_turn.get<{ status: number }>({ id: result.turnId });
        assert.equal(storedTurn?.status, 102, "the persisted turns.status is demoted — the digest surface never lies");
    } finally { await db.close(); }
});

test("SEND[102] rejects a wait scope instead of preserving the retired dual spelling", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `park-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "wait");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const wait = { ...sendStmt(102, null, "standing by"), lineMarker: { marks: [-1] } };
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [wait] } }] }),
            workspaceId, workerId, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(result.status, 102, "the failed disposition leaves the loop available to observe and repair");
        assert.equal(loopStatus, 102, "the invalid wait never parks or concludes the loop");
        const row = await db.test_send_rows_for_worker.all<{ status_rx: number; rx: string }>({ worker_id: workerId });
        const rejected = row.find((r) => r.status_rx === 400);
        assert.ok(rejected, "the SEND records the contract failure");
        assert.match(rejected.rx, /## SEND0 \[202\].*wait/, "the failure points to the one wait spelling");
    } finally { await db.close(); }
});

test("SEND[202] cannot complete an empty join over a same-turn failed operation", async () => {
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
                            sendStmt(202, null, "awaiting the build"),
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
        assert.equal(result.steerStruck, true, "the false completion attempt is struck");
        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 102, "the loop never records a false successful terminal");
        const rows = await db.test_log_sequencees_by_turn.all<{ status_rx: number; op: string }>({ turn_id: result.turnId });
        assert.ok((rows.find((row) => row.op === "EXEC")?.status_rx ?? 0) >= 400, "the original operation failure is preserved");
        assert.equal(rows.find((row) => row.op === "SEND")?.status_rx, 409, "the empty-join completion is explicitly refused");
    } finally { await db.close(); }
});

test("a successful same-turn FOLD continues an empty SEND[202] without blocking explicit SEND[200] housekeeping", async () => {
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
                    responses: [{ assistant: { content: "", reasoning: null, ops: [readStmt(knownPath("/notes.md")), sendStmt(102)] } }],
                }),
                workspaceId,
                workerId,
                loopId,
                messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
            });
            const rows = await db.test_log_sequencees_by_turn.all<{ sequence: number; op: string }>({ turn_id: primed.turnId });
            const read = rows.find((row) => row.op === "READ");
            assert.ok(read, "the prior READ provides one open log row to curate");
            const result = await engine.runTurn({
                provider: new Mock({
                    contextWindow: 100000,
                    responses: [{
                        assistant: {
                            content: "",
                            reasoning: null,
                            ops: [
                                foldStmt(urlPath("log", `/1/1/${read.sequence}/READ`)),
                                sendStmt(status, null, status === 202 ? "continue after curation" : "curation complete"),
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
        assert.equal(continued.result.status, 102, "FOLD makes the next packet meaningful, so an empty wait continues");
        assert.equal(
            (await db.test_get_loop_status.get<{ status: number }>({ id: continued.loopId }))?.status,
            102,
            "the FOLDed loop remains available for its next reasoning turn",
        );
        assert.equal(continued.result.steerStruck, false, "the normalized continuation is not a model error");

        const concluded = await run(200);
        assert.equal(concluded.result.status, 200, "an explicit done claim may include final log housekeeping");
    } finally { await db.close(); }
});

test("a READ + non-terminal SEND[102] continue does not strike — the live-thing gate is [200]-only", async () => {
    // The correct shape stays clean: submit the READ, SEND[102] to receive it next turn. A continue is
    // never gated — only a terminal [200] over a live thing is.
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `prem-read-ok-${crypto.randomUUID()}`);
        const parentWorker = await insertWorker(db, workspaceId);
        const parentLoop = await insertLoop(db, parentWorker, 1, "parent");
        await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/config.json", channel: "body", content: '{"host":"db.internal"}', mimetype: "application/json", state: "static" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [readStmt(knownPath("/config.json")), sendStmt(102)] } }] }),
            workspaceId, workerId: parentWorker, loopId: parentLoop,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(result.steerStruck, false, "READ + SEND[102] does not strike — the rail gates only terminal [200]");
    } finally { await db.close(); }
});

test("a model that won't stop premature-200ing with a live child STRIKES OUT (500)", async () => {
    // The 200-vs-202 robustness: a confused model that keeps declaring done while its child workers is
    // not allowed to falsely complete — each premature 200 strikes, and it abandons at 500. It can't
    // hang the runtime, and it can't lie about being done.
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `prem-strike-${crypto.randomUUID()}`);
        const parentWorker = await insertWorker(db, workspaceId);
        const parentLoop = await insertLoop(db, parentWorker, 1, "parent");
        // A persistently live child (its loop stays non-terminal through the parent's whole loop).
        const childWorker = await insertWorker(db, workspaceId, parentWorker);
        await insertLoop(db, childWorker, 1, "child");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: Array.from({ length: 6 }, () => ({ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } })) });
        const result = await engine.runLoop({ provider, workspaceId, workerId: parentWorker, loopId: parentLoop, messages: [], maxTurns: 10, maxStrikes: 3 });
        // The engine rails abandon it: identical repeated premature-200 turns trip CYCLE detection (508)
        // before the plain strike threshold (500) — defense in depth. Either way the model is terminated
        // and never gets a false 200. The robustness guarantee: a confused model can't falsely complete
        // (no 200 terminal) and can't hang (it terminates), it just abandons via the rails.
        assert.ok([500, 508].includes(result.result.status), `premature-200 spammer abandons via the rails (500 strike / 508 cycle); got ${result.result.status}`);
        assert.notEqual(result.result.status, 200, "a model declaring done with work running NEVER gets a false 200");
    } finally { await db.close(); }
});

test("499 is never gated and recursively cancels unresolved descendants", async () => {
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
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [readStmt(knownPath("/config.json")), sendStmt(499, null, "abandoning")] } }] }),
            workspaceId, workerId: parentWorker, loopId: parentLoop,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(result.status, 499, "the abandon lands — pending work never gates a 499");
        assert.equal(result.steerStruck, false, "no strike for a legal abandon");
        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: parentLoop }))?.status;
        assert.equal(loopStatus, 499, "the loop is terminal");
        const childStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: childLoop }))?.status;
        assert.equal(childStatus, 499, "the unresolved child is cancelled with its abandoned parent scope");
    } finally { await db.close(); }
});


test("a retrieval-only refusal states the observation boundary, not a live-work remedy menu", async () => {
    // There is no lever to pull for a same-turn retrieval: the results arrive in the next
    // packet. The correction says exactly that; streams and children keep their remedy menu.
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `steer-ret-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/page.html", channel: "body", content: "<h1>Hi</h1>", mimetype: "text/html", state: "static" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [readStmt(knownPath("/page.html")), sendStmt(200, null, "the answer is Hi")] } }] }),
            workspaceId, workerId, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        const refusals = await db.test_send_rows_for_worker.all<{ rx: string; status_rx: number }>({ worker_id: workerId });
        const refused = refusals.find((r) => r.status_rx === 409);
        assert.ok(refused, "the retrieval gate refused");
        const problem = (JSON.parse(refused!.rx) as { problem?: Record<string, unknown> }).problem;
        assert.equal(problem?.type, "https://problems.plurnk.dev/engine/dispatcher/retrieval-results-unobserved");
        assert.equal(
            problem?.detail,
            "Last turn both performed retrieval operations and attempted to terminate. Retrieval operations force an additional turn so their results can be reviewed.",
        );
        assert.equal(problem?.recovery, "Review the results, then use only `# PLAN0` and `## SEND0 [200]` to conclude.");
        assert.equal(problem?.retryable, false);
        assert.doesNotMatch(refused!.rx, /KILL/, "no remedy menu for a leverless kind");
    } finally { await db.close(); }
});

test("retrieval-and-conclude strikes out even when changing targets avoids cycle detection", async () => {
    // Distinct targets keep cycle detection out of the result: this specimen proves the
    // observation-boundary rule itself stops a model that keeps doing READ + SEND[200].
    // plurnk.md already teaches the packet boundary, so every refused terminal strikes.
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
            responses: paths.map((pathname) => ({
                assistant: { content: "", reasoning: null, ops: [readStmt(knownPath(pathname)), sendStmt(200, null, `read ${pathname}`)] },
            })),
        });
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [], maxTurns: 10 });

        assert.equal(result.reason, "strike_threshold", "habitual retrieval-and-conclude ends through strike accounting");
        assert.equal(result.result.status, 500, "distinct targets prove the cycle detector was not the terminating rail");
        assert.equal(result.turnIds.length, 6, "the shipped six-strike threshold gives recovery room before abandonment");
        const refusals = await db.test_send_rows_for_worker.all<{ status_rx: number }>({ worker_id: workerId });
        assert.equal(refusals.filter((r) => r.status_rx === 409).length, 6, "all six conclude-attempts refused — patience never weakens the gate");
    } finally { await db.close(); }
});

test("a retrieval refusal grants no exemption from the ordinary idle-turn rail", async () => {
    // The next packet already contains the retrieval result and directs the model to review it
    // before concluding. PLAN + SEND[102] performs no work and remains an ordinary idle strike.
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `grace-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/page.html", channel: "body", content: "<h1>Hi</h1>", mimetype: "text/html", state: "static" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const planStmt = { op: "PLAN", annotation: null, suffix: "", signal: null, target: null, lineMarker: null, body: "waiting", position: { line: 1, column: 1 } } as const;
        const idle = () => ({ assistant: { content: "", reasoning: null, ops: [planStmt, sendStmt(102, null, "waiting")] } });
        const provider = new Mock({ contextWindow: 100000, responses: [
            { assistant: { content: "", reasoning: null, ops: [readStmt(knownPath("/page.html")), sendStmt(200, null, "Hi")] } },
            idle(), idle(), idle(), idle(),
        ] });
        for (let i = 0; i < 5; i++) {
            await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        }
        const errRows = await db.test_error_rows_for_worker.all<{ rx: string }>({ worker_id: workerId });
        const idleStrikes = errRows.filter((r) => /engine\/rail\/idle-turn/.test(r.rx)).length;
        assert.equal(idleStrikes, 4, "all four idle turns strike; the retrieval refusal creates no special rail state");
    } finally { await db.close(); }
});

test("a FAILED op row carries its failure message on its META LINE — the record states its why, folded or open", async () => {
    // The wildcard specimen: the refused SEND's rx held the steer, the row folded, and the model
    // theorized 'SEND[409] probably means bad request?' for 201s. The jumbo specimen: a minted
    // message-less item read as an "engine error" and bred a 10-turn phantom hunt. The rule now:
    // the op row IS the model's op result and self-explains — packet-wire projects its
    // Problem Details detail onto every meta line; the errors section is a terse pointer.
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `steer-meta-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/page.html", channel: "body", content: "<h1>Hi</h1>", mimetype: "text/html", state: "static" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [
                { assistant: { content: "", reasoning: null, ops: [readStmt(knownPath("/page.html")), sendStmt(200, null, "the answer is Hi")] } },
                { assistant: { content: "", reasoning: null, ops: [sendStmt(200, null, "done")] } },
            ] }),
            workspaceId, workerId, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        // The NEXT packet renders the refused SEND row with its steer ON the meta line.
        const t2 = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200, null, "done")] } }] }),
            workspaceId, workerId, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: t2.turnId }))!.packet) as { sections?: Array<{ name: string; content?: string }> };
        const log = packet.sections?.find((x) => x.name === "log")?.content ?? "";
        const metaLine = log.split("\n").find((l) => /"path":"log:\/\/\/[^"]+\/SEND"/.test(l) && l.includes('"status":409'));
        assert.ok(metaLine !== undefined, "the refused SEND row renders");
        assert.match(metaLine!, /"problem":\{[^}]*"detail":"Last turn both performed retrieval operations and attempted to terminate\./, "the exact Problem rides the META LINE - visible in every packet, never folded away");
        // And NO minted action_failure item exists — the row is the one record.
        const errs = await db.test_error_rows_for_worker.all<{ rx: string }>({ worker_id: workerId });
        assert.ok(!errs.some((e) => e.rx.includes("action_failure")), "no separate minted item — the op row is the model's op result");
    } finally { await db.close(); }
});
