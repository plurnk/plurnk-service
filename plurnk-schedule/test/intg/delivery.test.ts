import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { Mock } from "@plurnk/plurnk-providers";
import { testArtifactDirectory } from "../../../scripts/lib/test-artifacts.ts";
import Module from "../../src/Module.ts";
import type { SchedulerTimers } from "../../src/Scheduler.ts";

// {§schedule-delivery} — the module inside a real daemon: a session adds a rule through the family
// action, the occurrence fires, and the target session's log carries the message as an arrival row
// from `schedule://<alias>` ({§message-arrival}); the family's list names the next occurrence.

const SERVICE = resolve(import.meta.dirname, "../../../plurnk-core");
const NOW = Date.UTC(2026, 8, 16, 12, 30, 15, 250);
const FIRST = Date.UTC(2026, 8, 16, 12, 30, 16);

interface LogRow { readonly op: string; readonly origin: string; readonly source: string | null; readonly attrs: string }

const assertDelivery = async (sessionName: string): Promise<void> => {
    await import(join(SERVICE, "test/setup.ts"));
    const [{ default: Daemon }, { makeMockResponse }, { openMigrated, insertWorkspace, insertSession, rootWorkspace }] = await Promise.all([
        import(join(SERVICE, "src/server/Daemon.ts")),
        import(join(SERVICE, "test/intg/_mock.ts")),
        import(join(SERVICE, "test/intg/_db.ts")),
    ]);
    const provider = new Mock({
        contextWindow: 32768,
        responses: [makeMockResponse("await plurnk.send({\"text\":\"Beat taken.\"});", 10)],
    });
    // {§test-artifact-retention} — this lane's run directory, beside every other harness's.
    const db = await openMigrated(join(await testArtifactDirectory("schedule"), `db-${crypto.randomUUID()}.db`));
    const root = await mkdtemp(join(tmpdir(), "plurnk-schedule-"));
    const workspaceId = await insertWorkspace(db, "scheduled");
    await rootWorkspace(db, workspaceId, root);
    const sessionId = await insertSession(db, workspaceId, null, sessionName, "model");

    let now = NOW;
    const armed = new Map<number, () => void>();
    let nextTimer = 1;
    const timers: SchedulerTimers = {
        set: (callback) => { const id = nextTimer++; armed.set(id, callback); return id; },
        clear: (id) => { armed.delete(id as number); },
    };
    const module = Module.init({ env: { ...process.env, TZ: "UTC", PLURNK_SCHEDULE_ENABLED: "1" }, clock: () => now, timers });
    let port: ApplicationPort | null = null;
    const daemon = new Daemon({ db, provider, nodeModulesPath: join(SERVICE, "node_modules") });
    daemon.registerModule({
        setup: (seam: Parameters<Module["setup"]>[0]) => { module.setup(seam); },
        start: async (seam: ApplicationPort) => { port = seam; await module.start(seam); },
        stop: () => module.stop(),
    }, "@plurnk/plurnk-schedule");
    await daemon.start();
    try {
        const application = port as unknown as ApplicationPort;
        const terminated = new Promise<void>((resolveTerminated) => {
            application.subscribeToEvents((_workspaceId, method) => { if (method === "loop/terminated") resolveTerminated(); });
        });
        const added = await application.invokeModuleAction("workspace.schedule.add", {
            alias: "beat",
            rule: "FREQ=HOURLY;COUNT=2",
            target: `session://${sessionName}`,
            prompt: "Take the beat.",
        }, { scope: "workspace", workspaceId }) as { status: number; alias: string; definition?: { state: string; detail?: { next: string | null; rule: string } } };
        assert.equal(added.status, 201);
        assert.equal(added.alias, "beat");
        assert.equal(added.definition?.state, "active");
        assert.equal(added.definition?.detail?.rule, "DTSTART;TZID=UTC:20260916T123016\nRRULE:FREQ=HOURLY;COUNT=2", "the stored rule is canonical");
        assert.equal(added.definition?.detail?.next, "2026-09-16T12:30:16+00:00[UTC]");
        assert.equal(armed.size, 1, "one occurrence armed");

        now = FIRST;
        for (const callback of [...armed.values()]) callback();
        await terminated;

        const rows = await db.test_log_entries_by_loop.all({ loop_id: (await db.test_all_loops.all() as Array<{ id: number; session_id: number }>).find((loop) => loop.session_id === sessionId)!.id }) as LogRow[];
        const arrivals = rows.filter((row) => row.op === "send" && row.origin === "_plurnk" && (JSON.parse(row.attrs) as { kind?: string }).kind === "message");
        assert.equal(arrivals.length, 1, "the delivery published exactly one arrival row");
        assert.equal(arrivals[0].source, "schedule://beat", "the arrival names the schedule as its causal source");

        const deadline = Date.now() + 10_000;
        let next: string | null | undefined;
        while (Date.now() < deadline) {
            const listing = await application.invokeModuleAction("workspace.schedule.list", {}, { scope: "workspace", workspaceId }) as { definitions: Array<{ alias: string; detail?: { next: string | null } }> };
            next = listing.definitions.find(({ alias }) => alias === "beat")?.detail?.next;
            if (next === "2026-09-16T13:30:16+00:00[UTC]") break;
            await sleep(50);
        }
        assert.equal(next, "2026-09-16T13:30:16+00:00[UTC]", "after the fire the family lists the following occurrence");
    } finally {
        await daemon.stop();
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
};

for (const sessionName of ["recipient", "Approach_A"]) {
    test(`{§schedule-delivery} a scheduled message reaches ${sessionName} as an arrival from schedule://<alias>`, { timeout: 60_000 }, async () => {
        await assertDelivery(sessionName);
    });
}

test("{§schedule-delivery} {§schedule-rule} {§functionality-model-projection} structured run arrays, manual/once rules, turn-only verb refusal, step receipts, inspection hint, and review-mode consent gate", { timeout: 60_000 }, async () => {
    await import(join(SERVICE, "test/setup.ts"));
    const [{ default: Daemon }, { makeMockResponse }, { openMigrated, insertWorkspace, insertSession, rootWorkspace }] = await Promise.all([
        import(join(SERVICE, "src/server/Daemon.ts")),
        import(join(SERVICE, "test/intg/_mock.ts")),
        import(join(SERVICE, "test/intg/_db.ts")),
    ]);
    const provider = new Mock({
        contextWindow: 32768,
        responses: [makeMockResponse("await plurnk.done({\"text\":\"Auto-created session completed.\"});", 10)],
    });
    const db = await openMigrated(join(await testArtifactDirectory("schedule"), `db-${crypto.randomUUID()}.db`));
    const root = await mkdtemp(join(tmpdir(), "plurnk-schedule-run-"));
    const workspaceId = await insertWorkspace(db, "scheduled-run");
    await rootWorkspace(db, workspaceId, root);

    let now = NOW;
    const armed = new Map<number, () => void>();
    let nextTimer = 1;
    const timers: SchedulerTimers = {
        set: (callback) => { const id = nextTimer++; armed.set(id, callback); return id; },
        clear: (id) => { armed.delete(id as number); },
    };
    const module = Module.init({ env: { ...process.env, TZ: "UTC", PLURNK_SCHEDULE_ENABLED: "1" }, clock: () => now, timers });
    let port: ApplicationPort | null = null;
    const daemon = new Daemon({ db, provider, nodeModulesPath: join(SERVICE, "node_modules") });
    daemon.registerModule({
        setup: (seam: Parameters<Module["setup"]>[0]) => { module.setup(seam); },
        start: async (seam: ApplicationPort) => { port = seam; await module.start(seam); },
        stop: () => module.stop(),
    }, "@plurnk/plurnk-schedule");
    await daemon.start();
    try {
        const application = port as unknown as ApplicationPort;

        // 1. Malformed calls and turn-only verbs (`done`, `fail`, `wait`, `question`, `kill log:///...`) are refused at admission with `400 run-invalid`!
        for (const badCall of [
            { server: "plurnk", tool: "done", arguments: { text: "stop" } },
            { server: "plurnk", tool: "fail", arguments: { text: "boom" } },
            { server: "plurnk", tool: "wait", arguments: {} },
            { server: "plurnk", tool: "question", arguments: { message: "ask?" } },
            { server: "plurnk", tool: "kill", arguments: { path: "log:///1/1/1" } },
            { server: "plurnk", tool: "nonexistent_tool", arguments: {} },
        ]) {
            await assert.rejects(
                () => application.invokeModuleAction("workspace.schedule.add", {
                    alias: "bad-script",
                    rule: "manual",
                    run: [badCall],
                }, { scope: "workspace", workspaceId }),
                (err: unknown) => {
                    const problem = (err as { result?: { problem?: { status?: number; type?: string } }; problem?: { status?: number; type?: string } });
                    const p = problem?.result?.problem ?? problem?.problem;
                    return p?.status === 400 && Boolean(p.type?.endsWith("/run-invalid"));
                },
                `admission refuses ${badCall.server}.${badCall.tool} with 400 run-invalid`,
            );
        }

        // 2. One-shot `+1s` scripted action executes deterministically in `_plurnk` with 0 provider calls and settles to `done`!
        const addedScript = await application.invokeModuleAction("workspace.schedule.add", {
            alias: "stamp",
            rule: "+1s",
            run: [
                { server: "plurnk", tool: "edit", arguments: { path: "workspace:///stamped.txt", content: "ok-from-schedule" } },
            ],
        }, { scope: "workspace", workspaceId }) as { status: number; definition?: { detail?: { status: string; kind: string } } };
        assert.equal(addedScript.status, 201);
        assert.equal(addedScript.definition?.detail?.status, "open");
        assert.equal(addedScript.definition?.detail?.kind, "run");

        now = NOW + 2_000;
        for (const callback of [...armed.values()]) callback();

        const deadline = Date.now() + 10_000;
        let scriptStatus: string | undefined;
        while (Date.now() < deadline) {
            const listing = await application.invokeModuleAction("workspace.schedule.list", {}, { scope: "workspace", workspaceId }) as {
                definitions: Array<{ alias: string; detail?: { status: string } }>;
            };
            scriptStatus = listing.definitions.find(({ alias }) => alias === "stamp")?.detail?.status;
            if (scriptStatus === "done") break;
            await sleep(25);
        }
        assert.equal(scriptStatus, "done", "one-shot scripted obligation transitions to done and stays visible");
        assert.equal(provider.received.length, 0, "scripted schedule used zero model inference");
        const runtimeId = await application.ensureRuntimeSession(workspaceId);
        const entryRead = await application.readEntry({ workspaceId, sessionId: runtimeId, target: "workspace:///stamped.txt" });
        assert.equal(entryRead.status, 200);
        if (entryRead.status === 200 && entryRead.entry !== null) {
            assert.equal(entryRead.entry.channels.body?.content, "ok-from-schedule");
        }

        // 3. Reusable `"manual"` multi-step script (default when `rule` omitted) runs `edit` -> `sh` -> `read`, returns per-step receipts with URIs & previews, stays `open`, and re-runs!
        const manualAdded = await application.invokeModuleAction("workspace.schedule.add", {
            alias: "check-flow",
            run: [
                { server: "plurnk", tool: "edit", arguments: { path: "workspace:///flow.txt", range: "1,-1", content: "alpha-step" } },
                { server: "sh", tool: "sh", arguments: { command: "echo shell-step-ok" } },
                { server: "plurnk", tool: "read", arguments: { path: "workspace:///flow.txt" } },
            ],
        }, { scope: "workspace", workspaceId }) as { status: number; definition?: { definition?: { rule?: string }; detail?: { rule?: string; status?: string } } };
        assert.equal(manualAdded.status, 201);
        assert.equal(manualAdded.definition?.definition?.rule, "manual");
        assert.equal(manualAdded.definition?.detail?.rule, "manual");
        assert.equal(manualAdded.definition?.detail?.status, "open");

        const firstManualRun = await application.invokeModuleAction("workspace.schedule.run", { alias: "check-flow" }, { scope: "workspace", workspaceId }) as {
            alias: string;
            status: string;
            loopId: number | null;
            doneAt: string | null;
            results?: Array<{ index: number; server: string; tool: string; status: number; uri?: string; preview?: string }>;
        };
        assert.equal(firstManualRun.status, "open");
        assert.equal(firstManualRun.doneAt, null);
        assert.equal(typeof firstManualRun.loopId, "number");
        assert.equal(firstManualRun.results?.length, 3);
        assert.equal(firstManualRun.results?.[0]?.status, 201);
        assert.match(firstManualRun.results?.[0]?.uri ?? "", /^log:\/\/\/\d+\/\d+\/\d+\/edit$/u);
        assert.equal(firstManualRun.results?.[1]?.status, 200);
        assert.match(firstManualRun.results?.[1]?.uri ?? "", /^exec:\/\/\/sh\//u);
        assert.match(firstManualRun.results?.[1]?.preview ?? "", /shell-step-ok/u);
        assert.equal(firstManualRun.results?.[2]?.status, 200);
        assert.match(firstManualRun.results?.[2]?.preview ?? "", /alpha-step/u);

        const secondManualRun = await application.invokeModuleAction("workspace.schedule.run", { alias: "check-flow" }, { scope: "workspace", workspaceId }) as { status: string; results?: Array<{ status: number }> };
        assert.equal(secondManualRun.status, "open");
        assert.equal(secondManualRun.results?.length, 3);
        assert.equal(secondManualRun.results?.[0]?.status, 304);
        assert.equal(provider.received.length, 0, "manual multi-step script used zero model inference");

        // 3b. Fail-fast on failing step: step 0 returns 404 -> step 1 never executes, error carries step 0 receipt.
        await application.invokeModuleAction("workspace.schedule.add", {
            alias: "fail-fast",
            run: [
                { server: "plurnk", tool: "read", arguments: { path: "workspace:///does-not-exist.txt" } },
                { server: "plurnk", tool: "edit", arguments: { path: "workspace:///never-created.txt", content: "should-not-run" } },
            ],
        }, { scope: "workspace", workspaceId });
        await assert.rejects(
            () => application.invokeModuleAction("workspace.schedule.run", { alias: "fail-fast" }, { scope: "workspace", workspaceId }),
            (err: unknown) => {
                const p = (err as { problem?: { status?: number; step?: number; results?: Array<{ index: number; status: number }> } })?.problem;
                return p?.status === 404 && p?.step === 0 && p?.results?.length === 1 && p.results[0].status === 404;
            },
            "failing step halts script execution and reports collected step receipts",
        );
        const neverCreated = await application.readEntry({ workspaceId, sessionId: runtimeId, target: "workspace:///never-created.txt" });
        assert.equal(neverCreated.status, 404, "step after failure never executed");

        // 4. Bare `{ alias }` inspection runs as read (no proposal in review mode) with `executed: false` + `hint`, while scripted `add` and `trigger: true` both require host consent in review mode!
        const reviewerSessionId = await insertSession(db, workspaceId, null, "reviewer", "model");
        await application.setWorkspaceProposalPolicy({ workspaceId, policy: "review" });
        const pendingProposals: Array<{ proposalId: number }> = [];
        const unsubProposals = application.subscribeToEvents((_ws, method, params) => {
            if (method === "loop/proposal" && typeof (params as { proposalId?: unknown })?.proposalId === "number") {
                pendingProposals.push({ proposalId: (params as { proposalId: number }).proposalId });
            }
        }, { workspaceId });
        try {
            const { PlurnkParser } = await import("@plurnk/plurnk-parser");
            const manager = daemon.engine.executors!.entry("plurnk", workspaceId)?.executor as {
                effectForInvocation(target: string | null, body: string, workspaceId?: number): string;
            };
            assert.equal(manager.effectForInvocation("schedule", JSON.stringify({ alias: "check-flow" }), workspaceId), "read");
            assert.equal(manager.effectForInvocation("schedule", JSON.stringify({ alias: "check-flow", trigger: true }), workspaceId), "host");
            assert.equal(manager.effectForInvocation("schedule", JSON.stringify({ alias: "check-flow", run: true }), workspaceId), "host");
            assert.equal(manager.effectForInvocation("schedule", JSON.stringify({ alias: "new-script", run: [{ server: "sh", tool: "sh", arguments: { command: "echo hi" } }] }), workspaceId), "host");

            // Bare `{ alias }` read-only inspection via `_plurnk` client dispatch returns `executed: false` + `hint`.
            const inspectParsed = PlurnkParser.lowerToolCall("plurnk", "schedule", { alias: "check-flow" }, { executors: ["plurnk"] });
            const inspectStmt = inspectParsed.items[0];
            assert.equal(inspectStmt?.kind, "statement");
            if (inspectStmt?.kind === "statement") {
                let inspectLoop: { sessionId: number; loopId: number } | null = null;
                const [inspectResult] = await application.dispatchClientAction({
                    workspaceId,
                    actor: "acp://operator",
                    statements: [inspectStmt.statement],
                    onLoop: (loop) => { inspectLoop = loop; },
                });
                assert.equal(inspectResult.status, 200);
                assert.ok(inspectLoop !== null);
                const inspectLoopInfo = inspectLoop as { sessionId: number; loopId: number };
                const inspectRows = await application.readLog({
                    workspaceId,
                    sessionId: inspectLoopInfo.sessionId,
                    loopId: inspectLoopInfo.loopId,
                    limit: 1,
                });
                const streamUri = (inspectRows[0]?.attrs as { stream?: string } | undefined)?.stream;
                assert.ok(typeof streamUri === "string", "inspection log entry records its exec:///plurnk stream");
                const inspectEntry = await application.readEntry({
                    workspaceId,
                    sessionId: inspectLoopInfo.sessionId,
                    target: streamUri,
                });
                const inspectJson = JSON.parse(inspectEntry.entry?.channels.results?.content ?? "{}") as {
                    family?: string;
                    alias?: string;
                    executed?: boolean;
                    hint?: string;
                    definition?: { alias?: string };
                };
                assert.equal(inspectJson.family, "schedule");
                assert.equal(inspectJson.alias, "check-flow");
                assert.equal(inspectJson.executed, false);
                assert.match(inspectJson.hint ?? "", /trigger": true/u);
                assert.equal(inspectJson.definition?.alias, "check-flow");
            }
            assert.equal(pendingProposals.length, 0, "inspection triggered zero host proposals");
            assert.ok(reviewerSessionId > 0);
        } finally {
            unsubProposals();
        }

        // 5. Unscheduled `"once"` agentic obligation triggered via `workspace.schedule.run` auto-creates target session, settles `done`, and refuses repeat trigger with `409 already-done`!
        await application.invokeModuleAction("workspace.schedule.add", {
            alias: "auto-task",
            rule: "once",
            target: "session://auto_worker",
            prompt: "Run the unscheduled obligation.",
        }, { scope: "workspace", workspaceId });

        const terminated = new Promise<void>((resolveTerminated) => {
            application.subscribeToEvents((_ws, method) => { if (method === "loop/terminated") resolveTerminated(); });
        });
        await application.invokeModuleAction("workspace.schedule.run", { alias: "auto-task" }, { scope: "workspace", workspaceId });
        await terminated;

        let taskStatus: string | undefined;
        const doneDeadline = Date.now() + 10_000;
        while (Date.now() < doneDeadline) {
            const listing = await application.invokeModuleAction("workspace.schedule.list", {}, { scope: "workspace", workspaceId }) as {
                definitions: Array<{ alias: string; detail?: { status: string } }>;
            };
            taskStatus = listing.definitions.find(({ alias }) => alias === "auto-task")?.detail?.status;
            if (taskStatus === "done") break;
            await sleep(25);
        }
        assert.equal(taskStatus, "done", "once agentic obligation transitions to done when its loop completes");
        await assert.rejects(
            () => application.invokeModuleAction("workspace.schedule.run", { alias: "auto-task" }, { scope: "workspace", workspaceId }),
            /already-done|already done/u,
            "completed once obligation refuses repeat run with 409 already-done",
        );

        // 6. Schedule composition & re-entrancy guard: non-recursive `caller -> callee` succeeds,
        // while direct self-recursion (`self-loop -> self-loop`) and mutual recursion (`ping-loop -> pong-loop -> ping-loop`)
        // fail fast with `409 already-running` and leave no alias stuck.
        await application.invokeModuleAction("workspace.schedule.add", {
            alias: "callee-macro",
            run: [
                { server: "plurnk", tool: "edit", arguments: { path: "workspace:///composed.txt", range: "1,-1", content: "from-callee" } },
            ],
        }, { scope: "workspace", workspaceId });
        await application.invokeModuleAction("workspace.schedule.add", {
            alias: "caller-macro",
            run: [
                { server: "plurnk", tool: "schedule", arguments: { alias: "callee-macro", trigger: true } },
            ],
        }, { scope: "workspace", workspaceId });
        const composedRun = await application.invokeModuleAction("workspace.schedule.run", { alias: "caller-macro" }, { scope: "workspace", workspaceId }) as {
            status: string;
            results?: Array<{ status: number }>;
        };
        assert.equal(composedRun.status, "open");
        assert.equal(composedRun.results?.[0]?.status, 200);
        const composedFile = await application.readEntry({ workspaceId, sessionId: runtimeId, target: "workspace:///composed.txt" });
        assert.equal(composedFile.status, 200);
        if (composedFile.status === 200 && composedFile.entry !== null) {
            assert.equal(composedFile.entry.channels.body?.content, "from-callee");
        }

        await application.invokeModuleAction("workspace.schedule.add", {
            alias: "self-loop",
            run: [
                { server: "plurnk", tool: "schedule", arguments: { alias: "self-loop", trigger: true } },
            ],
        }, { scope: "workspace", workspaceId });
        await assert.rejects(
            () => application.invokeModuleAction("workspace.schedule.run", { alias: "self-loop" }, { scope: "workspace", workspaceId }),
            (err: unknown) => {
                const p = (err as { problem?: { status?: number; type?: string; step?: number; results?: Array<{ status: number }> } })?.problem;
                return p?.status === 409 && Boolean(p.type?.endsWith("/already-running")) && p.step === 0 && p.results?.[0]?.status === 409;
            },
            "direct self-recursion fails fast with 409 already-running",
        );

        await application.invokeModuleAction("workspace.schedule.add", {
            alias: "ping-loop",
            run: [
                { server: "plurnk", tool: "schedule", arguments: { alias: "pong-loop", trigger: true } },
            ],
        }, { scope: "workspace", workspaceId });
        await application.invokeModuleAction("workspace.schedule.add", {
            alias: "pong-loop",
            run: [
                { server: "plurnk", tool: "schedule", arguments: { alias: "ping-loop", trigger: true } },
            ],
        }, { scope: "workspace", workspaceId });
        await assert.rejects(
            () => application.invokeModuleAction("workspace.schedule.run", { alias: "ping-loop" }, { scope: "workspace", workspaceId }),
            (err: unknown) => {
                const p = (err as { problem?: { status?: number; type?: string; step?: number; results?: Array<{ status: number }> } })?.problem;
                return p?.status === 409 && Boolean(p.type?.endsWith("/already-running")) && p.step === 0 && p.results?.[0]?.status === 409;
            },
            "mutual recursion fails fast with 409 already-running",
        );

        // Verify neither alias remained locked after unwinding by replacing `ping-loop` with a non-recursive step and running it.
        await application.invokeModuleAction("workspace.schedule.replace", {
            alias: "ping-loop",
            run: [
                { server: "plurnk", tool: "read", arguments: { path: "workspace:///composed.txt" } },
            ],
        }, { scope: "workspace", workspaceId });
        const recoveredPing = await application.invokeModuleAction("workspace.schedule.run", { alias: "ping-loop" }, { scope: "workspace", workspaceId }) as {
            status: string;
            results?: Array<{ status: number; preview?: string }>;
        };
        assert.equal(recoveredPing.status, "open");
        assert.equal(recoveredPing.results?.[0]?.status, 200);
        assert.match(recoveredPing.results?.[0]?.preview ?? "", /from-callee/u);
    } finally {
        await daemon.stop();
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
