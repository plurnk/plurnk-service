// {§configuration-repair-path} — the ordinary agent remains its own repair environment.
import assert from "node:assert/strict";
import test from "node:test";
import { Mock } from "@plurnk/plurnk-providers";
import { Problems, type Notice, type OperationResult } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import ServiceModules from "../../src/server/ServiceModules.ts";
import { insertWorkspace, insertWorker, openMigrated } from "./_db.ts";
import { makeMockResponse, userText } from "./_mock.ts";
import { waitFor } from "./_rpc.ts";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import ConfigurationDiagnostics from "../../src/server/ConfigurationDiagnostics.ts";

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
    ServiceModules.registerWorkspaceCapabilities(daemon);
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
    ["skills", "PLURNK_SERVICE_SKILLS_FETCH_TIMEOUT_MS", "bad"],
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
        ServiceModules.registerWorkspaceCapabilities(daemon);
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
        assert.equal(notices.filter((notice) => notice.source === "engine:configuration" && notice.key === key && notice.family === family).length, 1,
            "the client receives the diagnostic without repeated warnings on unchanged turns");
        assert.ok(recoveryPacket.includes(key), "the model receives the configuration Problem through normal operation output");
        assert.match(recoveryPacket, /"family":\s*"env"/u, "an unrelated family remains operational");
        assert.doesNotMatch(recoveryPacket, /fixture-secret-must-not-appear/u);
    });
}
