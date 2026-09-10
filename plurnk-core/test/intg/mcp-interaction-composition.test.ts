import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Module as AguiModule } from "@plurnk/plurnk-agui";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import Daemon from "../../src/server/Daemon.ts";
import { openMigrated } from "./_helpers.ts";
import { makeMockResponse } from "./_rpc.ts";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import { taskHandler, taskId, wireRequest } from "../../../plurnk-mcp/test/task-fixture.ts";

type Event = Record<string, unknown>;
interface Interrupt {
    readonly id: string;
    readonly toolCallId: string;
    readonly responseSchema: Record<string, unknown>;
}

const task = (status: string): string => `\`\`\`TASK\n[{"content":"Observe the MCP result.","status":"${status}"}]\n\`\`\``;
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
        makeMockResponse(`${operation}\n\n${task("waiting")}`),
        makeMockResponse(`\`\`\`SEND\nMCP result observed.\n\`\`\`\n\n${task("completed")}`),
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
        const { provider, post, start, reconnect } = await setup(t, '```fixture (batch)\n{}\n```');
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
    const { provider, post, start } = await setup(t, '```fixture (url)\n{}\n```');
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
    const { provider, post, start, reconnect } = await setup(t, '```fixture (round-trip)\n{}\n```');
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
    const { provider, post, start, reconnect } = await setup(t, '```fixture (batch)\n{}\n```');
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
        const { provider, post, start } = await setup(t, `\`\`\`READ (fixture:///${path}) <1,-1>\`\`\``);
        const pending = interaction(await start(), [key]);
        completed(await post({ resume: [{ interruptId: pending.id, status: "resolved", payload: {
            [key]: { action: "accept", content: { confirm: true } },
        } }] }), provider, expected);
    });
}

test("{§mcp-host-composition}: a standard Task completes the same operation through AG-UI", { timeout: 20_000 }, async (t) => {
    const { provider, start } = await setup(t, '```fixture (stdio-defer)\n{"topic":"MCP"}\n```', {
        PLURNK_MCP_FIXTURE: process.execPath,
        PLURNK_MCP_FIXTURE_ARGS: JSON.stringify([fixturePath("task-server.mjs")]),
        PLURNK_MCP_FIXTURE_READ: '["stdio-defer"]',
    });
    completed(await start(), provider, /plain stdio Task completed/u);
});

test("{§mcp-host-composition}: HTTP MRTR and Task input return through AG-UI before the terminal notification wakes inference", { timeout: 20_000 }, async (t) => {
    const fixture = taskHandler();
    const served = await serveMcpHttp(t, fixture.handler, fixture.route);
    const { provider, post, start, reconnect } = await setup(t, '```fixture (deferred-review)\n{"topic":"MCP"}\n```', {
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
