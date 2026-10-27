import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import HostPaths from "../../src/core/HostPaths.ts";
import WorkspaceStorage from "../../src/server/WorkspaceStorage.ts";
import { insertWorkspace, openMigrated } from "./_db.ts";
import { parseEnv } from "node:util";
import { Mock } from "@plurnk/plurnk-providers";
import { Share } from "@plurnk/plurnk-digest";
import type { FunctionalityListResult } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import EvidenceReader from "../../src/evidence/EvidenceReader.ts";
import { parseDsl } from "./_mock.ts";
import { serverProposals, TEST_OWNER } from "./_approval.ts";
import { waitForDb } from "./_rpc.ts";
import { namedModelSession } from "./_sessions.ts";
import SchemeCtxImpl from "../../src/core/caps/SchemeCtxImpl.ts";
import { makeSchemeCtx, schemeManifest } from "./_scheme.ts";
import LiveSubscriptions from "../../src/core/LiveSubscriptions.ts";
import DbEntryCaps from "../../src/core/caps/DbEntryCaps.ts";
import DbChannelCaps from "../../src/core/caps/DbChannelCaps.ts";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { Module as ScheduleModule } from "@plurnk/plurnk-schedule";
import { OperationFailureError } from "../../src/core/results.ts";

// ─── WorkspaceStorage.test.ts ───
{
test("{§module-seam-slices} lazy allocation is atomic, rename-stable, durable, and distinct across databases", async (t) => {
    const scratch = await mkdtemp(join(tmpdir(), "plurnk-workspace-storage-"));
    const paths = new HostPaths({ env: {}, home: scratch });
    const databasePath = join(scratch, "first.db");
    let db = await openMigrated(databasePath);
    const otherDb = await openMigrated(join(scratch, "second.db"));
    t.after(async () => { await db.close(); await otherDb.close(); await rm(scratch, { recursive: true, force: true }); });
    const workspaceId = await insertWorkspace(db, "original");
    const otherWorkspaceId = await insertWorkspace(otherDb, "original");
    assert.equal(workspaceId, otherWorkspaceId, "the collision specimen reuses both local id and name");
    const storage = new WorkspaceStorage(db, paths);
    await assert.rejects(stat(paths.stateDir), { code: "ENOENT" }, "constructing the host does not create storage");
    const directories = await Promise.all(Array.from({ length: 16 }, () => storage.directory(workspaceId, "@test/tool")));
    assert.equal(new Set(directories).size, 1);
    const directory = directories[0];
    assert.ok(directory.startsWith(`${paths.stateDir}/workspaces/`));
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    await writeFile(join(directory, "retained.txt"), "tool state");
    await db.envelope_set_workspace_name.get({ id: workspaceId, name: "renamed" });
    assert.equal(await storage.directory(workspaceId, "@test/tool"), directory);
    const sibling = await storage.directory(workspaceId, "../../outside");
    assert.equal(dirname(sibling), dirname(directory), "the module name is one encoded path component");
    assert.notEqual(sibling, directory);
    assert.notEqual(await new WorkspaceStorage(otherDb, paths).directory(otherWorkspaceId, "@test/tool"), directory);
    await db.close();
    db = await openMigrated(databasePath);
    assert.equal(await new WorkspaceStorage(db, paths).directory(workspaceId, "@test/tool"), directory);
    assert.equal(await readFile(join(directory, "retained.txt"), "utf8"), "tool state");
    await db.test_workspaces_delete.run({ id: workspaceId });
    assert.equal(await db.workspace_module_state_get.get({ workspace_id: workspaceId, namespace_owner: "@plurnk/plurnk-service/storage" }), undefined);
    const replacement = await insertWorkspace(db, "renamed");
    assert.notEqual(await new WorkspaceStorage(db, paths).directory(replacement, "@test/tool"), directory);
    assert.equal(await readFile(join(directory, "retained.txt"), "utf8"), "tool state", "deleting a workspace never reassigns or erases its tool state");
});

test("{§module-seam-slices} missing identities, corrupt keys, and filesystem failures never redirect storage", async (t) => {
    const scratch = await mkdtemp(join(tmpdir(), "plurnk-workspace-storage-invalid-"));
    const paths = new HostPaths({ env: {}, home: scratch });
    const db = await openMigrated();
    t.after(async () => { await db.close(); await rm(scratch, { recursive: true, force: true }); });
    const storage = new WorkspaceStorage(db, paths);
    await assert.rejects(storage.directory(999, "@test/tool"), /Workspace 999 does not exist/);
    const workspaceId = await insertWorkspace(db, "invalid");
    for (const name of ["", ".", ".."]) await assert.rejects(storage.directory(workspaceId, name), /requires a namespace owner/);
    await db.workspace_module_state_put.run({ workspace_id: workspaceId, namespace_owner: "@plurnk/plurnk-service/storage", state: '{"key":"../escape"}' });
    await assert.rejects(storage.directory(workspaceId, "@test/tool"), /invalid storage key/);
    await assert.rejects(stat(paths.stateDir), { code: "ENOENT" });
    await db.workspace_module_state_delete.run({ workspace_id: workspaceId, namespace_owner: "@plurnk/plurnk-service/storage" });
    await mkdir(dirname(paths.stateDir), { recursive: true });
    await writeFile(paths.stateDir, "occupied");
    await assert.rejects(storage.directory(workspaceId, "@test/tool"), { code: "ENOTDIR" });
});
}

// ─── backup-restore.test.ts ───
{
test("{§share-packet-names}: restore preserves history, decisions and attachments without rewinding project files or service configuration", async (t) => {
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
    let sessionId: number;
    let loopId: number;
    let messages: Awaited<ReturnType<Daemon["readMessages"]>>;
    let history: ReturnType<EvidenceReader["rows"]>;
    try {
        await daemon.start();
        ({ workspaceId } = await daemon.createWorkspace({ name: "restore-witness", projectRoot }));
        sessionId = await namedModelSession(daemon, workspaceId, "main");
        await daemon.invokeModuleAction("workspace.env.add", {
            alias: "RESTORE_DURABLE", definition: { value: "workspace-owned" },
        }, { scope: "workspace", workspaceId });
        ({ loopId } = await daemon.runLoop({ workspaceId, sessionId, prompt: "Update the document.",
            attachments: [{ name: "input.bin", mediaType: "application/octet-stream", bytes: new Uint8Array([4, 3, 2, 1]) }] }));
        const lifecycle = new LoopLifecycle(db);
        assert.equal(await waitForDb(() => lifecycle.status(loopId), (status) => status === 200 || status >= 400), 200);
        assert.equal(provider.received.length, 3);
        messages = await daemon.readMessages({ workspaceId, sessionId, loopId });
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
        assert.deepEqual(await restored.readMessages({ workspaceId, sessionId, loopId }), messages);
        using evidence = EvidenceReader.open(restoredPath);
        const recovered = evidence.rows();
        for (const key of ["loops", "turns", "inferenceCalls", "modelCalls", "turnAttempts", "providerRequests", "logEntries", "emissionRows", "reasoningRows"] as const) {
            assert.deepEqual(recovered[key], history[key], `${key} survives the consistent snapshot and normal startup`);
        }
        const environment = await restored.invokeModuleAction("session.env.list", {}, {
            scope: "session", workspaceId, sessionId,
        }) as FunctionalityListResult;
        assert.deepEqual(environment.definitions.find(({ alias }) => alias === "RESTORE_DURABLE")?.definition, { value: "workspace-owned" });
        assert.deepEqual(environment.definitions.find(({ alias }) => alias === "RESTORE_AMBIENT")?.definition, { value: "changed" },
            "ambient configuration is taken from this startup, not replayed from the database");
        const [changed] = await restored.dispatchClientAction({ workspaceId, actor: TEST_OWNER, contextSessionId: sessionId, statements: parseDsl("````READ (doc.md)\n````") });
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
        const environment = await reconfigured.invokeModuleAction("session.env.list", {}, {
            scope: "session", workspaceId, sessionId,
        }) as FunctionalityListResult;
        assert.deepEqual(environment.definitions.find(({ alias }) => alias === "RESTORE_AMBIENT")?.definition, { value: "original" });
        const [restoredFile] = await reconfigured.dispatchClientAction({ workspaceId, actor: TEST_OWNER, contextSessionId: sessionId, statements: parseDsl("````READ (doc.md)\n````") });
        assert.equal(restoredFile?.status, 200);
        assert.equal(restoredFile.content, "Preserved project version.\n");
        assert.equal(idleProvider.received.length, 0);
    } finally { await reconfigured.stop(); }
});
}

// ─── caps-assembly.test.ts ───
{
// {§capability-ctx}: the public context, not the private orchestration context.







test("{§capability-ctx}: public identity and working capabilities exclude private service state", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `caps-asm-${crypto.randomUUID()}`);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId: 7, loopId: 8, turnId: 9, writer: "model" });

        const sctx = new SchemeCtxImpl(ctx, "notes", schemeManifest("notes"), new LiveSubscriptions(), {  });

        // identity lifted off the PlurnkSchemeContext
        assert.equal(sctx.workspaceId, workspaceId);
        assert.equal(sctx.sessionId, 7);
        assert.equal(sctx.loopId, 8);
        assert.equal(sctx.turnId, 9);
        assert.equal(sctx.writer, "model");

        for (const cap of ["entries", "channels", "notify", "projection", "interactions", "subscriptions"] as const) {
            assert.notEqual((sctx as unknown as Record<string, unknown>)[cap], undefined, `${cap} cap is wired`);
        }

        // and functional through the assembled seam — content + private attributes round-trip
        const w = await sctx.entries.write("/e.md", {
            channels: { body: { content: "x", mimetype: "text/markdown" } },
            attributes: { kind: "specimen" },
        });
        assert.equal(w.created, true);
        const entry = (await sctx.entries.read("/e.md")).entry;
        assert.equal(entry?.channels.body.content, "x");
        assert.deepEqual(entry?.attributes, { kind: "specimen" });

        for (const privateField of ["db", "mimetypes", "executors", "weigh", "tokenize", "injectSession", "wakeSessionNotify", "streamEventNotify", "pushNotice", "visibility"]) {
            assert.equal(privateField in sctx, false, `${privateField} is not part of the public handler context`);
        }
    } finally { await db.close(); }
});
}

// ─── caps-channels-tags.test.ts ───
{
// Conformance: the ChannelCaps namespace in plurnk-schemes
// {§capability-ctx}, driven against real SQLite through the public capability
// surface. Entries are seeded through that same surface.







test("{§capability-ctx} DbChannelCaps: append grows, replace swaps + re-tokenizes, setState transitions; absent → 404", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `caps-channels-${crypto.randomUUID()}`);

        const ctx = makeSchemeCtx({ db, workspaceId });
        const entries = new DbEntryCaps(ctx, "notes", schemeManifest("notes"), "");
        const channels = new DbChannelCaps(ctx, "notes", "");

        const w = await entries.write("/doc.md", { channels: { body: { content: "abc", mimetype: "text/markdown" } } });
        const entryId = w.entryId as number;

        // append → content grows
        assert.equal((await channels.append("/doc.md", "body", "def")).status, 200);
        assert.equal((await entries.read("/doc.md")).entry?.channels.body.content, "abcdef");

        // replace → content swapped, tokens re-counted at write
        assert.equal((await channels.replace("/doc.md", "body", "xyz")).status, 200);
        assert.equal((await entries.read("/doc.md")).entry?.channels.body.content, "xyz");
        const after = await db.channel_meta.get<{ contentLength: number }>({ entry_id: entryId, channel: "body" });
        assert.equal(after?.contentLength, 3);

        // setState → state transitions (verified through channel_meta)
        assert.equal((await channels.setState("/doc.md", "body", "closed")).status, 200);
        const meta = await db.channel_meta.get<{ state: string }>({ entry_id: entryId, channel: "body" });
        assert.equal(meta?.state, "closed");

        // absent entry / channel → 404
        const missingEntry = await channels.append("/missing.md", "body", "x");
        assert.equal(missingEntry.status, 404);
        assert.equal(missingEntry.problem?.type, "https://problems.plurnk.xyz/scheme/notes/entry-not-found");
        const missingReplace = await channels.replace("/doc.md", "nope", "x");
        assert.equal(missingReplace.problem?.type, "https://problems.plurnk.xyz/scheme/notes/channel-not-found");
        const missingState = await channels.setState("/doc.md", "nope", "closed");
        assert.equal(missingState.problem?.type, "https://problems.plurnk.xyz/scheme/notes/channel-not-found");
    } finally { await db.close(); }
});
}

// ─── functionality-environment.test.ts ───
{
test("{§env-knob} disabled definitions stay inspectable through workspace listing and inert discovery", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    const definitions = {
        mcp: { name: "other", type: "streamable-http", url: "https://mcp.example", headers: { "X-Tenant": "${TENANT}" } },
        schedule: { rule: "DTSTART;TZID=UTC:20260917T120001\nRRULE:FREQ=HOURLY", target: "session://bot", prompt: "Check in." },
    };
    try {
        const workspaceId = await insertWorkspace(db, "resource-definitions");
        daemon.registerModule(McpModule.init({
            env: {
                ...process.env,
                PLURNK_MCP_other: JSON.stringify(definitions.mcp),
                PLURNK_MCP_ENABLED: "1",
                PLURNK_MCP_other_ENABLED: "0",
            },
        }), "@plurnk/plurnk-mcp");
        const schedule = ScheduleModule.init({
            env: {
                ...process.env,
                TZ: "UTC",
                PLURNK_SCHEDULE_other: JSON.stringify(definitions.schedule),
                PLURNK_SCHEDULE_ENABLED: "1",
                PLURNK_SCHEDULE_other_ENABLED: "0",
            },
            timers: { set: () => assert.fail("disabled schedules must not arm"), clear: () => {} },
        });
        daemon.registerModule(schedule, "@plurnk/plurnk-schedule");
        await daemon.start();
        const invoke = (family: string, verb: string, params: Record<string, unknown> = {}) =>
            daemon.invokeModuleAction(`workspace.${family}.${verb}`, params, { scope: "workspace", workspaceId });
        for (const family of ["mcp", "schedule"] as const) {
            const result = await invoke(family, "list") as FunctionalityListResult;
            assert.deepEqual(result.definitions.map(({ alias, state, origin }) => ({ alias, state, origin })), [
                { alias: "other", state: "disabled", origin: "service" },
            ], family);
            assert.deepEqual(result.definitions[0]?.definition, definitions[family], "disabling preserves the complete inspectable definition");
            assert.deepEqual(result.definitions[0]?.provenance,
                { kind: "environment", source: `PLURNK_${family.toUpperCase()}_other` }, "the adapter carries the source through validation and projection");
            await assert.rejects(() => invoke(family, "enable", { alias: "absent" }), (error: unknown) => {
                assert.ok(error instanceof OperationFailureError);
                const { problem } = error.result;
                assert.equal(problem.status, 404);
                assert.match(problem.type, /\/alias-unknown$/u);
                return true;
            });
        }
        const discovered = await invoke("schedule", "discover", { source: "DTSTART;TZID=UTC:20260917T120001\nRRULE:FREQ=HOURLY" }) as { candidates: Array<{ alias: string; definition: unknown }> };
        assert.equal(discovered.candidates.length, 1);
        const listed = await invoke("schedule", "list") as FunctionalityListResult;
        assert.deepEqual(listed.definitions.map(({ alias, state, definition }) => ({ alias, state, definition })), [
            { alias: "other", state: "disabled", definition: definitions.schedule },
        ], "discovery does not change workspace state");
        assert.deepEqual(schedule.functionality.scheduler.armed(workspaceId), []);
    } finally {
        await daemon.stop();
        await db.close();
    }
});
}

// ─── schedule-discovery.test.ts ───
{
// {§schedule-family} — the schedule family arrives by discovery like any installed module: it
// registers before durable lifecycle recovery and arms the coordinator's persisted rules at start.






// The discovered module reads the operator's environment, as the service's would.
const environment = (t: TestContext): void => {
    const values = { TZ: "UTC", PLURNK_SCHEDULE_ENABLED: "1" };
    const prior = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
    Object.assign(process.env, values);
    t.after(() => { for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
};

test("{§schedule-family} a discovered schedule rejects malformed persisted enabledness before arming", async (t) => {
    environment(t);
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "discovered-invalid-schedule");
    await db.workspace_module_state_put.run({
        workspace_id: workspaceId,
        namespace_owner: "@plurnk/plurnk-schedule",
        state: JSON.stringify({ version: 1, definitions: { beat: {
            origin: "workspace", enabled: "false",
            definition: { rule: "DTSTART;TZID=UTC:20260917T120001\nRRULE:FREQ=HOURLY;COUNT=2", target: "session://recipient", prompt: "Must not fire." },
        } } }),
    });
    const daemon = new Daemon({ db, provider: null });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await assert.rejects(daemon.start(), { name: "Error", message: "Functionality state for schedule alias 'beat' is malformed." });
});

test("{§schedule-family} a discovered schedule arms a persisted rule at restart and delivers it on time", { timeout: 30_000 }, async (t) => {
    environment(t);
    const db = await openMigrated();
    const first = new Daemon({ db, provider: null });
    await first.start();
    const { workspaceId } = await first.createWorkspace({ name: "discovered-schedule", projectRoot: null });
    const { sessionName } = await first.createSession({ workspaceId, name: "recipient" });
    const due = new Date(Math.ceil((Date.now() + 4_000) / 1_000) * 1_000);
    const stamp = due.toISOString().replaceAll(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "");
    const added = await first.invokeModuleAction("workspace.schedule.add", {
        alias: "once",
        definition: { rule: `DTSTART;TZID=UTC:${stamp}\nRRULE:FREQ=HOURLY;COUNT=1`, target: `session://${sessionName}`, prompt: "discovered-proof" },
    }, { scope: "workspace", workspaceId }) as { status: number };
    assert.equal(added.status, 201);
    await first.stop();

    const provider = new Mock({ contextWindow: 65_536, responses: [{ assistant: { content: "````SEND [200]\nReceived.\n````", reasoning: null } }] });
    const second = new Daemon({ db, provider });
    t.after(async () => { await second.stop(); await db.close(); });
    await second.start();
    await waitForDb(async () => provider.received.length, (calls) => calls >= 1, { timeoutMs: 15_000 });
    assert.match(JSON.stringify(provider.received[0]), /discovered-proof/u, "the restarted daemon's discovered family delivered the persisted rule");
});
}
