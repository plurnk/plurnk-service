import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import GitBranch from "../../src/core/GitBranch.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Results from "../../src/core/results.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import WorkspaceGate from "../../src/core/WorkspaceGate.ts";
import BranchBatches from "../../src/server/BranchBatches.ts";
import BranchReceipt from "../../src/core/BranchReceipt.ts";
import {
    DEFAULT_MIMETYPES,
    insertLoop,
    insertTurn,
    insertWorker,
    insertWorkspace,
    openMigrated,
    rootWorkspace,
    seedEntryWithChannel,
} from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";
import { connect, makeMockResponse, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";

const execFileP = promisify(execFile);
const git = (root: string, args: string[]) =>
    execFileP("git", args, { cwd: root, env: hermeticGitEnv() });

const seedRepository = async (
    root: string,
    branch: string,
    content: string,
): Promise<Awaited<ReturnType<typeof GitBranch.snapshot>>> => {
    await mkdir(root, { recursive: true });
    await git(root, ["init", "--quiet"]);
    await writeFile(join(root, "seed.txt"), content);
    await git(root, ["add", "seed.txt"]);
    await git(root, [
        "-c", "user.name=Plurnk Test",
        "-c", "user.email=test@plurnk.dev",
        "-c", "commit.gpgsign=false",
        "-c", "core.hooksPath=/dev/null",
        "commit", "--no-verify", "--quiet", "-m", `test: seed ${branch}`,
    ]);
    await git(root, ["branch", "-M", branch]);
    return GitBranch.snapshot(root);
};

test("a branch batch freezes one base, runs children serially, and restores the parent checkout", async () => {
    const priorAllowed = process.env.PLURNK_SERVICE_GIT_ALLOWED;
    const priorAuto = process.env.PLURNK_SERVICE_GIT_AUTO;
    const priorNative = process.env.PLURNK_SERVICE_GIT_NATIVE;
    process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
    process.env.PLURNK_SERVICE_GIT_AUTO = "1";
    process.env.PLURNK_SERVICE_GIT_NATIVE = "1";
    const root = await mkdtemp(join(tmpdir(), "plurnk-branch-batch-"));
    const db = await openMigrated();
    try {
        await git(root, ["init", "--quiet"]);
        await writeFile(join(root, "seed.txt"), "seed\n");
        await git(root, ["add", "seed.txt"]);
        await git(root, [
            "-c", "user.name=Plurnk Test",
            "-c", "user.email=test@plurnk.dev",
            "-c", "commit.gpgsign=false",
            "-c", "core.hooksPath=/dev/null",
            "commit", "--no-verify", "--quiet", "-m", "test: seed",
        ]);
        const original = await GitBranch.snapshot(root);

        const workspaceId = await insertWorkspace(db, `branch-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const parentWorkerId = await insertWorker(db, workspaceId, null, "parent");
        const parentLoopId = await insertLoop(db, parentWorkerId, 1, "delegate");
        const parentTurnId = await insertTurn(db, parentLoopId, 1, 102);
        const lifecycle = new LoopLifecycle(db);
        const branches = new Map<number, string>();
        const execution: number[] = [];
        let wakeCount = 0;

        const gate = new WorkspaceGate(async (workerId, rootWorkerId) => {
            const row = await db.branch_batch_worker_lineage.get<{ member: number }>({
                worker_id: workerId,
                root_worker_id: rootWorkerId,
            });
            return row !== undefined;
        });
        let batches!: BranchBatches;
        batches = new BranchBatches(db, gate, {
            settleWorkspace: async () => {},
            createChild: async ({ name, parentWorkerId: parentId }) => {
                const workerId = await insertWorker(db, workspaceId, parentId, name);
                const loopId = await insertLoop(db, workerId, 1, `work ${name}`);
                return { workerId, loopId };
            },
            startChild: async (_workspaceId, workerId, loopId) => {
                execution.push(workerId);
                const branch = branches.get(workerId);
                assert.ok(branch);
                assert.equal(await GitBranch.currentBranch(root), branch);
                if (branch === "feature/one") {
                    await writeFile(join(root, "one.txt"), "one\n");
                    const refused = await batches.completionGate(workerId);
                    assert.equal(refused?.status, 409);
                    assert.match(refused?.problem?.type ?? "", /branch-work-uncommitted$/);
                    await git(root, ["add", "one.txt"]);
                    await git(root, [
                        "-c", "user.name=Plurnk Test",
                        "-c", "user.email=test@plurnk.dev",
                        "-c", "commit.gpgsign=false",
                        "-c", "core.hooksPath=/dev/null",
                        "commit", "--no-verify", "--quiet", "-m", "test: branch one",
                    ]);
                }
                if (branch === "feature/two") {
                    await GitBranch.switch(root, original.ref ?? original.commit);
                    const refused = await batches.completionGate(workerId);
                    assert.equal(refused?.status, 409);
                    assert.match(refused?.problem?.type ?? "", /branch-checkout-changed$/);
                    await GitBranch.switch(root, branch);
                }
                assert.equal(await batches.completionGate(workerId), null);
                const result = branch === "feature/failure" ? { status: 500 } : { status: 200 };
                return await lifecycle.finish(loopId, result)
                    ?? { status: await lifecycle.status(loopId) };
            },
            wakeParent: async () => { wakeCount++; },
            notify: () => {},
        });

        const one = await batches.enqueue({
            workspaceId,
            parentWorkerId,
            parentLoopId,
            parentTurnId,
            op: "WORK",
            name: "one",
            branch: "feature/one",
            prompt: "first",
            flags: { auto: true, mode: "act", noWeb: false, noInteraction: false, noProposals: false },
            origin: "model",
        });
        branches.set(one.workerId, "feature/one");
        const failure = await batches.enqueue({
            workspaceId,
            parentWorkerId,
            parentLoopId,
            parentTurnId,
            op: "WORK",
            name: "failure",
            branch: "feature/failure",
            prompt: "fail cleanly",
            flags: { auto: true, mode: "act", noWeb: false, noInteraction: false, noProposals: false },
            origin: "model",
        });
        branches.set(failure.workerId, "feature/failure");
        const two = await batches.enqueue({
            workspaceId,
            parentWorkerId,
            parentLoopId,
            parentTurnId,
            op: "WORK",
            name: "two",
            branch: "feature/two",
            prompt: "second",
            flags: { auto: true, mode: "act", noWeb: false, noInteraction: false, noProposals: false },
            origin: "model",
        });
        branches.set(two.workerId, "feature/two");

        await batches.sealTurn(parentTurnId);
        await batches.idle();

        assert.deepEqual(execution, [one.workerId, failure.workerId, two.workerId]);
        assert.deepEqual(await GitBranch.snapshot(root), original);
        assert.notEqual(await GitBranch.tip(root, "feature/one"), original.commit);
        assert.equal(await GitBranch.tip(root, "feature/two"), original.commit);
        assert.match(
            await BranchReceipt.render(db, one.workerId) ?? "",
            /Branch receipt: `feature\/one` succeeded at `[0-9a-f]{8}` \(changed\)/,
        );
        const active = await db.branch_batch_active.all({});
        assert.equal(active.length, 0);
        const receipt = await db.branch_batch_receipt.all<{
            branch: string;
            item_state: string;
            changed: number;
        }>({ batch_id: 1 });
        assert.deepEqual(
            receipt.map(({ branch, item_state, changed }) => ({ branch, item_state, changed })),
            [
                { branch: "feature/one", item_state: "succeeded", changed: 1 },
                { branch: "feature/failure", item_state: "failed", changed: 0 },
                { branch: "feature/two", item_state: "succeeded", changed: 0 },
            ],
        );
        assert.equal(wakeCount, 1);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
        if (priorAllowed === undefined) delete process.env.PLURNK_SERVICE_GIT_ALLOWED;
        else process.env.PLURNK_SERVICE_GIT_ALLOWED = priorAllowed;
        if (priorAuto === undefined) delete process.env.PLURNK_SERVICE_GIT_AUTO;
        else process.env.PLURNK_SERVICE_GIT_AUTO = priorAuto;
        if (priorNative === undefined) delete process.env.PLURNK_SERVICE_GIT_NATIVE;
        else process.env.PLURNK_SERVICE_GIT_NATIVE = priorNative;
    }
});

test("tagged sibling workers execute through the complete daemon topology", async () => {
    const priorAllowed = process.env.PLURNK_SERVICE_GIT_ALLOWED;
    const priorAuto = process.env.PLURNK_SERVICE_GIT_AUTO;
    const priorNative = process.env.PLURNK_SERVICE_GIT_NATIVE;
    process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
    process.env.PLURNK_SERVICE_GIT_AUTO = "1";
    process.env.PLURNK_SERVICE_GIT_NATIVE = "1";
    const root = await mkdtemp(join(tmpdir(), "plurnk-branch-daemon-"));
    try {
        await git(root, ["init", "--quiet"]);
        await writeFile(join(root, "seed.txt"), "seed\n");
        await git(root, ["add", "seed.txt"]);
        await git(root, [
            "-c", "user.name=Plurnk Test",
            "-c", "user.email=test@plurnk.dev",
            "-c", "commit.gpgsign=false",
            "-c", "core.hooksPath=/dev/null",
            "commit", "--no-verify", "--quiet", "-m", "test: seed",
        ]);
        const original = await GitBranch.snapshot(root);
        const mock = new Mock({
            contextWindow: 32768,
            responses: [
                makeMockResponse("<<WORK[feature/one](worker://one):first child:WORK\n<<FORK[feature/two](worker://two):second child with inherited context:FORK\n<<SEND[202]<-1>:waiting on both:SEND"),
                makeMockResponse("<<SEND[200]:first done:SEND"),
                makeMockResponse("<<SEND[200]:second done:SEND"),
                makeMockResponse("<<SEND[200]:both branches returned:SEND"),
            ],
        });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", {
                    name: `branch-daemon-${crypto.randomUUID()}`,
                    projectRoot: root,
                });
                const result = await runLoopToTerminal(
                    ws,
                    2,
                    { prompt: "delegate on branches", flags: { auto: true } },
                    { timeoutMs: 12000 },
                );
                assert.equal(result.finalStatus, 200);
                assert.deepEqual(await GitBranch.snapshot(root), original);
                assert.equal(await GitBranch.tip(root, "feature/one"), original.commit);
                assert.equal(await GitBranch.tip(root, "feature/two"), original.commit);
                const receipts = await db.branch_batch_receipt.all<{
                    branch: string;
                    item_state: string;
                }>({ batch_id: 1 });
                assert.deepEqual(
                    receipts.map(({ branch, item_state }) => ({ branch, item_state })),
                    [
                        { branch: "feature/one", item_state: "succeeded" },
                        { branch: "feature/two", item_state: "succeeded" },
                    ],
                );
                assert.ok(result.modelWorkerId);
                const sends = await db.test_log_entries_by_run_op_full.all<{
                    rx: string;
                }>({ worker_id: result.modelWorkerId, op: "SEND" });
                assert.ok(
                    sends.some(({ rx }) => rx.includes("Branch receipt: `feature/one` succeeded")),
                    "the parent receives branch receipts through its ordinary child-termination delta",
                );
            } finally {
                ws.close();
            }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
        if (priorAllowed === undefined) delete process.env.PLURNK_SERVICE_GIT_ALLOWED;
        else process.env.PLURNK_SERVICE_GIT_ALLOWED = priorAllowed;
        if (priorAuto === undefined) delete process.env.PLURNK_SERVICE_GIT_AUTO;
        else process.env.PLURNK_SERVICE_GIT_AUTO = priorAuto;
        if (priorNative === undefined) delete process.env.PLURNK_SERVICE_GIT_NATIVE;
        else process.env.PLURNK_SERVICE_GIT_NATIVE = priorNative;
    }
});

test("branch completion gates every terminal SEND and accepts the retry after cleanup", async (t) => {
    for (const specimen of [
        { signal: 200, terminal: 200, name: "conclude" },
        { signal: 499, terminal: 499, name: "abandon" },
        { signal: 202, terminal: 200, name: "drained join" },
    ] as const) {
        await t.test(specimen.name, async () => {
            const db = await openMigrated();
            try {
                const workspaceId = await insertWorkspace(db, `branch-send-${specimen.signal}-${crypto.randomUUID()}`);
                const workerId = await insertWorker(db, workspaceId);
                const loopId = await insertLoop(db, workerId, 1, "branch work");
                let blocked = true;
                let gateCalls = 0;
                const engine = new Engine({
                    db,
                    schemes: new SchemeRegistry(),
                    mimetypes: DEFAULT_MIMETYPES,
                    branchCompletionGate: async () => {
                        gateCalls++;
                        return blocked
                            ? Results.failure(
                                "lifecycle:branch",
                                "branch-work-uncommitted",
                                409,
                                "Commit or deliberately discard the branch work, then conclude again.",
                            )
                            : null;
                    },
                });
                const run = () => engine.runTurn({
                    provider: new Mock({
                        contextWindow: 100000,
                        responses: [{
                            assistant: {
                                content: "",
                                reasoning: null,
                                ops: [sendStmt(specimen.signal, null, specimen.name)],
                            },
                        }],
                    }),
                    workspaceId,
                    workerId,
                    loopId,
                    messages: [{ role: "system", content: "SD" }, { role: "user", content: "finish" }],
                });

                const refused = await run();
                assert.equal(refused.status, 102, "a denied terminal leaves the loop available to repair");
                assert.equal(gateCalls, 1);
                const refusedRows = await db.test_log_sequencees_by_turn.all<{
                    status_rx: number;
                    op: string;
                }>({ turn_id: refused.turnId });
                assert.equal(
                    refusedRows.find(({ op }) => op === "SEND")?.status_rx,
                    409,
                    "the emitted terminal is durably recorded as refused",
                );

                blocked = false;
                const accepted = await run();
                assert.equal(accepted.status, specimen.terminal);
                assert.equal(gateCalls, 2, "the repaired retry passes through the gate again");
                assert.equal(
                    (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status,
                    specimen.terminal,
                );
            } finally {
                await db.close();
            }
        });
    }
});

test("SEND[202] does not check branch completion while joined work is still live", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `branch-live-join-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "branch work");
        const childId = await insertWorker(db, workspaceId, workerId, "cleanup");
        await insertLoop(db, childId, 1, "cleanup still running");
        let gateCalls = 0;
        const engine = new Engine({
            db,
            schemes: new SchemeRegistry(),
            mimetypes: DEFAULT_MIMETYPES,
            branchCompletionGate: async () => {
                gateCalls++;
                return Results.failure(
                    "lifecycle:branch",
                    "branch-work-uncommitted",
                    409,
                    "The branch is not ready to return.",
                );
            },
        });
        const result = await engine.runTurn({
            provider: new Mock({
                contextWindow: 100000,
                responses: [{
                    assistant: {
                        content: "",
                        reasoning: null,
                        ops: [sendStmt(202, null, "waiting for cleanup")],
                    },
                }],
            }),
            workspaceId,
            workerId,
            loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "finish" }],
        });

        assert.equal(result.status, 202, "live work parks the loop");
        assert.equal(gateCalls, 0, "branch completion is not judged until the join drains");
        assert.equal(
            (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status,
            202,
        );
    } finally {
        await db.close();
    }
});

test("restart recovery preserves an interrupted committed tip and continues queued siblings", async () => {
    const priorAllowed = process.env.PLURNK_SERVICE_GIT_ALLOWED;
    const priorAuto = process.env.PLURNK_SERVICE_GIT_AUTO;
    const priorNative = process.env.PLURNK_SERVICE_GIT_NATIVE;
    process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
    process.env.PLURNK_SERVICE_GIT_AUTO = "1";
    process.env.PLURNK_SERVICE_GIT_NATIVE = "1";
    const root = await mkdtemp(join(tmpdir(), "plurnk-branch-recover-"));
    const db = await openMigrated();
    try {
        await git(root, ["init", "--quiet"]);
        await writeFile(join(root, "seed.txt"), "seed\n");
        await git(root, ["add", "seed.txt"]);
        await git(root, [
            "-c", "user.name=Plurnk Test",
            "-c", "user.email=test@plurnk.dev",
            "-c", "commit.gpgsign=false",
            "-c", "core.hooksPath=/dev/null",
            "commit", "--no-verify", "--quiet", "-m", "test: seed",
        ]);
        const original = await GitBranch.snapshot(root);
        const workspaceId = await insertWorkspace(db, `recover-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const parentWorkerId = await insertWorker(db, workspaceId, null, "parent");
        const parentLoopId = await insertLoop(db, parentWorkerId, 1);
        const parentTurnId = await insertTurn(db, parentLoopId, 1, 102);
        const firstWorkerId = await insertWorker(db, workspaceId, parentWorkerId, "one");
        const firstLoopId = await insertLoop(db, firstWorkerId, 1);
        const secondWorkerId = await insertWorker(db, workspaceId, parentWorkerId, "two");
        const secondLoopId = await insertLoop(db, secondWorkerId, 1);
        const lifecycle = new LoopLifecycle(db);

        const batch = await db.branch_batch_insert.get<{ id: number }>({
            workspace_id: workspaceId,
            parent_worker_id: parentWorkerId,
            parent_loop_id: parentLoopId,
            parent_turn_id: parentTurnId,
        });
        assert.ok(batch);
        const firstItem = await db.branch_batch_insert_item.get<{ id: number }>({
            batch_id: batch.id,
            sequence: 1,
            worker_id: firstWorkerId,
            loop_id: firstLoopId,
            branch: "feature/one",
        });
        const secondItem = await db.branch_batch_insert_item.get<{ id: number }>({
            batch_id: batch.id,
            sequence: 2,
            worker_id: secondWorkerId,
            loop_id: secondLoopId,
            branch: "feature/two",
        });
        assert.ok(firstItem);
        assert.ok(secondItem);
        await db.branch_batch_seal.get({ parent_turn_id: parentTurnId });
        await db.branch_batch_start.run({
            batch_id: batch.id,
            repository_path: root,
            original_ref: original.ref,
            original_commit: original.commit,
        });
        await GitBranch.create(root, "feature/one", original.commit);
        await GitBranch.create(root, "feature/two", original.commit);
        await db.branch_batch_start_item.run({ item_id: firstItem.id });
        await db.branch_batch_set_active.run({ batch_id: batch.id, sequence: 1 });
        await GitBranch.switch(root, "feature/one");
        await writeFile(join(root, "recovered.txt"), "preserve me\n");
        await git(root, ["add", "recovered.txt"]);
        await git(root, [
            "-c", "user.name=Plurnk Test",
            "-c", "user.email=test@plurnk.dev",
            "-c", "commit.gpgsign=false",
            "-c", "core.hooksPath=/dev/null",
            "commit", "--no-verify", "--quiet", "-m", "test: interrupted child",
        ]);
        const preservedTip = await GitBranch.head(root);
        await lifecycle.finish(firstLoopId, {
            status: 500,
            problem: {
                type: "https://problems.plurnk.dev/lifecycle/recovery/owner-vanished",
                title: "Owner vanished",
                status: 500,
                detail: "test restart",
            },
        });

        const gate = new WorkspaceGate(async (workerId, rootWorkerId) => {
            const row = await db.branch_batch_worker_lineage.get<{ member: number }>({
                worker_id: workerId,
                root_worker_id: rootWorkerId,
            });
            return row !== undefined;
        });
        const recovered = new BranchBatches(db, gate, {
            settleWorkspace: async () => {},
            createChild: async () => { throw new Error("recovery must not create replacement children"); },
            startChild: async (_workspaceId, workerId, loopId) => {
                assert.equal(workerId, secondWorkerId);
                assert.equal(await GitBranch.currentBranch(root), "feature/two");
                return await lifecycle.finish(loopId, { status: 200 }) ?? { status: 200 };
            },
            wakeParent: async () => {},
            notify: () => {},
        });
        await recovered.recover();
        await recovered.idle();

        assert.deepEqual(await GitBranch.snapshot(root), original);
        assert.equal(await GitBranch.tip(root, "feature/one"), preservedTip);
        const rows = await db.branch_batch_receipt.all<{
            branch: string;
            item_state: string;
            result_commit: string;
        }>({ batch_id: batch.id });
        assert.deepEqual(
            rows.map(({ branch, item_state, result_commit }) => ({
                branch,
                item_state,
                result_commit,
            })),
            [
                { branch: "feature/one", item_state: "failed", result_commit: preservedTip },
                { branch: "feature/two", item_state: "succeeded", result_commit: original.commit },
            ],
        );
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
        if (priorAllowed === undefined) delete process.env.PLURNK_SERVICE_GIT_ALLOWED;
        else process.env.PLURNK_SERVICE_GIT_ALLOWED = priorAllowed;
        if (priorAuto === undefined) delete process.env.PLURNK_SERVICE_GIT_AUTO;
        else process.env.PLURNK_SERVICE_GIT_AUTO = priorAuto;
        if (priorNative === undefined) delete process.env.PLURNK_SERVICE_GIT_NATIVE;
        else process.env.PLURNK_SERVICE_GIT_NATIVE = priorNative;
    }
});

test("branch preflight rejects every dirty checkout class and existing refs without starting a child", async (t) => {
    const priorAllowed = process.env.PLURNK_SERVICE_GIT_ALLOWED;
    const priorAuto = process.env.PLURNK_SERVICE_GIT_AUTO;
    const priorNative = process.env.PLURNK_SERVICE_GIT_NATIVE;
    process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
    process.env.PLURNK_SERVICE_GIT_AUTO = "1";
    process.env.PLURNK_SERVICE_GIT_NATIVE = "1";
    try {
        for (const specimen of ["staged", "unstaged", "untracked", "existing-branch"] as const) {
            await t.test(specimen, async () => {
                const root = await mkdtemp(join(tmpdir(), `plurnk-branch-${specimen}-`));
                const db = await openMigrated();
                try {
                    await git(root, ["init", "--quiet"]);
                    await writeFile(join(root, "seed.txt"), "seed\n");
                    await git(root, ["add", "seed.txt"]);
                    await git(root, [
                        "-c", "user.name=Plurnk Test",
                        "-c", "user.email=test@plurnk.dev",
                        "-c", "commit.gpgsign=false",
                        "-c", "core.hooksPath=/dev/null",
                        "commit", "--no-verify", "--quiet", "-m", "test: seed",
                    ]);
                    const original = await GitBranch.snapshot(root);
                    const workspaceId = await insertWorkspace(db, `${specimen}-${crypto.randomUUID()}`);
                    await rootWorkspace(db, workspaceId, root);
                    const parentWorkerId = await insertWorker(db, workspaceId, null, "parent");
                    const parentLoopId = await insertLoop(db, parentWorkerId, 1);
                    const parentTurnId = await insertTurn(db, parentLoopId, 1, 102);
                    let started = false;
                    const gate = new WorkspaceGate(async (workerId, rootWorkerId) => workerId === rootWorkerId);
                    const batches = new BranchBatches(db, gate, {
                        settleWorkspace: async () => {},
                        createChild: async ({ name, parentWorkerId: parentId }) => {
                            const workerId = await insertWorker(db, workspaceId, parentId, name);
                            return {
                                workerId,
                                loopId: await insertLoop(db, workerId, 1),
                            };
                        },
                        startChild: async () => {
                            started = true;
                            return { status: 200 };
                        },
                        wakeParent: async () => {},
                        notify: () => {},
                    });
                    const child = await batches.enqueue({
                        workspaceId,
                        parentWorkerId,
                        parentLoopId,
                        parentTurnId,
                        op: "WORK",
                        name: "child",
                        branch: "feature/specimen",
                        prompt: "work",
                        flags: { auto: true, mode: "act", noWeb: false, noInteraction: false, noProposals: false },
                        origin: "model",
                    });

                    if (specimen === "staged") {
                        await writeFile(join(root, "staged.txt"), "staged\n");
                        await git(root, ["add", "staged.txt"]);
                    } else if (specimen === "unstaged") {
                        await writeFile(join(root, "seed.txt"), "modified\n");
                    } else if (specimen === "untracked") {
                        await writeFile(join(root, "untracked.txt"), "untracked\n");
                    } else {
                        await GitBranch.create(root, "feature/specimen", original.commit);
                    }

                    await batches.sealTurn(parentTurnId);
                    await batches.idle();
                    assert.equal(started, false);
                    assert.deepEqual(await GitBranch.snapshot(root), original);
                    assert.equal(
                        await GitBranch.branchExists(root, "feature/specimen"),
                        specimen === "existing-branch",
                    );
                    assert.equal((await new LoopLifecycle(db).result(child.loopId))?.status, 409);
                    assert.equal((await db.branch_batch_active.all({})).length, 0);
                    const release = await gate.acquireTurn(workspaceId, parentWorkerId);
                    release();
                } finally {
                    await db.close();
                    await rm(root, { recursive: true, force: true });
                }
            });
        }
    } finally {
        if (priorAllowed === undefined) delete process.env.PLURNK_SERVICE_GIT_ALLOWED;
        else process.env.PLURNK_SERVICE_GIT_ALLOWED = priorAllowed;
        if (priorAuto === undefined) delete process.env.PLURNK_SERVICE_GIT_AUTO;
        else process.env.PLURNK_SERVICE_GIT_AUTO = priorAuto;
        if (priorNative === undefined) delete process.env.PLURNK_SERVICE_GIT_NATIVE;
        else process.env.PLURNK_SERVICE_GIT_NATIVE = priorNative;
    }
});

test("a nested project branches its containing monorepo and ignores an unrelated repository", async () => {
    const priorAllowed = process.env.PLURNK_SERVICE_GIT_ALLOWED;
    const priorAuto = process.env.PLURNK_SERVICE_GIT_AUTO;
    const priorNative = process.env.PLURNK_SERVICE_GIT_NATIVE;
    process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
    process.env.PLURNK_SERVICE_GIT_AUTO = "1";
    process.env.PLURNK_SERVICE_GIT_NATIVE = "1";
    const root = await mkdtemp(join(tmpdir(), "plurnk-branch-boundary-"));
    const monorepo = join(root, "monorepo");
    const projectRoot = join(monorepo, "packages", "app");
    const siblingProject = join(monorepo, "packages", "lib");
    const unrelated = join(root, "unrelated");
    const db = await openMigrated();
    try {
        await mkdir(projectRoot, { recursive: true });
        await mkdir(siblingProject, { recursive: true });
        const original = await seedRepository(monorepo, "main", "monorepo\n");
        const unrelatedOriginal = await seedRepository(unrelated, "release/base", "unrelated\n");
        await writeFile(join(unrelated, "dirty.txt"), "outside this workspace\n");

        const workspaceId = await insertWorkspace(db, `boundary-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, projectRoot);
        const parentWorkerId = await insertWorker(db, workspaceId, null, "parent");
        const parentLoopId = await insertLoop(db, parentWorkerId, 1);
        const parentTurnId = await insertTurn(db, parentLoopId, 1, 102);
        const lifecycle = new LoopLifecycle(db);
        const gate = new WorkspaceGate(async (workerId, rootWorkerId) => workerId === rootWorkerId);
        const batches = new BranchBatches(db, gate, {
            settleWorkspace: async () => {},
            createChild: async ({ name, parentWorkerId: parentId }) => {
                const workerId = await insertWorker(db, workspaceId, parentId, name);
                return { workerId, loopId: await insertLoop(db, workerId, 1) };
            },
            startChild: async (_workspaceId, workerId, loopId) => {
                assert.equal(await GitBranch.currentBranch(monorepo), "feature/monorepo");
                assert.equal(await GitBranch.currentBranch(unrelated), "release/base");
                await writeFile(join(siblingProject, "work.txt"), "sibling package change\n");
                await git(monorepo, ["add", "packages/lib/work.txt"]);
                await git(monorepo, [
                    "-c", "user.name=Plurnk Test",
                    "-c", "user.email=test@plurnk.dev",
                    "-c", "commit.gpgsign=false",
                    "-c", "core.hooksPath=/dev/null",
                    "commit", "--no-verify", "--quiet", "-m", "test: monorepo child",
                ]);
                assert.equal(await batches.completionGate(workerId), null);
                return await lifecycle.finish(loopId, { status: 200 }) ?? { status: 200 };
            },
            wakeParent: async () => {},
            notify: () => {},
        });
        const child = await batches.enqueue({
            workspaceId,
            parentWorkerId,
            parentLoopId,
            parentTurnId,
            op: "WORK",
            name: "monorepo-child",
            branch: "feature/monorepo",
            prompt: "work across the monorepo",
            flags: { auto: true, mode: "act", noWeb: false, noInteraction: false, noProposals: false },
            origin: "model",
        });
        await batches.sealTurn(parentTurnId);
        await batches.idle();

        assert.deepEqual(await GitBranch.snapshot(monorepo), original);
        assert.notEqual(await GitBranch.tip(monorepo, "feature/monorepo"), original.commit);
        assert.equal(await GitBranch.branchExists(unrelated, "feature/monorepo"), false);
        assert.deepEqual(await GitBranch.snapshot(unrelated), unrelatedOriginal);
        assert.match(
            await BranchReceipt.render(db, child.workerId) ?? "",
            /Branch receipt: `feature\/monorepo` succeeded at `[0-9a-f]{8}` \(changed\)/,
        );
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
        if (priorAllowed === undefined) delete process.env.PLURNK_SERVICE_GIT_ALLOWED;
        else process.env.PLURNK_SERVICE_GIT_ALLOWED = priorAllowed;
        if (priorAuto === undefined) delete process.env.PLURNK_SERVICE_GIT_AUTO;
        else process.env.PLURNK_SERVICE_GIT_AUTO = priorAuto;
        if (priorNative === undefined) delete process.env.PLURNK_SERVICE_GIT_NATIVE;
        else process.env.PLURNK_SERVICE_GIT_NATIVE = priorNative;
    }
});

test("branch preflight refuses a workspace with a still-open stream", async () => {
    const priorNative = process.env.PLURNK_SERVICE_GIT_NATIVE;
    process.env.PLURNK_SERVICE_GIT_NATIVE = "1";
    const root = await mkdtemp(join(tmpdir(), "plurnk-branch-stream-"));
    const db = await openMigrated();
    try {
        const original = await seedRepository(root, "main", "seed\n");
        const workspaceId = await insertWorkspace(db, `stream-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const parentWorkerId = await insertWorker(db, workspaceId, null, "parent");
        const parentLoopId = await insertLoop(db, parentWorkerId, 1);
        const parentTurnId = await insertTurn(db, parentLoopId, 1, 102);
        const entryId = await seedEntryWithChannel(db, {
            workspaceId,
            workerId: parentWorkerId,
            pathname: "/stream",
        });
        const subscription = await db.open_subscription.get<{ id: number }>({
            worker_id: parentWorkerId,
            entry_id: entryId,
            scheme: "exec",
            handle: "branch-preflight",
        });
        assert.ok(subscription);
        let started = false;
        const gate = new WorkspaceGate(async (workerId, rootWorkerId) => workerId === rootWorkerId);
        const batches = new BranchBatches(db, gate, {
            settleWorkspace: async () => {},
            createChild: async ({ name, parentWorkerId: parentId }) => {
                const workerId = await insertWorker(db, workspaceId, parentId, name);
                return { workerId, loopId: await insertLoop(db, workerId, 1) };
            },
            startChild: async () => {
                started = true;
                return { status: 200 };
            },
            wakeParent: async () => {},
            notify: () => {},
        });
        const child = await batches.enqueue({
            workspaceId,
            parentWorkerId,
            parentLoopId,
            parentTurnId,
            op: "WORK",
            name: "child",
            branch: "feature/stream",
            prompt: "work",
            flags: { auto: true, mode: "act", noWeb: false, noInteraction: false, noProposals: false },
            origin: "model",
        });
        await batches.sealTurn(parentTurnId);
        await batches.idle();

        assert.equal(started, false);
        assert.deepEqual(await GitBranch.snapshot(root), original);
        assert.equal(await GitBranch.branchExists(root, "feature/stream"), false);
        assert.equal((await new LoopLifecycle(db).result(child.loopId))?.status, 409);
        assert.equal((await db.branch_batch_active.all({})).length, 0);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
        if (priorNative === undefined) delete process.env.PLURNK_SERVICE_GIT_NATIVE;
        else process.env.PLURNK_SERVICE_GIT_NATIVE = priorNative;
    }
});

test("shutdown lets the active branch settle and does not start its queued sibling", async () => {
    const priorNative = process.env.PLURNK_SERVICE_GIT_NATIVE;
    process.env.PLURNK_SERVICE_GIT_NATIVE = "1";
    const root = await mkdtemp(join(tmpdir(), "plurnk-branch-stop-"));
    const db = await openMigrated();
    try {
        const original = await seedRepository(root, "main", "seed\n");
        const workspaceId = await insertWorkspace(db, `stop-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const parentWorkerId = await insertWorker(db, workspaceId, null, "parent");
        const parentLoopId = await insertLoop(db, parentWorkerId, 1);
        const parentTurnId = await insertTurn(db, parentLoopId, 1, 102);
        const lifecycle = new LoopLifecycle(db);
        const started: number[] = [];
        let announceFirst!: () => void;
        const firstStarted = new Promise<void>((resolve) => { announceFirst = resolve; });
        let releaseFirst!: () => void;
        const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
        const gate = new WorkspaceGate(async (workerId, rootWorkerId) => workerId === rootWorkerId);
        const batches = new BranchBatches(db, gate, {
            settleWorkspace: async () => {},
            createChild: async ({ name, parentWorkerId: parentId }) => {
                const workerId = await insertWorker(db, workspaceId, parentId, name);
                return { workerId, loopId: await insertLoop(db, workerId, 1) };
            },
            startChild: async (_workspaceId, workerId, loopId) => {
                started.push(workerId);
                announceFirst();
                await firstMayFinish;
                return await lifecycle.finish(loopId, { status: 200 }) ?? { status: 200 };
            },
            wakeParent: async () => {},
            notify: () => {},
        });
        const first = await batches.enqueue({
            workspaceId,
            parentWorkerId,
            parentLoopId,
            parentTurnId,
            op: "WORK",
            name: "one",
            branch: "feature/one",
            prompt: "one",
            flags: { auto: true, mode: "act", noWeb: false, noInteraction: false, noProposals: false },
            origin: "model",
        });
        const second = await batches.enqueue({
            workspaceId,
            parentWorkerId,
            parentLoopId,
            parentTurnId,
            op: "WORK",
            name: "two",
            branch: "feature/two",
            prompt: "two",
            flags: { auto: true, mode: "act", noWeb: false, noInteraction: false, noProposals: false },
            origin: "model",
        });
        await batches.sealTurn(parentTurnId);
        await firstStarted;
        batches.beginStop();
        releaseFirst();
        await batches.idle();

        assert.deepEqual(started, [first.workerId]);
        assert.deepEqual(await GitBranch.snapshot(root), original);
        assert.equal((await lifecycle.result(first.loopId))?.status, 200);
        assert.equal((await lifecycle.result(second.loopId))?.status, 499);
        assert.equal((await db.branch_batch_active.all({})).length, 0);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
        if (priorNative === undefined) delete process.env.PLURNK_SERVICE_GIT_NATIVE;
        else process.env.PLURNK_SERVICE_GIT_NATIVE = priorNative;
    }
});

test("an ambiguous dirty child checkout is preserved as recovery_required", async () => {
    const priorNative = process.env.PLURNK_SERVICE_GIT_NATIVE;
    process.env.PLURNK_SERVICE_GIT_NATIVE = "1";
    const root = await mkdtemp(join(tmpdir(), "plurnk-branch-recovery-required-"));
    const db = await openMigrated();
    try {
        await seedRepository(root, "main", "seed\n");
        const workspaceId = await insertWorkspace(db, `recovery-required-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const parentWorkerId = await insertWorker(db, workspaceId, null, "parent");
        const parentLoopId = await insertLoop(db, parentWorkerId, 1);
        const parentTurnId = await insertTurn(db, parentLoopId, 1, 102);
        const lifecycle = new LoopLifecycle(db);
        const gate = new WorkspaceGate(async (workerId, rootWorkerId) => workerId === rootWorkerId);
        const batches = new BranchBatches(db, gate, {
            settleWorkspace: async () => {},
            createChild: async ({ name, parentWorkerId: parentId }) => {
                const workerId = await insertWorker(db, workspaceId, parentId, name);
                return { workerId, loopId: await insertLoop(db, workerId, 1) };
            },
            startChild: async (_workspaceId, _workerId, loopId) => {
                await writeFile(join(root, "uncommitted.txt"), "preserve me\n");
                return await lifecycle.finish(loopId, { status: 500 }) ?? { status: 500 };
            },
            wakeParent: async () => {},
            notify: () => {},
        });
        await batches.enqueue({
            workspaceId,
            parentWorkerId,
            parentLoopId,
            parentTurnId,
            op: "WORK",
            name: "child",
            branch: "feature/dirty",
            prompt: "work",
            flags: { auto: true, mode: "act", noWeb: false, noInteraction: false, noProposals: false },
            origin: "model",
        });
        await batches.sealTurn(parentTurnId);
        await batches.idle();

        assert.equal(await GitBranch.currentBranch(root), "feature/dirty");
        await assert.rejects(GitBranch.assertClean(root), /not clean/);
        const active = await db.branch_batch_active.all<{ state: string }>({});
        assert.deepEqual(active.map(({ state }) => state), ["recovery_required"]);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
        if (priorNative === undefined) delete process.env.PLURNK_SERVICE_GIT_NATIVE;
        else process.env.PLURNK_SERVICE_GIT_NATIVE = priorNative;
    }
});
