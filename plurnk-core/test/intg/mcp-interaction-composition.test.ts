import { PlurnkParser } from "@plurnk/plurnk-parser";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Module as AguiModule } from "@plurnk/plurnk-agui";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import Daemon from "../../src/server/Daemon.ts";
import { openMigrated } from "./_helpers.ts";
import { makeMockResponse, waitForDb } from "./_rpc.ts";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import { taskHandler, taskId, wireRequest } from "../../../plurnk-mcp/test/task-fixture.ts";

type Event = Record<string, unknown>;
interface Interrupt {
    readonly id: string;
    readonly toolCallId: string;
    readonly responseSchema: Record<string, unknown>;
}

const step = (op = "NOTE") => PlurnkParser.frame(op, op === "NOTE" ? "Inspect the result." : "");
const fixturePath = (name: string): string => fileURLToPath(new URL(
    `../../../plurnk-mcp/src/fixtures/${name}`, import.meta.url,
));

const setup = async (
    t: TestContext,
    operation: string,
    configuration: Record<string, string> = {
        PLURNK_MCP_FIXTURE: process.execPath,
        PLURNK_MCP_FIXTURE_ARGS: JSON.stringify([fixturePath("interaction-server.mjs")]),
        PLURNK_MCP_FIXTURE_READ: '["batch","round-trip","url"]',
    },
) => {
    const provider = new Mock({ contextWindow: 1_000_000, responses: [
        makeMockResponse(`${operation}\n\n${step("WAIT")}`),
        makeMockResponse(PlurnkParser.frame("SEND", "MCP result observed.")),
    ] });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider, nodeModulesPath: resolve("node_modules") });
    daemon.registerModule(McpModule.init({ env: {
        PLURNK_MCP_CONNECT_TIMEOUT: "5000",
        PLURNK_MCP_REQUEST_TIMEOUT: "10000",
        PLURNK_MCP_ENABLED: '["fixture"]',
        ...configuration,
    } }));
    const registration = AguiModule.init({ host: "127.0.0.1", port: 0 });
    let agui: AguiModule | undefined;
    daemon.registerModule({ start: async (seam) => {
        agui = await registration.start(seam);
        return agui;
    } });
    t.after(async () => {
        await daemon.stop();
        await db.close();
    });
    await daemon.start();
    assert.ok(agui);
    const port = agui.address().port;
    const workspace = "mcp-interaction-composition";
    const post = async (additions: Record<string, unknown> = {}): Promise<Event[]> => {
        const response = await fetch(`http://127.0.0.1:${port}/`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                threadId: workspace,
                runId: crypto.randomUUID(),
                state: {}, messages: [], tools: [], context: [],
                forwardedProps: { plurnk: { workspace, projectRoot: null } },
                ...additions,
            }),
            signal: AbortSignal.timeout(10_000),
        });
        const body = await response.text();
        assert.equal(response.status, 200, body);
        assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/u);
        return body.split("\n\n")
            .filter((frame) => frame.startsWith("data: "))
            .map((frame) => JSON.parse(frame.slice(6)) as Event);
    };
    const start = (): Promise<Event[]> => post({
        messages: [{ id: "prompt", role: "user", content: "Perform the MCP operation and report its result." }],
    });
    const reconnect = (): Promise<Event[]> => post({
        forwardedProps: { plurnk: { workspace, projectRoot: null, mode: "sync" } },
    });
    return { provider, post, start, reconnect, daemon, db };
};

const interaction = (events: readonly Event[], keys: readonly string[]): Interrupt => {
    const terminal = events.at(-1);
    assert.ok(terminal);
    assert.equal(terminal.type, "RUN_FINISHED", JSON.stringify(terminal));
    const outcome = terminal.outcome as { type?: string; interrupts?: Interrupt[] };
    assert.equal(outcome.type, "interrupt");
    assert.equal(outcome.interrupts?.length, 1, "one MCP input set is one atomic client interaction");
    const interrupt = outcome.interrupts![0]!;
    assert.match(interrupt.id, /^int:\d+$/u);
    assert.equal(interrupt.toolCallId, interrupt.id);
    assert.deepEqual(Object.keys(interrupt.responseSchema.properties as object).toSorted(), [...keys].toSorted());
    assert.ok(events.some((event) => event.type === "TOOL_CALL_START"
        && event.toolCallId === interrupt.id && event.toolCallName === "mcp_input_required"));
    assert.doesNotMatch(JSON.stringify(events), /round-one|round-two|opaque/u, "upstream continuation state stays private");
    return interrupt;
};

const completed = (events: readonly Event[], provider: Mock, expected: RegExp): void => {
    const terminal = events.at(-1);
    assert.ok(terminal);
    assert.equal(terminal.type, "RUN_FINISHED", JSON.stringify(terminal));
    assert.equal((terminal.outcome as { type?: string }).type, "success");
    assert.equal(provider.received.length, 2, "client input wakes the original operation, not another inference loop");
    const packet = provider.received[1]!.map(chatMessageText).join("\n");
    assert.match(packet, expected, "the server's actual terminal result reaches the model");
    assert.doesNotMatch(packet, /tool-call-failed|resource-read-failed/u);
};

for (const cancel of [false, true]) {
    test(`{§mcp-host-composition}: AG-UI batch elicitation ${cancel ? "cancellation" : "accept/decline"} survives reconnect`, { timeout: 20_000 }, async (t) => {
        const { provider, post, start, reconnect } = await setup(t, '````fixture (batch)\n{}\n````');
        const first = interaction(await start(), ["profile", "approval"]);
        assert.equal(provider.received.length, 1);
        const resurfaced = interaction(await reconnect(), ["profile", "approval"]);
        assert.deepEqual(resurfaced, first, "a new AG-UI Run re-presents the same pending operation");
        assert.equal(provider.received.length, 1, "reconnect performs no inference");
        const events = await post({ resume: [{
            interruptId: first.id,
            ...(cancel ? { status: "cancelled" } : { status: "resolved", payload: {
                profile: { action: "accept", content: { name: "Ada" } },
                approval: { action: "decline" },
            } }),
        }] });
        completed(events, provider, cancel ? /"action": "cancel"/u : /"name": "Ada"/u);
        if (!cancel) assert.match(provider.received[1]!.map(chatMessageText).join("\n"), /"action": "decline"/u);
    });
}

test("{§mcp-host-composition}: AG-UI URL elicitation preserves its browser action and returns to the server", { timeout: 20_000 }, async (t) => {
    const { provider, post, start } = await setup(t, '````fixture (url)\n{}\n````');
    const events = await start();
    const pending = interaction(events, ["authorize"]);
    const args = events.filter((event) => event.type === "TOOL_CALL_ARGS" && event.toolCallId === pending.id)
        .map((event) => event.delta).join("");
    assert.equal(JSON.parse(args).requests.authorize.params.url, "https://example.test/authorize");
    completed(await post({ resume: [{ interruptId: pending.id, status: "resolved", payload: {
        authorize: { action: "accept" },
    } }] }), provider, /accept/u);
});

test("{§mcp-host-composition}: two MRTR rounds stay on the originating operation across AG-UI Runs", { timeout: 20_000 }, async (t) => {
    const { provider, post, start, reconnect } = await setup(t, '````fixture (round-trip)\n{}\n````');
    const first = interaction(await start(), ["name"]);
    const second = interaction(await post({ resume: [{ interruptId: first.id, status: "resolved", payload: {
        name: { action: "accept", content: { name: "Ada" } },
    } }] }), ["confirm"]);
    assert.notEqual(second.id, first.id, "each new input set owns a fresh interrupt identity");
    assert.equal(provider.received.length, 1, "an intermediate MRTR round does not wake inference");
    const stale = await post({ resume: [{ interruptId: first.id, status: "cancelled" }] });
    assert.ok(stale.some((event) => event.type === "RUN_ERROR"));
    assert.match(JSON.stringify(stale), /interrupt-not-pending/u);
    assert.deepEqual(interaction(await reconnect(), ["confirm"]), second);
    completed(await post({ resume: [{ interruptId: second.id, status: "resolved", payload: {
        confirm: { action: "accept", content: { confirm: true } },
    } }] }), provider, /Ada confirmed/u);
});

test("{§mcp-host-composition}: a schema-invalid AG-UI answer preserves the pending MCP request for correction", { timeout: 20_000 }, async (t) => {
    const { provider, post, start, reconnect } = await setup(t, '````fixture (batch)\n{}\n````');
    const pending = interaction(await start(), ["profile", "approval"]);
    const invalid = await post({ resume: [{ interruptId: pending.id, status: "resolved", payload: {
        profile: { action: "accept", content: { name: 42 } },
        approval: { action: "decline" },
    } }] });
    assert.ok(invalid.some((event) => event.type === "RUN_ERROR"));
    assert.match(JSON.stringify(invalid), /interaction-response-invalid/u);
    assert.equal(provider.received.length, 1, "invalid client input did not finish the operation");
    assert.deepEqual(interaction(await reconnect(), ["profile", "approval"]), pending);
    completed(await post({ resume: [{ interruptId: pending.id, status: "resolved", payload: {
        profile: { action: "accept", content: { name: "Ada" } },
        approval: { action: "decline" },
    } }] }), provider, /"name": "Ada"/u);
});

for (const { path, key, expected } of [
    { path: "resources/fixture%3A%2F%2Fguarded", key: "read", expected: /read:accept/u },
    { path: "prompts/guarded?topic=MCP", key: "prompt", expected: /MCP:accept/u },
]) {
    test(`{§mcp-host-composition}: a ${key} READ completes its elicitation through AG-UI`, { timeout: 20_000 }, async (t) => {
        const { provider, post, start } = await setup(t, `\`\`\`\`READ (fixture:///${path}) <1,-1>\`\`\`\``);
        const pending = interaction(await start(), [key]);
        completed(await post({ resume: [{ interruptId: pending.id, status: "resolved", payload: {
            [key]: { action: "accept", content: { confirm: true } },
        } }] }), provider, expected);
    });
}

test("{§mcp-host-composition}: a standard Task completes the same operation through AG-UI", { timeout: 20_000 }, async (t) => {
    const { provider, start } = await setup(t, '````fixture (stdio-defer)\n{"topic":"MCP"}\n````', {
        PLURNK_MCP_FIXTURE: process.execPath,
        PLURNK_MCP_FIXTURE_ARGS: JSON.stringify([fixturePath("task-server.mjs")]),
        PLURNK_MCP_FIXTURE_READ: '["stdio-defer"]',
    });
    completed(await start(), provider, /plain stdio Task completed/u);
});

test("{§mcp-host-composition}: HTTP MRTR and Task input return through AG-UI before the terminal notification wakes inference", { timeout: 20_000 }, async (t) => {
    const fixture = taskHandler();
    const served = await serveMcpHttp(t, fixture.handler, fixture.route);
    const { provider, post, start, reconnect } = await setup(t, '````fixture (deferred-review)\n{"topic":"MCP"}\n````', {
        PLURNK_MCP_FIXTURE: served.url,
        PLURNK_MCP_FIXTURE_READ: '["deferred-review"]',
    });
    const first = interaction(await start(), ["preflight"]);
    const second = interaction(await post({ resume: [{ interruptId: first.id, status: "resolved", payload: {
        preflight: { action: "accept", content: { proceed: true } },
    } }] }), ["profile", "authorize"]);
    assert.notEqual(first.id, second.id);
    assert.deepEqual(interaction(await reconnect(), ["profile", "authorize"]), second);
    assert.equal(provider.received.length, 1, "Task input and reconnect never release the model early");
    completed(await post({ resume: [{ interruptId: second.id, status: "resolved", payload: {
        profile: { action: "accept", content: { name: "Ada" } },
        authorize: { action: "accept" },
    } }] }), provider, /Ada reviewed MCP/u);
    assert.deepEqual(fixture.updates.map(({ taskId, inputResponses }) => ({ taskId, inputResponses })), [{
        taskId,
        inputResponses: {
            profile: { action: "accept", content: { name: "Ada" } },
            authorize: { action: "accept" },
        },
    }]);
    const messages = served.requests.map(wireRequest);
    const calls = messages.filter(({ method }) => method === "tools/call");
    assert.equal(calls.length, 2, "only the origin and its required continuation were sent");
    assert.deepEqual(calls.map(({ params }) => params?.arguments), [{ topic: "MCP" }, { topic: "MCP" }]);
    const operationIds = messages.filter(({ method }) => method === "tools/call" || method?.startsWith("tasks/"))
        .map(({ id }) => id);
    assert.equal(new Set(operationIds).size, operationIds.length, "each protocol request has a fresh correlation ID");
});

for (const state of ["failed", "cancelled", "unsupported-input"] as const) {
    test(`{§mcp-host-composition}: remote Task ${state} reaches its worker once without an interaction or replay`, { timeout: 20_000 }, async (t) => {
        const fixture = taskHandler(state === "unsupported-input" ? "unsupported" : "protocol-failure");
        const served = await serveMcpHttp(t, fixture.handler, async (request) => {
            const response = await fixture.route(request);
            if (state !== "cancelled" || (await request.clone().json()).method !== "tasks/get") return response;
            assert.ok(response);
            const body = await response.json() as { result: Record<string, unknown> };
            const { error, ...task } = body.result;
            assert.ok(error, "the fixture provided the failed Task being changed to cancelled");
            return Response.json({ ...body, result: { ...task, status: "cancelled" } });
        });
        const { provider, start, daemon } = await setup(t, `\`\`\`\`fixture (${fixture.toolName})\n{"topic":"MCP"}\n\`\`\`\``, {
            PLURNK_MCP_FIXTURE: served.url, PLURNK_MCP_FIXTURE_READ: JSON.stringify([fixture.toolName]),
        });
        const events = await start();
        const terminal = events.at(-1);
        assert.ok(terminal);
        assert.equal((terminal.outcome as { type?: string }).type, "success", JSON.stringify(terminal));
        assert.equal(provider.received.length, 2, "the original worker receives one failure and continues normally");
        const packet = provider.received[1]!.map(chatMessageText).join("\n");
        assert.match(packet, /executor\/mcp\/tool-call-failed/);
        assert.match(packet, state === "failed" ? /task execution exploded/
            : state === "cancelled" ? /cancelled/ : /sampling\/createMessage/);
        assert.equal(events.some((event) => event.type === "TOOL_CALL_START" && event.toolCallName === "mcp_input_required"), false);
        const snapshot = events.find((event) => event.type === "STATE_SNAPSHOT")?.snapshot as {
            plurnk: { workspace: { id: number } };
        };
        assert.deepEqual(await daemon.pendingClientInteractions(snapshot.plurnk.workspace.id), []);
        assert.deepEqual(fixture.updates, []);
        assert.deepEqual(fixture.cancellations.map(({ taskId }) => taskId), state === "unsupported-input" ? [taskId] : [],
            "unhandled input abandons the live Task; terminal Tasks need no second cancellation");
        assert.equal(served.requests.map(wireRequest).filter(({ method }) => method === "tools/call").length, 1);
    });
}

for (const stage of ["MRTR", "Task"] as const) {
    for (const boundary of ["owner cancellation", "daemon shutdown"] as const) {
        test(`{§mcp-host-composition}: ${boundary} settles pending ${stage} input and its remote work`, { timeout: 20_000 }, async (t) => {
            let owner: Daemon | undefined;
            t.after(() => owner?.stop());
            const fixture = taskHandler();
            const served = await serveMcpHttp(t, fixture.handler, fixture.route);
            const { provider, post, start, daemon } = await setup(t, '````fixture (deferred-review)\n{"topic":"MCP"}\n````', {
                PLURNK_MCP_FIXTURE: served.url,
                PLURNK_MCP_FIXTURE_READ: '["deferred-review"]',
            });
            owner = daemon;
            const events = await start();
            const first = interaction(events, ["preflight"]);
            const pending = stage === "MRTR" ? first : interaction(await post({ resume: [{
                interruptId: first.id, status: "resolved", payload: {
                    preflight: { action: "accept", content: { proceed: true } },
                },
            }] }), ["profile", "authorize"]);
            const snapshot = events.find((event) => event.type === "STATE_SNAPSHOT")?.snapshot as {
                plurnk: { workspace: { id: number } };
            };
            const workspaceId = snapshot.plurnk.workspace.id;
            const [waiting] = await daemon.pendingClientInteractions(workspaceId);
            assert.ok(waiting);
            assert.equal(`int:${waiting.interactionId}`, pending.id);
            const workerId = waiting.workerId;
            if (boundary === "owner cancellation") {
                await daemon.cancelWorker({ workspaceId, workerId, reason: "MCP operation cancelled" });
            } else {
                await daemon.stop();
            }
            assert.deepEqual(await daemon.pendingClientInteractions(workspaceId), []);
            const loops = await daemon.listWorkerLoops({ workspaceId, workerId });
            assert.equal(loops.find(({ id }) => id === waiting.loopId)?.status, 499);
            assert.equal(provider.received.length, 1, "cancellation never resumes inference");
            assert.equal(fixture.updates.length, 0, "cancelled input is never submitted as a Task answer");
            assert.deepEqual(fixture.cancellations.map(({ taskId }) => taskId), stage === "Task" ? [taskId] : [],
                "only a created remote Task is cancelled, before the owning operation settles");
            assert.equal(served.requests.map(wireRequest).filter(({ method }) => method === "tools/call").length,
                stage === "Task" ? 2 : 1, "the interrupted operation is not replayed");
            if (boundary === "owner cancellation") {
                const late = await post({ resume: [{ interruptId: pending.id, status: "cancelled" }] });
                assert.ok(late.some((event) => event.type === "RUN_ERROR"));
                assert.match(JSON.stringify(late), /interrupt-not-pending/u);
            }
        });
    }
}

test("{§mcp-host-composition}: withdrawing an attachment cannot interrupt its pending Task input", { timeout: 20_000 }, async (t) => {
    let owner: Daemon | undefined;
    t.after(() => owner?.stop());
    const fixture = taskHandler();
    const served = await serveMcpHttp(t, fixture.handler, fixture.route);
    const { provider, post, start, reconnect, daemon } = await setup(t, '````fixture (deferred-review)\n{"topic":"MCP"}\n````', {
        PLURNK_MCP_FIXTURE: served.url,
        PLURNK_MCP_FIXTURE_READ: '["deferred-review"]',
    });
    owner = daemon;
    const first = interaction(await start(), ["preflight"]);
    const pending = interaction(await post({ resume: [{ interruptId: first.id, status: "resolved", payload: {
        preflight: { action: "accept", content: { proceed: true } },
    } }] }), ["profile", "authorize"]);
    const mutate = (kind: string) => post({ forwardedProps: { plurnk: {
        workspace: "mcp-interaction-composition", projectRoot: null, action: { kind, alias: "fixture" },
    } } });
    const rejected = await mutate("workspace.mcp.disable");
    const outcome = rejected.find((event) => event.type === "CUSTOM" && event.name === "plurnk.action.result")?.value as {
        ok: boolean; problem?: { status: number; type: string };
    };
    assert.equal(outcome.ok, false, JSON.stringify(rejected));
    assert.equal(outcome.problem?.status, 409);
    assert.equal(outcome.problem?.type, "https://problems.plurnk.xyz/daemon/workspace-functionality/workspace-busy");
    assert.deepEqual(interaction(await reconnect(), ["profile", "authorize"]), pending);
    completed(await post({ resume: [{ interruptId: pending.id, status: "resolved", payload: {
        profile: { action: "accept", content: { name: "Ada" } },
        authorize: { action: "accept" },
    } }] }), provider, /Ada reviewed MCP/u);
    assert.deepEqual(fixture.cancellations, [], "the failed mutation neither cancels nor replaces the original Task");
    const disabled = await mutate("workspace.mcp.disable");
    const result = disabled.find((event) => event.type === "CUSTOM" && event.name === "plurnk.action.result")?.value as { ok: boolean };
    assert.equal(result.ok, true, JSON.stringify(disabled));
    assert.deepEqual(fixture.cancellations, [], "completed Tasks are not cancelled again at connection close");
});

for (const source of ["MRTR", "Task", "resource", "prompt"] as const) {
    test(`{§mcp-host-composition}: ${source} input expires without a human answer and the worker recovers`, { timeout: 20_000 }, async (t) => {
        let owner: Daemon | undefined;
        t.after(() => owner?.stop());
        const tool = source === "MRTR" || source === "Task";
        const fixture = tool ? taskHandler() : undefined;
        const served = fixture === undefined ? undefined : await serveMcpHttp(t, fixture.handler, fixture.route);
        const operation = tool ? '````fixture (deferred-review)\n{"topic":"MCP"}\n````'
            : source === "resource" ? "````READ (fixture:///resources/fixture%3A%2F%2Fguarded) <1,-1>````"
                : "````READ (fixture:///prompts/guarded?topic=MCP) <1,-1>````";
        const { provider, post, start, reconnect, daemon } = await setup(t, operation, {
            PLURNK_MCP_REQUEST_TIMEOUT: "1000",
            ...(served === undefined ? {
                PLURNK_MCP_FIXTURE: process.execPath,
                PLURNK_MCP_FIXTURE_ARGS: JSON.stringify([fixturePath("interaction-server.mjs")]),
                PLURNK_MCP_FIXTURE_READ: '["batch","round-trip","url"]',
            } : {
                PLURNK_MCP_FIXTURE: served.url,
                PLURNK_MCP_FIXTURE_READ: '["deferred-review"]',
            }),
        });
        owner = daemon;
        const events = await start();
        const first = interaction(events, [tool ? "preflight" : source === "resource" ? "read" : "prompt"]);
        const pending = source !== "Task" ? first : interaction(await post({ resume: [{
            interruptId: first.id, status: "resolved", payload: {
                preflight: { action: "accept", content: { proceed: true } },
            },
        }] }), ["profile", "authorize"]);
        const snapshot = events.find((event) => event.type === "STATE_SNAPSHOT")?.snapshot as {
            plurnk: { workspace: { id: number } };
        };
        const workspaceId = snapshot.plurnk.workspace.id;
        const [waiting] = await daemon.pendingClientInteractions(workspaceId);
        assert.ok(waiting);
        await waitForDb(() => daemon.pendingClientInteractions(workspaceId), (rows) => rows.length === 0,
            { timeoutMs: 3000 });
        await waitForDb(() => daemon.listWorkerLoops({ workspaceId, workerId: waiting.workerId }),
            (loops) => loops.find(({ id }) => id === waiting.loopId)?.status === 200);
        assert.equal(provider.received.length, 2, "expiry resumes the same worker with the operation failure");
        const packet = provider.received[1]!.map(chatMessageText).join("\n");
        assert.match(packet, /operation timeout/u);
        assert.match(packet, tool ? /tool-call-failed/u : /resource-read-failed/u);
        const late = await post({ resume: [{ interruptId: pending.id, status: "cancelled" }] });
        assert.ok(late.some((event) => event.type === "RUN_ERROR"), JSON.stringify(late));
        assert.match(JSON.stringify(late), /interrupt-not-pending/u);
        const synced = await reconnect();
        const terminal = synced.at(-1);
        assert.ok(terminal);
        assert.equal((terminal.outcome as { type?: string }).type, "success");
        assert.equal(provider.received.length, 2, "late input and reconnect do not replay work");
        if (fixture !== undefined && served !== undefined) {
            assert.deepEqual(fixture.cancellations.map(({ taskId }) => taskId), source === "Task" ? [taskId] : []);
            assert.deepEqual(fixture.updates, [], "expired human input is not submitted to the server");
            assert.equal(served.requests.map(wireRequest).filter(({ method }) => method === "tools/call").length,
                source === "Task" ? 2 : 1);
        }
    });
}
