import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { configuredModule } from "../../../plurnk-hooks/test/environment.ts";
import { Mock, ProviderError } from "@plurnk/plurnk-providers";
import Daemon from "../../src/server/Daemon.ts";
import { openMigrated } from "./_db.ts";
import { viableWindow } from "./_provider.ts";
import { makeMockResponse } from "./_mock.ts";
import { makeRawMockResponse } from "./_mock.ts";
import type { ApplicationOperationEvent } from "@plurnk/plurnk-contracts";
import type { HookEvent } from "../../../plurnk-hooks/src/EventProjection.ts";
import type { ProposalProjection } from "@plurnk/plurnk-contracts";

interface TerminalEvent {
    readonly workspaceId: number;
    readonly method: string;
    readonly params: {
        readonly workerId: number;
        readonly loopId: number;
        readonly result: { readonly status: number; readonly problem?: { readonly detail: string } };
    };
}

const captureHooks = async (t: TestContext, daemon: Daemon, selection = "Stop") => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-hooks-lifecycle-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const script = join(root, "capture.mjs");
    const output = join(root, "events.jsonl");
    await writeFile(script, [
        'import { appendFile } from "node:fs/promises";',
        'let body = "";',
        'process.stdin.setEncoding("utf8");',
        'for await (const chunk of process.stdin) body += chunk;',
        'await appendFile(process.argv[2], body);',
    ].join("\n"));
    const failures: unknown[] = [];
    daemon.registerModule(configuredModule({
        PLURNK_HOOKS_COMMAND: process.execPath,
        PLURNK_HOOKS_ARGS: JSON.stringify([script, output]),
        PLURNK_HOOKS_EVENTS: selection,
        PLURNK_HOOKS_TIMEOUT_MS: "5000",
    }, (_message, cause) => { failures.push(cause); }));
    return {
        failures,
        events: async (): Promise<HookEvent[]> => (await readFile(output, "utf8")).trim().split("\n").map((line) => JSON.parse(line)),
    };
};

test("{§module-shutdown-order} command hooks receive real loop cancellation before observer closure", { timeout: 15_000 }, async (t) => {
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: viableWindow(), responses: [] });
    const entered = Promise.withResolvers<void>();
    provider.generate = async ({ signal }) => {
        assert.ok(signal);
        signal.throwIfAborted();
        entered.resolve();
        return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
    };
    const daemon = new Daemon({ db, provider });
    t.after(async () => {
        await daemon.stop();
        await db.close();
    });
    const hooks = await captureHooks(t, daemon);
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "hooks-lifecycle" });
    const workerId = await daemon.ensureModelWorker(workspaceId);
    const { loopId } = await daemon.runLoop({ workspaceId, workerId, prompt: "Wait for cancellation." });
    await entered.promise;
    await daemon.stop();
    assert.deepEqual(hooks.failures, []);
    const events = await hooks.events();
    assert.equal(events.length, 1, "one cancellation, one command delivery");
    assert.equal(events[0].hook_event_name, "Stop");
    assert.equal(events[0].session_id, String(workerId));
    const terminal = events[0].plurnk as TerminalEvent;
    assert.equal(terminal.workspaceId, workspaceId);
    assert.equal(terminal.method, "loop/terminated");
    assert.equal(terminal.params.workerId, workerId);
    assert.equal(terminal.params.loopId, loopId);
    assert.equal(terminal.params.result.status, 499);
});

for (const outcome of ["success", "failure", "delegation"] as const) {
    test(`{§hooks-command-delivery} real ${outcome} events retain their full payload and owning coordinates`, { timeout: 20_000 }, async (t) => {
        const db = await openMigrated();
        const provider = new Mock({ contextWindow: viableWindow() * 4, responses: (outcome === "delegation" ? [
            "````WORK (worker://child)\nComplete the delegated work.\n````\n\n````WAIT\nAwait the child.\n````",
            "````KILL\nChild work completed.\n````",
            "````KILL\nParent work completed.\n````",
        ] : ["````KILL\nWork completed.\n````"]).map((response) => makeMockResponse(response)) });
        if (outcome === "failure") {
            provider.generate = async () => { throw new ProviderError("mock", "request_rejected", "Fixture request rejected."); };
        }
        const daemon = new Daemon({ db, provider });
        t.after(async () => { await daemon.stop(); await db.close(); });
        const hooks = await captureHooks(t, daemon);
        await daemon.start();
        const { workspaceId } = await daemon.createWorkspace({ name: `hooks-${outcome}` });
        const workerId = await daemon.ensureModelWorker(workspaceId);
        const done = Promise.withResolvers<void>();
        const published: TerminalEvent[] = [];
        daemon.subscribeToEvents((scope, method, params) => {
            if (method !== "loop/terminated") return;
            published.push(JSON.parse(JSON.stringify({ workspaceId: scope, method, params })));
            if ((params as { workerId: number }).workerId === workerId) done.resolve();
        });
        const { loopId } = await daemon.runLoop({ workspaceId, workerId, prompt: "Exercise lifecycle notifications.", policy: { proposals: "accept" } });
        await done.promise;
        await daemon.stop();
        const projected = await hooks.events();
        assert.ok(projected.every((event) => event.hook_event_name === "Stop" && event.session_id === String((event.plurnk as TerminalEvent).params.workerId)));
        const events = projected.map((event) => event.plurnk as TerminalEvent);
        assert.deepEqual(hooks.failures, []);
        assert.deepEqual(events, published, "the executable receives the same event evidence as an in-process subscriber");
        assert.equal(events.length, outcome === "delegation" ? 2 : 1);
        const parent = events.find((event) => event.params.workerId === workerId);
        assert.ok(parent);
        assert.equal(parent.workspaceId, workspaceId);
        assert.equal(parent.params.loopId, loopId);
        assert.equal(parent.params.result.status, outcome === "failure" ? 400 : 200);
        if (outcome === "failure") assert.equal(parent.params.result.problem?.detail, "Fixture request rejected.");
        if (outcome === "delegation") {
            const child = events.find((event) => event.params.workerId !== workerId);
            assert.ok(child);
            assert.equal(child.workspaceId, workspaceId);
            assert.notEqual(child.params.loopId, loopId);
            assert.equal(child.params.result.status, 200);
        }
    });
}

test("{§notifications-operation-event} tool hooks bracket real dispatch, not fan-out rows or automatic observations", { timeout: 20_000 }, async (t) => {
    const db = await openMigrated();
    const root = await mkdtemp(join(tmpdir(), "plurnk-hook-project-"));
    const provider = new Mock({ contextWindow: viableWindow() * 4, responses: [
        makeMockResponse("````EDIT (worker:///one.txt)\nalpha\n````\n\n````EDIT (worker:///two.txt)\nbeta\n````\n\n````READ (worker:///*.txt)\n````\n\n````READ (worker:///missing.txt)\n````"),
        makeMockResponse("````KILL\nInspected both entries and the missing path.\n````"),
    ] });
    const daemon = new Daemon({ db, provider });
    t.after(async () => { await daemon.stop(); await db.close(); await rm(root, { recursive: true, force: true }); });
    const hooks = await captureHooks(t, daemon, "PreToolUse,PostToolUse,PostToolUseFailure,Stop");
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "hooks-tools", projectRoot: root });
    const workerId = await daemon.ensureModelWorker(workspaceId);
    const done = Promise.withResolvers<void>();
    daemon.subscribeToEvents((_scope, method) => { if (method === "loop/terminated") done.resolve(); });
    await daemon.runLoop({ workspaceId, workerId, prompt: "Write and inspect the entries.", policy: { proposals: "accept" } });
    await done.promise;
    await daemon.stop();
    assert.deepEqual(hooks.failures, []);
    const events = await hooks.events();
    const tools = events.filter(({ tool_use_id }) => tool_use_id !== undefined);
    assert.deepEqual(tools.map(({ hook_event_name, tool_name }) => [hook_event_name, tool_name]), [
        ["PreToolUse", "EDIT"], ["PostToolUse", "EDIT"],
        ["PreToolUse", "EDIT"], ["PostToolUse", "EDIT"],
        ["PreToolUse", "READ"], ["PostToolUse", "READ"],
        ["PreToolUse", "READ"], ["PostToolUseFailure", "READ"],
        ["PreToolUse", "KILL"], ["PostToolUse", "KILL"],
    ]);
    for (let index = 0; index < tools.length; index += 2) {
        const start = tools[index]!;
        const settled = tools[index + 1]!;
        assert.equal(start.tool_use_id, settled.tool_use_id);
        assert.equal(start.cwd, root);
        assert.equal(start.session_id, String(workerId));
        assert.equal(start.plurnk.workspaceId, workspaceId);
        assert.deepEqual(start.tool_input, settled.tool_input);
        assert.equal((start.plurnk.params as ApplicationOperationEvent).phase, "started");
        assert.equal((settled.plurnk.params as ApplicationOperationEvent).phase, "settled");
        assert.deepEqual(settled.tool_response, (settled.plurnk.params as ApplicationOperationEvent).result);
    }
    assert.equal(new Set(tools.filter(({ hook_event_name }) => hook_event_name === "PreToolUse").map(({ tool_use_id }) => tool_use_id)).size, 5);
    assert.equal((tools[5]!.tool_response as { rowsWritten: number }).rowsWritten, 2, "one post for the authored fan-out, two durable reads");
    assert.equal((tools[7]!.tool_response as { status: number }).status, 404);
    assert.equal(events.at(-1)!.hook_event_name, "Stop", "the terminal event follows all settled dispatches");
});

test("{§notifications-operation-event} concurrent BARE starts precede inference and correlate with ordered settlement", { timeout: 20_000 }, async (t) => {
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: viableWindow() * 4, responses: [
        makeMockResponse("````BARE\nFirst isolated question.\n````\n\n````BARE\nSecond isolated question.\n````"),
        makeMockResponse("````KILL\nBoth calls answered.\n````"),
    ] });
    const daemon = new Daemon({ db, provider });
    t.after(async () => { await daemon.stop(); await db.close(); });
    const sequence: string[] = [];
    const generate = provider.generate.bind(provider);
    const isolated = new Mock({ contextWindow: viableWindow() * 4,
        responses: [makeRawMockResponse("First isolated answer."), makeRawMockResponse("Second isolated answer.")],
    });
    provider.generate = async (args) => {
        if (args.callKind !== "bare") return generate(args);
        sequence.push("inference");
        assert.equal(sequence.filter((item) => item === "started").length, 2, "both starts precede concurrent provider calls");
        return isolated.generate(args);
    };
    const hooks = await captureHooks(t, daemon, "PreToolUse,PostToolUse");
    daemon.subscribeToEvents((_scope, method, params) => {
        if (method === "operation/event" && (params as ApplicationOperationEvent).statement.op === "BARE") sequence.push((params as ApplicationOperationEvent).phase);
    });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "hooks-bare" });
    const workerId = await daemon.ensureModelWorker(workspaceId);
    const done = Promise.withResolvers<void>();
    daemon.subscribeToEvents((_scope, method) => { if (method === "loop/terminated") done.resolve(); });
    await daemon.runLoop({ workspaceId, workerId, prompt: "Run isolated questions." });
    await done.promise;
    await daemon.stop();
    assert.deepEqual(hooks.failures, []);
    assert.deepEqual(sequence, ["started", "started", "inference", "inference", "settled", "settled"]);
    const events = (await hooks.events()).filter(({ tool_name }) => tool_name === "BARE");
    assert.deepEqual(events.map(({ hook_event_name }) => hook_event_name), ["PreToolUse", "PreToolUse", "PostToolUse", "PostToolUse"]);
    assert.deepEqual(events.slice(0, 2).map(({ tool_use_id }) => tool_use_id), events.slice(2).map(({ tool_use_id }) => tool_use_id));
    assert.notEqual(events[0]!.tool_use_id, events[1]!.tool_use_id);
});

for (const decision of ["accept", "reject"] as const) {
    test(`{§hooks-event-projection} a ${decision} proposal settles once; executor dispatch is not stream completion`, { timeout: 20_000 }, async (t) => {
        const db = await openMigrated();
        const root = await mkdtemp(join(tmpdir(), "plurnk-hook-exec-"));
        const release = join(root, "release");
        const command = `node -e 'const fs = require("node:fs"); const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) { console.log("hook-stream-finished"); clearInterval(timer); } }, 10);' '${release}'`;
        const provider = new Mock({ contextWindow: viableWindow() * 4, responses: [
            makeMockResponse(`\`\`\`\`sh\n${command}\n\`\`\`\`\n\n\`\`\`\`WAIT\nAwait the command.\n\`\`\`\``),
            makeMockResponse("````KILL\nThe command settled.\n````"),
        ] });
        const daemon = new Daemon({ db, provider });
        t.after(async () => { await daemon.stop(); await db.close(); await rm(root, { recursive: true, force: true }); });
        const hooks = await captureHooks(t, daemon, "PreToolUse,PostToolUse,PostToolUseFailure,PermissionRequest,Stop");
        const proposed = Promise.withResolvers<ProposalProjection>();
        const dispatched = Promise.withResolvers<ApplicationOperationEvent>();
        const done = Promise.withResolvers<void>();
        let concluded = false;
        const operations: ApplicationOperationEvent[] = [];
        daemon.subscribeToEvents((_scope, method, params) => {
            if (method === "loop/proposal") proposed.resolve(params as ProposalProjection);
            if (method === "operation/event") {
                const event = params as ApplicationOperationEvent;
                if (!("runtime" in event.statement) || event.statement.runtime !== "sh") return;
                operations.push(event);
                if (event.phase === "settled") dispatched.resolve(event);
            }
            if (method === "stream/concluded") concluded = true;
            if (method === "loop/terminated") done.resolve();
        });
        await daemon.start();
        const { workspaceId } = await daemon.createWorkspace({ name: `hooks-${decision}-exec`, projectRoot: root });
        const workerId = await daemon.ensureModelWorker(workspaceId);
        await daemon.runLoop({ workspaceId, workerId, prompt: "Execute after review.", policy: { proposals: "review", attended: true } });
        const proposal = await proposed.promise;
        assert.equal(proposal.disposition.owner, "client");
        assert.deepEqual(operations.map(({ phase }) => phase), ["started"], "a proposal is not post-tool settlement");
        daemon.resolveProposal(proposal.logEntryId, { decision });
        const settled = await dispatched.promise;
        assert.equal(settled.result?.status, decision === "accept" ? 200 : 400);
        if (decision === "reject") assert.match(settled.result?.problem?.type ?? "", /\/rejected$/);
        assert.equal(concluded, false, "post-tool dispatch must not pretend that the process has exited");
        if (decision === "accept") await writeFile(release, "ready");
        await done.promise;
        await daemon.stop();
        assert.deepEqual(hooks.failures, []);
        const events = await hooks.events();
        const tool = events.filter(({ tool_name }) => tool_name === "sh");
        assert.deepEqual(tool.map(({ hook_event_name }) => hook_event_name), ["PreToolUse", "PermissionRequest", decision === "accept" ? "PostToolUse" : "PostToolUseFailure"]);
        assert.equal(tool[0]!.tool_use_id, tool[2]!.tool_use_id);
        assert.deepEqual(tool[2]!.tool_response, settled.result);
        assert.equal(events.filter(({ hook_event_name }) => hook_event_name === "Stop").length, 1);
        assert.equal(concluded, decision === "accept");
    });
}
