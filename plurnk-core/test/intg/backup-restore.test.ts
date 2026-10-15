import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { Mock } from "@plurnk/plurnk-providers";
import { Share } from "@plurnk/plurnk-digest";
import type { FunctionalityListResult } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import EvidenceReader from "../../src/evidence/EvidenceReader.ts";
import { openMigrated } from "./_db.ts";
import { parseDsl } from "./_mock.ts";
import { serverProposals, TEST_OWNER } from "./_approval.ts";
import { waitForDb } from "./_rpc.ts";
import { namedModelWorker } from "./_workers.ts";

test("{§share-snapshot}: restore preserves history, decisions and attachments without rewinding project files or service configuration", async (t) => {
    serverProposals(t, "accept");
    const directory = await mkdtemp(join(tmpdir(), "plurnk-backup-restore-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const projectRoot = join(directory, "project");
    const backup = join(directory, "backup");
    await mkdir(projectRoot);
    await mkdir(backup);
    const configPath = join(directory, "service.env");
    const filePath = join(projectRoot, "doc.md");
    const config = "PLURNK_MEMBERS_restore=doc.md\nPLURNK_SERVICE_EXEC_ENV_INHERIT=RESTORE_AMBIENT\nRESTORE_AMBIENT=original\n";
    await writeFile(configPath, config);
    const previous = Object.fromEntries(Object.keys(parseEnv(config)).map((key) => [key, process.env[key]]));
    t.after(() => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    Object.assign(process.env, parseEnv(await readFile(configPath, "utf8")));
    await writeFile(filePath, "Before the edit.\n");
    const dbPath = join(directory, "original.db");
    const snapshot = join(backup, "plurnk.db");
    const restoredPath = join(directory, "restored.db");
    const provider = new Mock({ contextWindow: 100_000, responses: [
        { assistant: { content: "````READ (doc.md)\n````", reasoning: "Inspect before editing." } },
        { assistant: { content: "````EDIT (doc.md) <1,-1>\nPreserved project version.\n````", reasoning: "Apply the requested change." } },
        { assistant: { content: "````SEND [200]\nUpdated the document.\n````", reasoning: "The edit succeeded." },
            usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
            cost: { kind: "charged", amount: { amount: "0.01", currency: "USD" }, source: "fixture invoice" } },
    ] });
    const db = await openMigrated(dbPath);
    const daemon = new Daemon({ db, provider });
    let workspaceId: number;
    let workerId: number;
    let loopId: number;
    let messages: Awaited<ReturnType<Daemon["readMessages"]>>;
    let history: ReturnType<EvidenceReader["rows"]>;
    try {
        await daemon.start();
        ({ workspaceId } = await daemon.createWorkspace({ name: "restore-witness", projectRoot }));
        workerId = await namedModelWorker(daemon, workspaceId, "main");
        await daemon.invokeModuleAction("workspace.env.add", {
            alias: "RESTORE_DURABLE", definition: { value: "workspace-owned" },
        }, { scope: "workspace", workspaceId });
        ({ loopId } = await daemon.runLoop({ workspaceId, workerId, prompt: "Update the document.",
            attachments: [{ name: "input.bin", mediaType: "application/octet-stream", bytes: new Uint8Array([4, 3, 2, 1]) }] }));
        const lifecycle = new LoopLifecycle(db);
        assert.equal(await waitForDb(() => lifecycle.status(loopId), (status) => status === 200 || status >= 400), 200);
        assert.equal(provider.received.length, 3);
        messages = await daemon.readMessages({ workspaceId, workerId, loopId });
        using evidence = EvidenceReader.open(dbPath);
        history = evidence.rows();
        const edit = history.logEntries.find(({ op, origin }) => op === "EDIT" && origin === "model");
        assert.equal(edit?.status_rx, 200, JSON.stringify(edit));
        assert.equal(await readFile(filePath, "utf8"), "Preserved project version.\n");
        assert.equal(edit?.proposalDecision?.decision, "accept");
        assert.equal(edit?.proposalDecision?.resolver, "_plurnk");
        assert.equal(history.providerRequests.length, 3);
        assert.equal(history.providerRequests.at(-1)?.accounting?.cost.kind, "charged");
        await copyFile(filePath, join(backup, "doc.md"));
        await copyFile(configPath, join(backup, "service.env"));
        Share.snapshot(dbPath, snapshot);
    } finally {
        await daemon.stop();
        await db.close();
    }

    await writeFile(filePath, "External edit after the snapshot.\n");
    await writeFile(configPath, config.replace("RESTORE_AMBIENT=original", "RESTORE_AMBIENT=changed"));
    Object.assign(process.env, parseEnv(await readFile(configPath, "utf8")));
    await copyFile(snapshot, restoredPath);
    await using restoredDb = await openMigrated(restoredPath);
    const idleProvider = new Mock({ contextWindow: 100_000, responses: [] });
    const restored = new Daemon({ db: restoredDb, provider: idleProvider });
    try {
        await restored.start();
        assert.equal(idleProvider.received.length, 0, "restoring a completed loop does not replay its effects");
        assert.deepEqual(await restored.readMessages({ workspaceId, workerId, loopId }), messages);
        using evidence = EvidenceReader.open(restoredPath);
        const recovered = evidence.rows();
        for (const key of ["loops", "turns", "inferenceCalls", "modelCalls", "turnAttempts", "providerRequests", "logEntries", "emissionRows", "reasoningRows"] as const) {
            assert.deepEqual(recovered[key], history[key], `${key} survives the consistent snapshot and normal startup`);
        }
        const environment = await restored.invokeModuleAction("worker.env.list", {}, {
            scope: "worker", workspaceId, workerId,
        }) as FunctionalityListResult;
        assert.deepEqual(environment.definitions.find(({ alias }) => alias === "RESTORE_DURABLE")?.definition, { value: "workspace-owned" });
        assert.deepEqual(environment.definitions.find(({ alias }) => alias === "RESTORE_AMBIENT")?.definition, { value: "changed" },
            "ambient configuration is taken from this startup, not replayed from the database");
        const [changed] = await restored.dispatchClientAction({ workspaceId, actor: TEST_OWNER, contextWorkerId: workerId, statements: parseDsl("````READ (doc.md)\n````") });
        assert.equal(changed?.status, 200);
        assert.equal(changed.content, "External edit after the snapshot.\n", "startup materializes current filesystem bytes, not the old database projection");
        assert.equal(await readFile(filePath, "utf8"), "External edit after the snapshot.\n");
    } finally { await restored.stop(); }

    await copyFile(join(backup, "doc.md"), filePath);
    await copyFile(join(backup, "service.env"), configPath);
    Object.assign(process.env, parseEnv(await readFile(configPath, "utf8")));
    const reconfigured = new Daemon({ db: restoredDb, provider: idleProvider });
    try {
        await reconfigured.start();
        const environment = await reconfigured.invokeModuleAction("worker.env.list", {}, {
            scope: "worker", workspaceId, workerId,
        }) as FunctionalityListResult;
        assert.deepEqual(environment.definitions.find(({ alias }) => alias === "RESTORE_AMBIENT")?.definition, { value: "original" });
        const [restoredFile] = await reconfigured.dispatchClientAction({ workspaceId, actor: TEST_OWNER, contextWorkerId: workerId, statements: parseDsl("````READ (doc.md)\n````") });
        assert.equal(restoredFile?.status, 200);
        assert.equal(restoredFile.content, "Preserved project version.\n");
        assert.equal(idleProvider.received.length, 0);
    } finally { await reconfigured.stop(); }
});
