import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Daemon from "../../src/server/Daemon.ts";
import ConfigurationDiagnostics from "../../src/server/ConfigurationDiagnostics.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import Envelope from "../../src/server/envelope.ts";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Notice, Problems, type OperationResult } from "@plurnk/plurnk-contracts";
import { insertWorkspace, openMigrated, insertSession } from "./_db.ts";
import { waitFor, rpcCall, rpcProblem, connect, withDaemon, subscribeNotifications, runLoopToTerminal } from "./_rpc.ts";
import { serverProposals } from "./_approval.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { makeMockResponse, userText } from "./_mock.ts";
import { BaseExecutor, type ExecArgs, type ExecutorMetadata } from "@plurnk/plurnk-execs";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { promisify } from "node:util";
import { type Db } from "../../src/core/Db.ts";
import { viableWindow } from "./_provider.ts";

describe("configuration-recovery", () => {
test("{§configuration-repair-path} a misconfigured installed executor leaves its sibling usable and its own invocation truthful", { timeout: 30_000 }, async (t) => {
    serverProposals(t, "accept");
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
    const sessionId = await insertSession(db, workspaceId, null, "repair", "model");
    const provider = new Mock({ contextWindow: 1_000_000, responses: [
        makeMockResponse("````brokenfixture\ninspect\n````\n\n````healthyfixture\ninspect\n````"),
        makeMockResponse("````SEND [200]\nThe healthy executor worked; the other needs its endpoint configured.\n````"),
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
    const started = await daemon.runLoop({ workspaceId, sessionId, prompt: "Inspect both executor outcomes." });
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
    serverProposals(t, "accept");
    const previous = process.env.PLURNK_SERVICE_EXEC_SCRATCH;
    process.env.PLURNK_SERVICE_EXEC_SCRATCH = "relative";
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_EXEC_SCRATCH;
        else process.env.PLURNK_SERVICE_EXEC_SCRATCH = previous;
    });
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `inline-repair-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId, null, "repair", "model");
    const provider = new Mock({ contextWindow: 1_000_000, responses: [
        makeMockResponse("````sh\nprintf inline-still-works\n````"),
        makeMockResponse("````SEND [200]\nThe inline program worked.\n````"),
    ] });
    const daemon = new Daemon({ db, provider });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const ended: Array<{ loopId: number; result: OperationResult }> = [];
    t.after(daemon.subscribeToEvents((_id, method, params) => {
        if (method === "loop/terminated") ended.push(params as typeof ended[number]);
    }));
    const started = await daemon.runLoop({ workspaceId, sessionId, prompt: "Run an inline program." });
    await waitFor(() => ended, (items) => items.some(({ loopId }) => loopId === started.loopId), { timeoutMs: 20_000 });
    assert.equal(ended.find(({ loopId }) => loopId === started.loopId)?.result.status, 200);
    assert.match(userText(provider.received[1]), /inline-still-works/u);
});

for (const [key, invocation] of [
    ["PLURNK_SERVICE_EXEC_CONCURRENCY", "sh"],
    ["PLURNK_SERVICE_EXEC_PROBE_TIMEOUT_MS", "sh"],
    ["PLURNK_SERVICE_EXEC_SCRATCH", "sh (workspace:///program.sh)"],
] as const) {
    test(`{§configuration-repair-path} ${key} refuses the execution without blocking ordinary READ and EDIT`, { timeout: 30_000 }, async (t) => {
    serverProposals(t, "accept");
        const previous = process.env[key];
        process.env[key] = "invalid";
        t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
        const db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `executor-repair-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "repair", "model");
        const provider = new Mock({ contextWindow: 1_000_000, responses: [
            makeMockResponse(`\`\`\`\`${invocation}\nprintf should-not-run\n\`\`\`\`\n\n\`\`\`\`EDIT (workspace:///repair.txt)\nrepair remains available\n\`\`\`\``),
            makeMockResponse("````READ (workspace:///repair.txt)\n````"),
            makeMockResponse("````SEND [200]\nOrdinary editing and inspection still work.\n````"),
        ] });
        const daemon = new Daemon({ db, provider });
        t.after(async () => { await daemon.stop(); await db.close(); });
        await daemon.start();
        assert.ok(daemon.configurationNotices().some((notice) => notice.key === key), "the unavailable execution configuration is visible at startup");
        const ended: Array<{ loopId: number; result: OperationResult }> = [];
        t.after(daemon.subscribeToEvents((_id, method, params) => {
            if (method === "loop/terminated") ended.push(params as typeof ended[number]);
        }));
        const started = await daemon.runLoop({ workspaceId, sessionId, prompt: "Inspect and repair the configuration." });
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
    "PLURNK_SERVICE_EFFECT_HOST", "PLURNK_SERVICE_FILE_CREATE_SCOPE", "PLURNK_SERVICE_PROPOSALS",
    "PLURNK_SERVICE_RETAIN_PACKET_TURNS", "PLURNK_SERVICE_COLLECT_CONTENTS", "PLURNK_SERVICE_AUTO_VACUUM",
] as const) {
    test(`{§configuration-repair-path} ${key} preserves an explicitly configured model loop and inspection`, async (t) => {
        serverProposals(t, "accept");
        const previous = process.env[key];
        process.env[key] = "invalid";
        t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
        const db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `policy-repair-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "repair", "model");
        const provider = new Mock({ contextWindow: 1_000_000, responses: [
            makeMockResponse("````plurnk_env (list)\n````"),
            makeMockResponse("````SEND [200]\nConfiguration is inspectable.\n````"),
        ] });
        const daemon = new Daemon({ db, provider });
        t.after(async () => { await daemon.stop(); await db.close(); });
        await daemon.start();
        assert.ok(daemon.configurationNotices().some((notice) => notice.key === key));
        const ended: Array<{ loopId: number; result: OperationResult }> = [];
        t.after(daemon.subscribeToEvents((_id, method, params) => {
            if (method === "loop/terminated") ended.push(params as typeof ended[number]);
        }));
        const started = await daemon.runLoop({ workspaceId, sessionId, prompt: "Inspect the configuration error." });
        await waitFor(() => ended, (items) => items.some(({ loopId }) => loopId === started.loopId), { timeoutMs: 20_000 });
        assert.equal(ended.find(({ loopId }) => loopId === started.loopId)?.result.status, 200);
        assert.match(userText(provider.received[1]), /"family":\s*"env"/u);
    });
}

test("{§configuration-repair-path} startup diagnostics reach the model and client once while ordinary operations still execute", { timeout: 30_000 }, async (t) => {
    serverProposals(t, "accept");
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `startup-repair-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId, null, "repair", "model");
    const configuration = new ConfigurationDiagnostics();
    const key = "PLURNK_HOOKS_ARGS";
    await configuration.capture("hooks", () => { throw new ConfigurationError(key, `${key} must be a JSON array of strings.`); });
    const provider = new Mock({ contextWindow: 1_000_000, responses: [
        makeMockResponse("````plurnk_env (list)\n````"),
        makeMockResponse("````SEND [200]\nThe hook configuration needs repair; ordinary operations remain available.\n````"),
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
    const started = await daemon.runLoop({ workspaceId, sessionId, prompt: "Inspect the environment and report the configuration problem." });
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
    ["schedule", "PLURNK_SCHEDULE_broken", "{}"],
    ["members", "PLURNK_MEMBERS_broken", "!"],
    ["skills", "PLURNK_SKILLS_broken", "{}"],
    ["skills", "PLURNK_SKILLS_FETCH_TIMEOUT_MS", "bad"],
    ["skills", "PLURNK_SERVICE_ROOTS", "unknown"],
] as const) {
    test(`{§configuration-repair-path} ${key} leaves a model able to inspect the error and use another family`, { timeout: 30_000 }, async (t) => {
    serverProposals(t, "accept");
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
        const sessionId = await insertSession(db, workspaceId, null, "repair", "model");
        const provider = new Mock({ contextWindow: 1_000_000, responses: [
            makeMockResponse(`\`\`\`\`plurnk_${family} (list)\n\`\`\`\`\n\n\`\`\`\`plurnk_env (list)\n\`\`\`\``),
            makeMockResponse("````SEND [200]\nThe configuration error is visible; this agent is still usable.\n````"),
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
        const started = await daemon.runLoop({ workspaceId, sessionId, prompt: "Inspect the configuration problem, list the environment, and report." });
        await waitFor(() => ended, (items) => items.some(({ loopId }) => loopId === started.loopId), { timeoutMs: 20_000 });
        assert.equal(ended.find(({ loopId }) => loopId === started.loopId)?.result.status, 200);
        assert.equal(provider.received.length, 2, "a configuration error does not prevent inference or recovery");
        const firstPacket = userText(provider.received[0]);
        const recoveryPacket = userText(provider.received[1]);
        assert.match(firstPacket, /configuration_unavailable/u, "the unavailable family is reported before invocation, independently of turn0 catalog limits");
        assert.ok(firstPacket.includes(key), "the model is told which setting is invalid before it calls the family");
        const references = await daemon.engine.referenceEntries(workspaceId);
        const documentation = references.find(({ scheme, pathname }) => scheme === "mcp" && pathname === `/plurnk_${family}.md`);
        assert.ok(documentation?.content.includes(key), "the manager's on-demand documentation also includes the diagnostic");
        assert.equal(notices.filter((notice) => notice.source === "engine:configuration" && notice.key === key && notice.owner === family).length, 1,
            "the client receives the diagnostic without repeated warnings on unchanged turns");
        assert.ok(recoveryPacket.includes(key), "the model receives the configuration Problem through normal operation output");
        assert.match(recoveryPacket, /"family":\s*"env"/u, "an unrelated family remains operational");
        assert.doesNotMatch(recoveryPacket, /fixture-secret-must-not-appear/u);
    });
}
});

describe("workspace-ceilings", () => {
const execFileP = promisify(execFile);

const twoEdits = () => new Mock({ contextWindow: viableWindow(), responses: [
    makeMockResponse("````EDIT (workspace:///a.md)\naaa\n````\n\n````EDIT (workspace:///b.md)\nbbb\n````\n\n````NOTE\ncontinue\n````", 50),
    makeMockResponse("````SEND [200]\ndone\n````", 50),
] });
const entryId = (db: Db, pathname: string) =>
    db.test_get_entry_id_by_scheme_pathname.get<{ id: number }>({ scheme: "workspace", pathname });

test("{§operator-config} workspace settings.maxCommands min()s the env action cap — tightens, never widens", async () => {
    const prev = process.env.PLURNK_SERVICE_MAX_COMMANDS;
    try {
        process.env.PLURNK_SERVICE_MAX_COMMANDS = "99";
        await withDaemon(twoEdits(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "mc-tighten", settings: { maxCommands: 1 } });
                await runLoopToTerminal(ws, 2, { prompt: "go" });
                assert.ok((await entryId(db, "/a.md"))?.id !== undefined, "the first model action dispatched");
                assert.equal(await entryId(db, "/b.md"), undefined, "the second action was dropped — workspace maxCommands:1 tightened env 99");
            } finally { ws.close(); }
        });
        process.env.PLURNK_SERVICE_MAX_COMMANDS = "1";
        await withDaemon(twoEdits(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "mc-nowiden", settings: { maxCommands: 99 } });
                await runLoopToTerminal(ws, 2, { prompt: "go" });
                assert.equal(await entryId(db, "/b.md"), undefined, "workspace maxCommands:99 cannot widen env 1 — the second action stays dropped");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_MAX_COMMANDS; else process.env.PLURNK_SERVICE_MAX_COMMANDS = prev;
    }
});

test("{§operator-config-workspace-settings} maxCommands:0 admits WAIT and drops every authored command", async () => {
    const prev = process.env.PLURNK_SERVICE_MAX_COMMANDS;
    try {
        process.env.PLURNK_SERVICE_MAX_COMMANDS = "99";
        const mock = new Mock({ contextWindow: viableWindow(), responses: [
            makeMockResponse("````EDIT (workspace:///a.md)\naaa\n````\n\n````EDIT (workspace:///b.md)\nbbb\n````\n\n````SEND\ndone\n````\n````WAIT\n````", 50),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                const logEntries = subscribeNotifications(ws, "log/entry");
                await rpcCall(ws, 1, "workspace.create", { name: "mc-zero", settings: { maxCommands: 0 } });
                const result = await runLoopToTerminal(ws, 2, { prompt: "go", maxTurns: 1 });
                assert.equal(result.finalStatus, 429, "the cap did not complete or answer the assignment");
                const modelOps = logEntries()
                    .map((e) => (e as { entry: { op: string; origin: string } }).entry)
                    .filter((e) => e.origin === "model")
                    .map((e) => e.op);
                assert.deepEqual(modelOps, ["WAIT"], "only WAIT dispatched — every authored command capped out");
                assert.equal(await entryId(db, "/a.md"), undefined, "the first EDIT action never landed at maxCommands:0");
                assert.equal(await entryId(db, "/b.md"), undefined, "the second EDIT action never landed");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_MAX_COMMANDS; else process.env.PLURNK_SERVICE_MAX_COMMANDS = prev;
    }
});

test("{§operator-config} workspace settings.git:false denies git membership for the workspace (env AND workspace)", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-git-deny-"));
    const db = await openMigrated();
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "tracked.md"), "# tracked by git\n");
        await execFileP("git", ["add", "tracked.md"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env: hermeticGitEnv() });

        const denied = await Envelope.createClientEnvelope(db, { name: `git-deny-${crypto.randomUUID()}`, projectRoot: root, settings: JSON.stringify({ git: false }) });
        const deniedMember = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: denied.workspaceId, scheme: "file", authority: "", pathname: "tracked.md" });
        assert.equal(deniedMember, undefined, "git:false denies git-ls-files membership — the tracked file is NOT a member");

        const allowed = await Envelope.createClientEnvelope(db, { name: `git-allow-${crypto.randomUUID()}`, projectRoot: root });
        const allowedMember = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: allowed.workspaceId, scheme: "file", authority: "", pathname: "tracked.md" });
        assert.notEqual(allowedMember, undefined, "without the override the tracked file IS a git member — so git:false is what denied it");
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§operator-config} workspace.create rejects malformed ceiling settings — fail hard, no silent accept", async () => {
    const mock = new Mock({ contextWindow: viableWindow(), responses: [makeMockResponse("````SEND [200]\ndone\n````", 50)] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const badMC = await rpcCall(ws, 1, "workspace.create", { name: "bad-mc", settings: { maxCommands: -1 } });
            const maxCommandsProblem = rpcProblem(badMC);
            assert.equal(maxCommandsProblem.type, "https://problems.plurnk.xyz/daemon/input/setting-invalid");
            assert.equal(maxCommandsProblem.field, "settings.maxCommands");
            assert.match(maxCommandsProblem.recovery ?? "", /non-negative integer/);
            const badGit = await rpcCall(ws, 2, "workspace.create", { name: "bad-git", settings: { git: "no" } });
            const gitProblem = rpcProblem(badGit);
            assert.equal(gitProblem.type, "https://problems.plurnk.xyz/daemon/input/setting-invalid");
            assert.equal(gitProblem.field, "settings.git");
            assert.match(gitProblem.recovery ?? "", /true or false/);
            const badScope = await rpcCall(ws, 3, "workspace.create", { name: "bad-scope", settings: { fileCreateScope: "all" } });
            const scopeProblem = rpcProblem(badScope);
            assert.equal(scopeProblem.type, "https://problems.plurnk.xyz/daemon/input/setting-invalid");
            assert.equal(scopeProblem.field, "settings.fileCreateScope");
            assert.match(scopeProblem.recovery ?? "", /none, root, namespace/);
        } finally { ws.close(); }
    });
});
});
