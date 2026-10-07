// {§configuration-repair-path} — the ordinary agent remains its own repair environment.
import assert from "node:assert/strict";
import test from "node:test";
import { Mock } from "@plurnk/plurnk-providers";
import { Problems, type Notice, type OperationResult } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import { insertWorkspace, insertWorker, openMigrated } from "./_db.ts";
import { makeMockResponse, userText } from "./_mock.ts";
import { waitFor } from "./_rpc.ts";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import ConfigurationDiagnostics from "../../src/server/ConfigurationDiagnostics.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import { BaseExecutor, type ExecArgs, type ExecutorMetadata } from "@plurnk/plurnk-execs";

test("{§configuration-repair-path} a misconfigured installed executor leaves its sibling usable and its own invocation truthful", { timeout: 30_000 }, async (t) => {
    const key = "PLURNK_FIXTURE_ENDPOINT";
    const ran: string[] = [];
    class FixtureExecutor extends BaseExecutor {
        constructor(metadata: ExecutorMetadata) {
            super(metadata);
            if (this.runtime === "brokenfixture") throw new ConfigurationError(key, `${key} requires a configured endpoint.`);
        }
        get channels() { return { body: { mimetype: "text/plain" } }; }
        async run(args: ExecArgs) {
            ran.push(this.runtime);
            args.write("body", "healthy executor output");
            return { status: 200 };
        }
    }
    const build = ExecutorRegistry.build.bind(ExecutorRegistry);
    t.mock.method(ExecutorRegistry, "build", () => build({
        discoverFn: async () => ({ registry: new Map(["healthyfixture", "brokenfixture"].map((runtime) => [runtime, {
            runtime, glyph: "x", summary: `${runtime} fixture.`, details: "", packageName: "executor-fixture",
            invocation: { body: { role: "input", required: true }, example: { body: "inspect" } },
        }])) }),
        load: async () => ({ default: FixtureExecutor }),
    }));
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `constructor-repair-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId, null, "repair", "model");
    const provider = new Mock({ contextWindow: 1_000_000, responses: [
        makeMockResponse("````brokenfixture\ninspect\n````\n\n````healthyfixture\ninspect\n````"),
        makeMockResponse("````KILL\nThe healthy executor worked; the other needs its endpoint configured.\n````"),
    ] });
    const daemon = new Daemon({ db, provider });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    assert.ok(daemon.configurationNotices().some((notice) => notice.owner === "executor:brokenfixture" && notice.key === key));
    assert.equal(daemon.schemes.has("brokenfixture"), false, "no executable output scheme is invented");
    assert.equal(daemon.schemes.has("healthyfixture"), true);
    const ended: Array<{ loopId: number; result: OperationResult }> = [];
    t.after(daemon.subscribeToEvents((_id, method, params) => {
        if (method === "loop/terminated") ended.push(params as typeof ended[number]);
    }));
    const started = await daemon.runLoop({ workspaceId, workerId, prompt: "Inspect both executor outcomes.", policy: { proposals: "accept" } });
    await waitFor(() => ended, (items) => items.some(({ loopId }) => loopId === started.loopId), { timeoutMs: 20_000 });
    assert.equal(ended.find(({ loopId }) => loopId === started.loopId)?.result.status, 200);
    assert.deepEqual(ran, ["healthyfixture"]);
    assert.match(userText(provider.received[1]), /healthy executor output/u);
    const rows = await db.test_log_entries_by_loop.all<{ op: string; rx: string }>({ loop_id: started.loopId });
    const failed = rows.find((row) => row.op === "brokenfixture");
    assert.ok(failed);
    const result = JSON.parse(failed.rx) as OperationResult;
    assert.equal(result.status, 503);
    assert.equal(result.problem?.key, key);
});

test("{§configuration-repair-path} invalid scratch configuration does not block an inline program", { timeout: 30_000 }, async (t) => {
    const previous = process.env.PLURNK_SERVICE_EXEC_SCRATCH;
    process.env.PLURNK_SERVICE_EXEC_SCRATCH = "relative";
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_EXEC_SCRATCH;
        else process.env.PLURNK_SERVICE_EXEC_SCRATCH = previous;
    });
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `inline-repair-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId, null, "repair", "model");
    const provider = new Mock({ contextWindow: 1_000_000, responses: [
        makeMockResponse("````sh\nprintf inline-still-works\n````"),
        makeMockResponse("````KILL\nThe inline program worked.\n````"),
    ] });
    const daemon = new Daemon({ db, provider });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const ended: Array<{ loopId: number; result: OperationResult }> = [];
    t.after(daemon.subscribeToEvents((_id, method, params) => {
        if (method === "loop/terminated") ended.push(params as typeof ended[number]);
    }));
    const started = await daemon.runLoop({ workspaceId, workerId, prompt: "Run an inline program.", policy: { proposals: "accept" } });
    await waitFor(() => ended, (items) => items.some(({ loopId }) => loopId === started.loopId), { timeoutMs: 20_000 });
    assert.equal(ended.find(({ loopId }) => loopId === started.loopId)?.result.status, 200);
    assert.match(userText(provider.received[1]), /inline-still-works/u);
});

for (const [key, invocation] of [
    ["PLURNK_SERVICE_EXEC_CONCURRENCY", "sh"],
    ["PLURNK_SERVICE_EXEC_INPUT_TIMEOUT_MS", "sh"],
    ["PLURNK_SERVICE_EXEC_PROBE_TIMEOUT_MS", "sh"],
    ["PLURNK_SERVICE_EXEC_SCRATCH", "sh (worker:///program.sh)"],
] as const) {
    test(`{§configuration-repair-path} ${key} refuses the execution without blocking ordinary READ and EDIT`, { timeout: 30_000 }, async (t) => {
        const previous = process.env[key];
        process.env[key] = "invalid";
        t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
        const db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `executor-repair-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId, null, "repair", "model");
        const provider = new Mock({ contextWindow: 1_000_000, responses: [
            makeMockResponse(`\`\`\`\`${invocation}\nprintf should-not-run\n\`\`\`\`\n\n\`\`\`\`EDIT (worker:///repair.txt)\nrepair remains available\n\`\`\`\``),
            makeMockResponse("````READ (worker:///repair.txt)\n````"),
            makeMockResponse("````KILL\nOrdinary editing and inspection still work.\n````"),
        ] });
        const daemon = new Daemon({ db, provider });
        t.after(async () => { await daemon.stop(); await db.close(); });
        await daemon.start();
        assert.ok(daemon.configurationNotices().some((notice) => notice.key === key), "the unavailable execution configuration is visible at startup");
        const ended: Array<{ loopId: number; result: OperationResult }> = [];
        t.after(daemon.subscribeToEvents((_id, method, params) => {
            if (method === "loop/terminated") ended.push(params as typeof ended[number]);
        }));
        const started = await daemon.runLoop({ workspaceId, workerId, prompt: "Inspect and repair the configuration.", policy: { proposals: "accept" } });
        await waitFor(() => ended, (items) => items.some(({ loopId }) => loopId === started.loopId), { timeoutMs: 20_000 });
        assert.equal(ended.find(({ loopId }) => loopId === started.loopId)?.result.status, 200);
        assert.equal(provider.received.length, 3);
        assert.ok(userText(provider.received[0]).includes(key));
        assert.match(userText(provider.received[2]), /repair remains available/u);
        const rows = await db.test_log_entries_by_loop.all<{ op: string; rx: string; status_rx: number }>({ loop_id: started.loopId });
        const execution = rows.find((row) => row.op === "sh");
        assert.ok(execution, "the authored execution receives an ordinary operation result");
        const result = JSON.parse(execution.rx) as OperationResult;
        assert.equal(result.status, 503);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/daemon/configuration/configuration-invalid");
        assert.equal(result.problem?.key, key);
        assert.equal(rows.filter((row) => row.status_rx === 202).length, 0, "no pending proposal or stream is left behind");
    });
}

for (const key of [
    "PLURNK_SERVICE_EFFECT_HOST", "PLURNK_SERVICE_FILE_CREATE_SCOPE", "PLURNK_SERVICE_ATTENDED",
    "PLURNK_SERVICE_RETAIN_PACKET_TURNS", "PLURNK_SERVICE_COLLECT_CONTENTS", "PLURNK_SERVICE_AUTO_VACUUM",
] as const) {
    test(`{§configuration-repair-path} ${key} preserves an explicitly configured model loop and inspection`, async (t) => {
        const previous = process.env[key];
        process.env[key] = "invalid";
        t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
        const db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `policy-repair-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId, null, "repair", "model");
        const provider = new Mock({ contextWindow: 1_000_000, responses: [
            makeMockResponse("````env (list)\n````"),
            makeMockResponse("````KILL\nConfiguration is inspectable.\n````"),
        ] });
        const daemon = new Daemon({ db, provider });
        t.after(async () => { await daemon.stop(); await db.close(); });
        await daemon.start();
        assert.ok(daemon.configurationNotices().some((notice) => notice.key === key));
        const ended: Array<{ loopId: number; result: OperationResult }> = [];
        t.after(daemon.subscribeToEvents((_id, method, params) => {
            if (method === "loop/terminated") ended.push(params as typeof ended[number]);
        }));
        if (key === "PLURNK_SERVICE_ATTENDED") await assert.rejects(
            daemon.runLoop({ workspaceId, workerId, prompt: "no implicit policy" }),
            (cause: unknown) => {
                const problem = Problems.fromError(cause);
                assert.equal(problem?.status, 503);
                assert.equal(problem?.key, key);
                return true;
            },
        );
        const started = await daemon.runLoop({ workspaceId, workerId, prompt: "Inspect the configuration error.", policy: { proposals: "accept", attended: true } });
        await waitFor(() => ended, (items) => items.some(({ loopId }) => loopId === started.loopId), { timeoutMs: 20_000 });
        assert.equal(ended.find(({ loopId }) => loopId === started.loopId)?.result.status, 200);
        assert.match(userText(provider.received[1]), /"family":\s*"env"/u);
    });
}

test("{§configuration-repair-path} retired packet configuration preserves startup and reports the failed demand before inference", async (t) => {
    const key = "PLURNK_SERVICE_PROMPT_BUDGET";
    const previous = process.env[key];
    process.env[key] = "1024";
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `packet-repair-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId, null, "repair", "model");
    const provider = new Mock({ contextWindow: 1_000_000, responses: [makeMockResponse("````KILL\nRepaired.\n````")] });
    const daemon = new Daemon({ db, provider });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    assert.ok(daemon.configurationNotices().some((notice) => notice.key === key));
    const ended: Array<{ loopId: number; result: OperationResult }> = [];
    t.after(daemon.subscribeToEvents((_id, method, params) => {
        if (method === "loop/terminated") ended.push(params as typeof ended[number]);
    }));
    const failed = await daemon.runLoop({ workspaceId, workerId, prompt: "Inspect.", policy: { proposals: "accept" } });
    await waitFor(() => ended, (items) => items.some(({ loopId }) => loopId === failed.loopId), { timeoutMs: 20_000 });
    const result = ended.find(({ loopId }) => loopId === failed.loopId)?.result;
    assert.equal(result?.status, 503);
    assert.equal(result?.problem?.key, key);
    assert.equal(provider.received.length, 0, "an invalid packet policy never reaches the provider");
    delete process.env[key];
    const repaired = await daemon.runLoop({ workspaceId, workerId, prompt: "The setting is corrected.", policy: { proposals: "accept" } });
    await waitFor(() => ended, (items) => items.some(({ loopId }) => loopId === repaired.loopId), { timeoutMs: 20_000 });
    assert.equal(ended.find(({ loopId }) => loopId === repaired.loopId)?.result.status, 200);
    assert.equal(provider.received.length, 1);
});

test("{§configuration-repair-path} startup diagnostics reach the model and client once while ordinary operations still execute", { timeout: 30_000 }, async (t) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `startup-repair-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId, null, "repair", "model");
    const configuration = new ConfigurationDiagnostics();
    const key = "PLURNK_HOOKS_ARGS";
    await configuration.capture("hooks", () => { throw new ConfigurationError(key, `${key} must be a JSON array of strings.`); });
    const provider = new Mock({ contextWindow: 1_000_000, responses: [
        makeMockResponse("````env (list)\n````"),
        makeMockResponse("````KILL\nThe hook configuration needs repair; ordinary operations remain available.\n````"),
    ] });
    const daemon = new Daemon({ db, provider, configuration });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const ended: Array<{ loopId: number; result: OperationResult }> = [];
    const notices: Notice[] = [];
    t.after(daemon.subscribeToEvents((_id, method, params) => {
        if (method === "loop/terminated") ended.push(params as typeof ended[number]);
        if (method === "notice/event") notices.push((params as { notice: Notice }).notice);
    }));
    const started = await daemon.runLoop({ workspaceId, workerId, prompt: "Inspect the environment and report the configuration problem.", policy: { proposals: "accept" } });
    await waitFor(() => ended, (items) => items.some(({ loopId }) => loopId === started.loopId), { timeoutMs: 20_000 });
    assert.equal(ended.find(({ loopId }) => loopId === started.loopId)?.result.status, 200);
    assert.equal(provider.received.length, 2);
    assert.ok(userText(provider.received[0]).includes(key), "the model receives the exact startup diagnostic before choosing operations");
    assert.match(userText(provider.received[1]), /"family":\s*"env"/u, "ordinary inspection executes through the normal operation path");
    assert.equal(notices.filter((notice) => notice.key === key).length, 1, "unchanged diagnostics do not recur every turn");
});

for (const [family, key, value] of [
    ["mcp", "PLURNK_MCP_GH_BEARER", "fixture-secret-must-not-appear"],
    ["mcp", "PLURNK_MCP_broken", "{}"],
    ["mcp", "PLURNK_MCP_ENABLED", "invalid"],
    ["mcp", "PLURNK_MCP_future_TOOLS", "invalid"],
    ["a2a", "PLURNK_A2A_broken", "{}"],
    ["schedule", "PLURNK_SCHEDULE_broken", "{}"],
    ["members", "PLURNK_MEMBERS_broken", "!"],
    ["skills", "PLURNK_SKILLS_broken", "{}"],
    ["skills", "PLURNK_SKILLS_FETCH_TIMEOUT_MS", "bad"],
    ["skills", "PLURNK_SERVICE_ROOTS", "unknown"],
] as const) {
    test(`{§configuration-repair-path} ${key} leaves a model able to inspect the error and use another family`, { timeout: 30_000 }, async (t) => {
        const previous = process.env[key];
        const previousMcpEnabled = process.env.PLURNK_MCP_ENABLED;
        if (key === "PLURNK_MCP_GH_BEARER") process.env.PLURNK_MCP_ENABLED = "0";
        process.env[key] = value;
        t.after(() => {
            if (previous === undefined) delete process.env[key];
            else process.env[key] = previous;
            if (previousMcpEnabled === undefined) delete process.env.PLURNK_MCP_ENABLED;
            else process.env.PLURNK_MCP_ENABLED = previousMcpEnabled;
        });
        const db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `repair-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId, null, "repair", "model");
        const provider = new Mock({ contextWindow: 1_000_000, responses: [
            makeMockResponse(`\`\`\`\`${family} (list)\n\`\`\`\`\n\n\`\`\`\`env (list)\n\`\`\`\``),
            makeMockResponse("````KILL\nThe configuration error is visible; this agent is still usable.\n````"),
        ] });
        const daemon = new Daemon({ db, provider });
        t.after(async () => { await daemon.stop(); await db.close(); });
        await daemon.start();
        await assert.rejects(
            daemon.invokeModuleAction(`workspace.${family}.list`, {}, { scope: "workspace", workspaceId }),
            (cause: unknown) => {
                const problem = Problems.fromError(cause);
                assert.equal(problem?.type, "https://problems.plurnk.xyz/functionality/configuration-invalid");
                assert.equal(problem?.status, 503);
                assert.ok(problem?.detail?.includes(key), "the exact configuration key is inspectable");
                assert.doesNotMatch(JSON.stringify(problem), /fixture-secret-must-not-appear/u);
                return true;
            },
        );
        const ended: Array<{ loopId: number; result: OperationResult }> = [];
        const notices: Notice[] = [];
        const unsubscribe = daemon.subscribeToEvents((_id, method, params) => {
            if (method === "loop/terminated") ended.push(params as typeof ended[number]);
            if (method === "notice/event") notices.push((params as { notice: Notice }).notice);
        });
        t.after(unsubscribe);
        const started = await daemon.runLoop({ workspaceId, workerId, prompt: "Inspect the configuration problem, list the environment, and report.", policy: { proposals: "accept" } });
        await waitFor(() => ended, (items) => items.some(({ loopId }) => loopId === started.loopId), { timeoutMs: 20_000 });
        assert.equal(ended.find(({ loopId }) => loopId === started.loopId)?.result.status, 200);
        assert.equal(provider.received.length, 2, "a configuration error does not prevent inference or recovery");
        const firstPacket = userText(provider.received[0]);
        const recoveryPacket = userText(provider.received[1]);
        assert.match(firstPacket, /configuration_unavailable/u, "the unavailable family is reported before invocation, independently of turn0 catalog limits");
        assert.ok(firstPacket.includes(key), "the model is told which setting is invalid before it calls the family");
        const references = await daemon.engine.referenceEntries(workspaceId);
        const documentation = references.find(({ pathname }) => pathname === `/_plurnk/plurnk/${family}.md`);
        assert.ok(documentation?.content.includes(key), "the manager's on-demand documentation also includes the diagnostic");
        assert.equal(notices.filter((notice) => notice.source === "engine:configuration" && notice.key === key && notice.owner === family).length, 1,
            "the client receives the diagnostic without repeated warnings on unchanged turns");
        assert.ok(recoveryPacket.includes(key), "the model receives the configuration Problem through normal operation output");
        assert.match(recoveryPacket, /"family":\s*"env"/u, "an unrelated family remains operational");
        assert.doesNotMatch(recoveryPacket, /fixture-secret-must-not-appear/u);
    });
}
