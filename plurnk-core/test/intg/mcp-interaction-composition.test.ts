import { PlurnkParser } from "@plurnk/plurnk-parser";
import assert from "node:assert/strict";
import { serverProposals, TEST_OWNER } from "./_approval.ts";
import test, { type TestContext } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { MCP_SCHEMA, PLUGIN_SCHEMA } from "@plurnk/plurnk-agent-plugins";
import type { FunctionalityListResult, PlurnkStatement } from "@plurnk/plurnk-contracts";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import Daemon from "../../src/server/Daemon.ts";
import { bindListener } from "./_http.ts";
import { insertSession, openMigrated } from "./_db.ts";
import { fixtureExecutors, makeMockResponse, userText } from "./_mock.ts";
import { awaitExecOutcome } from "./_execs.ts";
import { waitFor, waitForDb } from "./_rpc.ts";
import { httpEntry, mcpFixture, stdioEntry } from "./_mcp-config.ts";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import { taskHandler, taskId, wireRequest } from "../../../plurnk-mcp/test/task-fixture.ts";

type Event = Record<string, unknown>;
interface Interrupt {
    readonly id: string;
    readonly toolCallId: string;
    readonly mode: "form" | "url";
    readonly message: string;
    readonly requestedSchema?: Record<string, unknown>;
    readonly url?: string;
    readonly elicitationId?: string;
}

interface ResumeAnswer {
    readonly interruptId: string | number;
    readonly action: "accept" | "decline" | "cancel";
    readonly content?: Record<string, unknown>;
}

const step = (op = "NOTE") => PlurnkParser.frame(op, op === "NOTE" ? "Inspect the result." : "");

const setup = async (
    t: TestContext,
    operation: string,
    servers: Readonly<Record<string, object>> = { fixture: stdioEntry("interaction-server.mjs") },
    env: Readonly<Record<string, string>> = {},
) => {
    serverProposals(t, "accept");
    const provider = new Mock({ contextWindow: 1_000_000, responses: [
        makeMockResponse(`${operation}\n\n${step("WAIT")}`),
        makeMockResponse(PlurnkParser.frame("SEND [200]", "MCP result observed.")),
    ] });
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, servers);
    const db = await openMigrated();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider, nodeModulesPath: resolve("node_modules"), hostPaths, http });
    daemon.registerModule(McpModule.init({ env: { ...mcpEnv,
        PLURNK_MCP_CONNECT_TIMEOUT: "5000",
        PLURNK_MCP_REQUEST_TIMEOUT: "10000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
        ...env,
    } }), "@plurnk/plurnk-mcp");
    t.after(async () => {
        await daemon.stop();
        await http.close();
        await db.close();
    });
    await daemon.start();
    const { port } = http.httpAddress();
    const workspace = "mcp-interaction-composition";
    const post = async (additions: Record<string, unknown> = {}): Promise<Event[]> => {
        const defaultMeta: Record<string, unknown> = {
            workspace,
            projectRoot: null,
            control: true,
            interactive: true,
            tools: ["mcp_input_required"],
        };
        const extraPlurnk = (additions._meta as { plurnk?: Record<string, unknown> } | undefined)?.plurnk ?? {};
        const mergedPlurnk = { ...defaultMeta, ...extraPlurnk };
        const reqId = crypto.randomUUID();
        const resumeItems = Array.isArray(additions.resume) && additions.resume.length > 0
            ? (additions.resume as ResumeAnswer[])
            : null;
        const expectedElicitations = typeof additions.expectedElicitations === "number"
            ? additions.expectedElicitations
            : 1;
        const followUpElicitations = typeof additions.followUpElicitations === "number"
            ? additions.followUpElicitations
            : 0;
        const rpcBody = (() => {
            if (resumeItems !== null) {
                return {
                    jsonrpc: "2.0",
                    id: reqId,
                    method: "session/resume",
                    params: {
                        sessionId: workspace,
                        cwd: "/",
                        _meta: {
                            plurnk: mergedPlurnk,
                        },
                    },
                };
            }
            if (mergedPlurnk.action !== undefined) {
                const { kind, ...params } = mergedPlurnk.action as { kind: string; [key: string]: unknown };
                return {
                    jsonrpc: "2.0",
                    id: reqId,
                    method: "_plurnk/action",
                    params: {
                        sessionId: workspace,
                        workspace: mergedPlurnk.workspace,
                        projectRoot: mergedPlurnk.projectRoot,
                        kind,
                        params,
                    },
                };
            }
            if (Array.isArray(additions.messages) && additions.messages.length > 0) {
                const msg = additions.messages[0] as { content?: string };
                return {
                    jsonrpc: "2.0",
                    id: reqId,
                    method: "session/prompt",
                    params: {
                        sessionId: workspace,
                        prompt: [{ type: "text", text: msg.content ?? "" }],
                        _meta: { plurnk: mergedPlurnk },
                    },
                };
            }
            return {
                jsonrpc: "2.0",
                id: reqId,
                method: "session/resume",
                params: {
                    sessionId: workspace,
                    cwd: "/",
                    _meta: { plurnk: mergedPlurnk },
                },
            };
        })();
        const ws = new WebSocket(`ws://127.0.0.1:${port}/acp`);
        const events: Event[] = [];
        return await new Promise<Event[]>((resolvePromise, rejectPromise) => {
            let settled = false;
            const answeredIds = new Set<number>();
            let sawRunningAfterAnswer = false;
            let workspaceId: number | undefined;
            let collectTimer: ReturnType<typeof setTimeout> | undefined;
            const finish = (terminal?: Event) => {
                if (settled) return;
                settled = true;
                if (collectTimer !== undefined) clearTimeout(collectTimer);
                if (terminal !== undefined) events.push(terminal);
                ws.close();
                resolvePromise(events);
            };
            ws.addEventListener("open", () => {
                ws.send(JSON.stringify({
                    jsonrpc: "2.0",
                    id: "init",
                    method: "initialize",
                    params: { protocolVersion: 2, info: { name: "test", version: "1.0.0" }, capabilities: {} },
                }));
            });
            ws.addEventListener("message", (msg) => {
                const frame = JSON.parse(String(msg.data)) as Event & {
                    id?: string | number;
                    method?: string;
                    params?: {
                        toolCallId?: string;
                        mode?: "form" | "url";
                        message?: string;
                        requestedSchema?: Record<string, unknown>;
                        url?: string;
                        elicitationId?: string;
                        update?: {
                            sessionUpdate?: string;
                            state?: string;
                            stopReason?: string;
                            _meta?: {
                                plurnk?: {
                                    workspace?: { id?: number };
                                    problem?: unknown;
                                };
                            };
                        };
                        _meta?: {
                            plurnk?: {
                                interaction?: { interactionId?: number };
                            };
                        };
                    };
                    result?: {
                        _meta?: {
                            plurnk?: {
                                workspaceId?: number;
                                workspace?: { id?: number };
                            };
                        };
                    };
                    error?: unknown;
                };
                if (frame.id === "init") {
                    ws.send(JSON.stringify(rpcBody));
                    return;
                }
                if (frame.method === "elicitation/create") {
                    if (resumeItems === null) {
                        events.push(frame);
                        if (rpcBody.method === "session/prompt") {
                            const count = events.filter((e) => e.method === "elicitation/create").length;
                            if (count >= expectedElicitations) {
                                finish();
                            } else {
                                if (collectTimer !== undefined) clearTimeout(collectTimer);
                                collectTimer = setTimeout(() => finish(), 50);
                            }
                        }
                        return;
                    }
                    const intId = frame.params?._meta?.plurnk?.interaction?.interactionId;
                    const match = resumeItems.find((item) => Number(item.interruptId) === intId);
                    if (match !== undefined && intId !== undefined && !answeredIds.has(intId) && frame.id !== undefined) {
                        answeredIds.add(intId);
                        ws.send(JSON.stringify({
                            jsonrpc: "2.0",
                            id: frame.id,
                            result: {
                                action: match.action,
                                ...(match.content === undefined ? {} : { content: match.content }),
                            },
                        }));
                        return;
                    }
                    if (answeredIds.size === resumeItems.length && followUpElicitations > 0) {
                        events.push(frame);
                        const followUpCount = events.filter((e) => e.method === "elicitation/create").length;
                        if (followUpCount >= followUpElicitations) {
                            finish();
                        } else {
                            if (collectTimer !== undefined) clearTimeout(collectTimer);
                            collectTimer = setTimeout(() => finish(), 50);
                        }
                    }
                    return;
                }
                if (frame.method === "session/update") {
                    const update = frame.params?.update;
                    const wsId = update?._meta?.plurnk?.workspace?.id;
                    if (typeof wsId === "number") workspaceId = wsId;
                    if (resumeItems !== null && answeredIds.size < resumeItems.length) {
                        // Ignore replay notifications before answering all target elicitations
                        return;
                    }
                    events.push(frame);
                    if (resumeItems !== null && update?.sessionUpdate === "notice" && update._meta?.plurnk?.problem !== undefined) {
                        finish({
                            jsonrpc: "2.0",
                            id: reqId,
                            error: { data: { problem: update._meta.plurnk.problem } },
                        });
                        return;
                    }
                    if (resumeItems !== null && update?.sessionUpdate === "state_update" && update.state === "running") {
                        sawRunningAfterAnswer = true;
                        return;
                    }
                    if ((rpcBody.method === "session/prompt" || (resumeItems !== null && sawRunningAfterAnswer))
                        && update?.sessionUpdate === "state_update"
                        && update.state === "idle") {
                        finish({
                            jsonrpc: "2.0",
                            id: reqId,
                            result: {
                                stopReason: update.stopReason ?? "end_turn",
                                _meta: {
                                    plurnk: {
                                        stopReason: update.stopReason ?? "end_turn",
                                        ...(workspaceId !== undefined ? { workspaceId } : {}),
                                    },
                                },
                            },
                        });
                    }
                    return;
                }
                if (frame.id === reqId) {
                    const wsId = frame.result?._meta?.plurnk?.workspaceId ?? frame.result?._meta?.plurnk?.workspace?.id;
                    if (typeof wsId === "number") workspaceId = wsId;
                    if (frame.error !== undefined) {
                        finish(frame);
                        return;
                    }
                    if (rpcBody.method === "_plurnk/action" || (rpcBody.method === "session/resume" && resumeItems === null)) {
                        finish(frame);
                    }
                }
            });
            ws.addEventListener("error", (err) => {
                if (!settled) {
                    settled = true;
                    rejectPromise(err);
                }
            });
        });
    };
    // The Task fixtures' tools carry no readOnlyHint, so they are host effects ({§mcp-model-projection});
    // server auto-approval leaves each MCP input as the only client decision.
    const start = (expectedElicitations = 1): Promise<Event[]> => post({
        expectedElicitations,
        messages: [{ id: "prompt", role: "user", content: "Perform the MCP operation and report its result." }],
        _meta: { plurnk: { workspace, projectRoot: null, interactive: true } },
    });
    const reconnect = (): Promise<Event[]> => post({
        _meta: { plurnk: { workspace, projectRoot: null, control: true, interactive: true } },
    });
    const assertNotPending = async (interruptId: string | number): Promise<void> => {
        const [{ id: workspaceId }] = await daemon.listWorkspaces();
        await assert.rejects(
            daemon.resolveClientInteraction(
                Number(interruptId),
                { action: "cancel" },
                { workspaceId, address: "acp://operator" },
            ),
            /interaction-not-pending|is not pending/u,
        );
    };
    return { provider, post, start, reconnect, assertNotPending, daemon, db };
};

const updatesOf = (events: readonly Event[]): ReadonlyArray<Record<string, unknown>> =>
    events
        .filter((e) => e.method === "session/update")
        .map((e) => ((e.params as { update?: Record<string, unknown> } | undefined)?.update ?? {}));

const interactions = (events: readonly Event[], expectedCount = 1): readonly Interrupt[] => {
    const updates = updatesOf(events);
    const elicitations = events.filter((e) => e.method === "elicitation/create");
    assert.equal(elicitations.length, expectedCount, `expected ${expectedCount} elicitation(s): ${JSON.stringify(events)}`);
    assert.doesNotMatch(JSON.stringify(events), /round-one|round-two|opaque/u, "upstream continuation state stays private");
    return elicitations.map((elicit) => {
        const params = elicit.params as {
            toolCallId: string;
            mode: "form" | "url";
            message: string;
            requestedSchema?: Record<string, unknown>;
            url?: string;
            elicitationId?: string;
            _meta?: { plurnk?: { interaction?: { interactionId: number } } };
        };
        const intMeta = params._meta?.plurnk?.interaction;
        const id = String(intMeta?.interactionId ?? params.toolCallId.replace(/^int:/u, ""));
        const toolCallId = params.toolCallId;
        assert.ok(id.length > 0);
        assert.match(toolCallId, /^int:\d+$/u);
        assert.ok(updates.some((u) => u.sessionUpdate === "tool_call_update"
            && u.toolCallId === toolCallId && u.title === "mcp_input_required"));
        return {
            id,
            toolCallId,
            mode: params.mode,
            message: params.message,
            ...(params.requestedSchema !== undefined ? { requestedSchema: params.requestedSchema } : {}),
            ...(params.url !== undefined ? { url: params.url } : {}),
            ...(params.elicitationId !== undefined ? { elicitationId: params.elicitationId } : {}),
        };
    });
};

const interaction = (events: readonly Event[], keys: readonly string[]): Interrupt => {
    const [item] = interactions(events, 1);
    assert.equal(item.mode, "form");
    assert.deepEqual(Object.keys(item.requestedSchema?.properties ?? {}).toSorted(), [...keys].toSorted());
    return item;
};

const rediscovered = (events: readonly Event[], keys: readonly string[], previous: Interrupt): Interrupt => {
    const current = interaction(events, keys);
    assert.deepEqual(current, previous, "session/resume re-presents the same pending operation");
    return current;
};

const rediscoveredAll = (events: readonly Event[], previous: readonly Interrupt[]): readonly Interrupt[] => {
    const current = interactions(events, previous.length);
    assert.deepEqual(current, previous, "session/resume re-presents the same pending operations");
    return current;
};

const completed = (events: readonly Event[], provider: Mock, expected: RegExp): void => {
    const terminal = events.at(-1) as { result?: { _meta?: { plurnk?: { stopReason?: string } } } } | undefined;
    assert.ok(terminal);
    assert.equal(terminal.result?._meta?.plurnk?.stopReason, "end_turn", JSON.stringify(terminal));
    assert.equal(provider.received.length, 2, "client input wakes the original operation, not another inference loop");
    const packet = provider.received[1].map(chatMessageText).join("\n");
    assert.match(packet, expected, "the server's actual terminal result reaches the model");
    assert.doesNotMatch(packet, /tool-call-failed|resource-read-failed/u);
};

for (const cancel of [false, true]) {
    test(`{§mcp-host-composition}: ACP batch elicitation ${cancel ? "cancellation" : "accept/decline"} survives reconnect`, { timeout: 20_000 }, async (t) => {
        const { provider, post, start, reconnect } = await setup(t, '````fixture (batch)\n{}\n````');
        const first = interactions(await start(2), 2);
        assert.equal(provider.received.length, 1);
        const resurfaced = rediscoveredAll(await reconnect(), first);
        assert.equal(provider.received.length, 1, "reconnect performs no inference");
        const profile = resurfaced.find((item) => item.message === "Who is making this request?")!;
        const approval = resurfaced.find((item) => item.message === "Continue the batch operation?")!;
        assert.ok(profile);
        assert.ok(approval);
        const events = await post({ resume: cancel
            ? [
                { interruptId: profile.id, action: "cancel" },
                { interruptId: approval.id, action: "cancel" },
            ]
            : [
                { interruptId: profile.id, action: "accept", content: { name: "Ada" } },
                { interruptId: approval.id, action: "decline" },
            ] });
        completed(events, provider, cancel ? /"action": "cancel"/u : /"name": "Ada"/u);
        if (!cancel) assert.match(provider.received[1].map(chatMessageText).join("\n"), /"action": "decline"/u);
    });
}

test("{§mcp-host-composition}: ACP URL elicitation preserves its browser action and returns to the server", { timeout: 20_000 }, async (t) => {
    const { provider, post, start } = await setup(t, '````fixture (url)\n{}\n````');
    const events = await start(1);
    const [pending] = interactions(events, 1);
    assert.equal(pending.mode, "url");
    assert.equal(pending.url, "https://example.test/authorize");
    assert.equal(pending.elicitationId, "fixture-authorization");
    const toolCall = updatesOf(events).find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === pending.toolCallId);
    const rawInput = (toolCall?.rawInput ?? {}) as { mode?: string; url?: string };
    assert.equal(rawInput.mode, "url");
    assert.equal(rawInput.url, "https://example.test/authorize");
    completed(await post({ resume: [{ interruptId: pending.id, action: "accept" }] }), provider, /accept/u);
});

test("{§mcp-host-composition}: two MRTR rounds stay on the originating operation across ACP Runs", { timeout: 20_000 }, async (t) => {
    const { provider, post, start, reconnect, assertNotPending } = await setup(t, '````fixture (round-trip)\n{}\n````');
    const first = interaction(await start(), ["name"]);
    const second = interaction(await post({
        followUpElicitations: 1,
        resume: [{
            interruptId: first.id, action: "accept", content: { name: "Ada" },
        }],
    }), ["confirm"]);
    assert.notEqual(second.id, first.id, "each new input set owns a fresh interrupt identity");
    assert.equal(provider.received.length, 1, "an intermediate MRTR round does not wake inference");
    await assertNotPending(first.id);
    const resurfaced = rediscovered(await reconnect(), ["confirm"], second);
    completed(await post({ resume: [{
        interruptId: resurfaced.id, action: "accept", content: { confirm: true },
    }] }), provider, /Ada confirmed/u);
});

test("{§mcp-host-composition}: a schema-invalid ACP answer preserves the pending MCP request for correction", { timeout: 20_000 }, async (t) => {
    const { provider, post, start, reconnect } = await setup(t, '````fixture (batch)\n{}\n````');
    const pending = interactions(await start(2), 2);
    const profile = pending.find((item) => item.message === "Who is making this request?")!;
    const invalid = await post({ resume: [
        { interruptId: profile.id, action: "accept", content: { name: 42 } },
    ] });
    assert.ok(invalid.some((event) => "error" in event));
    assert.match(JSON.stringify(invalid), /interaction-response-invalid/u);
    assert.equal(provider.received.length, 1, "invalid client input did not finish the operation");
    const resurfaced = rediscoveredAll(await reconnect(), pending);
    const resurfacedProfile = resurfaced.find((item) => item.message === "Who is making this request?")!;
    const resurfacedApproval = resurfaced.find((item) => item.message === "Continue the batch operation?")!;
    completed(await post({ resume: [
        { interruptId: resurfacedProfile.id, action: "accept", content: { name: "Ada" } },
        { interruptId: resurfacedApproval.id, action: "decline" },
    ] }), provider, /"name": "Ada"/u);
});

for (const { path, key, expected } of [
    { path: "resources/fixture%3A%2F%2Fguarded", key: "read", expected: /read:accept/u },
    { path: "prompts/guarded?topic=MCP", key: "prompt", expected: /MCP:accept/u },
]) {
    test(`{§mcp-host-composition}: a ${key} READ completes its elicitation through ACP`, { timeout: 20_000 }, async (t) => {
        const { provider, post, start } = await setup(t, `\`\`\`\`READ (fixture:///${path}) <1,-1>\`\`\`\``);
        const pending = interaction(await start(), ["confirm"]);
        completed(await post({ resume: [{
            interruptId: pending.id, action: "accept", content: { confirm: true },
        }] }), provider, expected);
    });
}

test("{§mcp-host-composition}: a standard Task completes the same operation through ACP", { timeout: 20_000 }, async (t) => {
    const { provider, start } = await setup(t, '````fixture (stdio-defer)\n{"topic":"MCP"}\n````', {
        fixture: stdioEntry("task-server.mjs"),
    });
    completed(await start(), provider, /plain stdio Task completed/u);
});

test("{§mcp-host-composition}: fixture teardown settles an unanswered Task before closing its MCP server", { timeout: 20_000 }, async (t) => {
    const fixture = taskHandler();
    let provider: Mock | undefined;
    await t.test("{§mcp-host-composition} leave the Task awaiting client input", async (t) => {
        let owner: Daemon | undefined;
        t.after(() => owner?.stop());
        const served = await serveMcpHttp(t, fixture.handler, fixture.route);
        const host = await setup(t, '````fixture (deferred-review)\n{"topic":"MCP"}\n````', {
            fixture: httpEntry(served.url),
        });
        owner = host.daemon;
        provider = host.provider;
        const first = interaction(await host.start(), ["proceed"]);
        interactions(await host.post({
            followUpElicitations: 2,
            resume: [{ interruptId: first.id, action: "accept", content: { proceed: true } }],
        }), 2);
    });
    assert.deepEqual(fixture.cancellations.map((cancellation) => cancellation.taskId), [taskId]);
    assert.deepEqual(fixture.updates, [], "teardown never fabricates a human answer");
    assert.equal(provider?.received.length, 1, "teardown never starts another inference");
});

test("{§mcp-host-composition}: HTTP MRTR and Task input return through ACP before the terminal notification wakes inference", { timeout: 20_000 }, async (t) => {
    let owner: Daemon | undefined;
    t.after(() => owner?.stop());
    const fixture = taskHandler();
    const served = await serveMcpHttp(t, fixture.handler, fixture.route);
    const { provider, post, start, reconnect, daemon } = await setup(t, '````fixture (deferred-review)\n{"topic":"MCP"}\n````', {
        fixture: httpEntry(served.url),
    });
    owner = daemon;
    const first = interaction(await start(), ["proceed"]);
    const second = interactions(await post({
        followUpElicitations: 2,
        resume: [{ interruptId: first.id, action: "accept", content: { proceed: true } }],
    }), 2);
    assert.ok(second.every((item) => item.id !== first.id));
    const resurfaced = rediscoveredAll(await reconnect(), second);
    assert.equal(provider.received.length, 1, "Task input and reconnect never release the model early");
    const profile = resurfaced.find((item) => item.mode === "form")!;
    const authorize = resurfaced.find((item) => item.mode === "url")!;
    assert.ok(profile);
    assert.ok(authorize);
    completed(await post({ resume: [
        { interruptId: profile.id, action: "accept", content: { name: "Ada" } },
        { interruptId: authorize.id, action: "accept" },
    ] }), provider, /Ada reviewed MCP/u);
    assert.deepEqual(fixture.updates.map((update) => ({ taskId: update.taskId, inputResponses: update.inputResponses })), [{
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
    test(`{§mcp-host-composition}: remote Task ${state} reaches its session once without an interaction or replay`, { timeout: 20_000 }, async (t) => {
        let owner: Daemon | undefined;
        t.after(() => owner?.stop());
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
            fixture: httpEntry(served.url),
        });
        owner = daemon;
        const events = await start();
        const terminal = events.at(-1) as { result?: { _meta?: { plurnk?: { stopReason?: string; workspaceId?: number } } } } | undefined;
        assert.ok(terminal);
        assert.equal(terminal.result?._meta?.plurnk?.stopReason, "end_turn", JSON.stringify(terminal));
        assert.equal(provider.received.length, 2, "the original session receives one failure and continues normally");
        const packet = provider.received[1].map(chatMessageText).join("\n");
        assert.match(packet, /executor\/mcp\/tool-call-failed/);
        assert.match(packet, state === "failed" ? /task execution exploded/
            : state === "cancelled" ? /cancelled/ : /sampling\/createMessage/);
        assert.equal(updatesOf(events).some((u) => u.sessionUpdate === "tool_call_update" && u.title === "mcp_input_required"), false);
        const wsId = terminal.result?._meta?.plurnk?.workspaceId;
        assert.ok(typeof wsId === "number");
        assert.deepEqual(await daemon.pendingClientInteractions(wsId), []);
        assert.deepEqual(fixture.updates, []);
        assert.deepEqual(fixture.cancellations.map((cancellation) => cancellation.taskId), state === "unsupported-input" ? [taskId] : [],
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
            const { provider, post, start, assertNotPending, daemon } = await setup(t, '````fixture (deferred-review)\n{"topic":"MCP"}\n````', {
                fixture: httpEntry(served.url),
            });
            owner = daemon;
            const events = await start();
            const first = interaction(events, ["proceed"]);
            const pending = stage === "MRTR" ? [first] : interactions(await post({
                followUpElicitations: 2,
                resume: [{ interruptId: first.id, action: "accept", content: { proceed: true } }],
            }), 2);
            const wsUpdate = updatesOf(events).find((u) => u.sessionUpdate === "notice" && u.title === "workspace:state") as {
                _meta?: { plurnk?: { workspace?: { id: number } } };
            } | undefined;
            assert.ok(wsUpdate?._meta?.plurnk?.workspace);
            const workspaceId = wsUpdate._meta.plurnk.workspace.id;
            const waitingList = await daemon.pendingClientInteractions(workspaceId);
            assert.equal(waitingList.length, pending.length);
            const waiting = waitingList[0];
            assert.ok(waiting);
            assert.ok(pending.some((item) => item.toolCallId === `int:${waiting.interactionId}`));
            const sessionId = waiting.sessionId;
            if (boundary === "owner cancellation") {
                await daemon.cancelSession({ workspaceId, sessionId, reason: "MCP operation cancelled" });
            } else {
                await daemon.stop();
            }
            assert.deepEqual(await daemon.pendingClientInteractions(workspaceId), []);
            const loops = await daemon.listSessionLoops({ workspaceId, sessionId });
            assert.equal(loops.find(({ id }) => id === waiting.loopId)?.status, 499);
            assert.equal(provider.received.length, 1, "cancellation never resumes inference");
            assert.equal(fixture.updates.length, 0, "cancelled input is never submitted as a Task answer");
            assert.deepEqual(fixture.cancellations.map((cancellation) => cancellation.taskId), stage === "Task" ? [taskId] : [],
                "only a created remote Task is cancelled, before the owning operation settles");
            assert.equal(served.requests.map(wireRequest).filter(({ method }) => method === "tools/call").length,
                stage === "Task" ? 2 : 1, "the interrupted operation is not replayed");
            if (boundary === "owner cancellation") {
                await assertNotPending(pending[0].id);
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
        fixture: httpEntry(served.url),
    });
    owner = daemon;
    const first = interaction(await start(), ["proceed"]);
    const pending = interactions(await post({
        followUpElicitations: 2,
        resume: [{ interruptId: first.id, action: "accept", content: { proceed: true } }],
    }), 2);
    const mutate = (kind: string) => post({ _meta: { plurnk: {
        workspace: "mcp-interaction-composition", projectRoot: null, action: { kind, alias: "fixture" },
    } } });
    const rejected = await mutate("workspace.mcp.disable");
    // {§acp-plurnk-metadata} A JSON-RPC _plurnk/action response carries error.data.problem on failure.
    const rejectedError = (rejected.find((event) => "error" in event) as { error?: { data?: { problem?: { status: number; type: string } } } } | undefined)?.error?.data?.problem;
    assert.ok(rejectedError, JSON.stringify(rejected));
    assert.equal(rejectedError.status, 409);
    assert.equal(rejectedError.type, "https://problems.plurnk.xyz/daemon/workspace-functionality/workspace-busy");
    const resurfaced = rediscoveredAll(await reconnect(), pending);
    const profile = resurfaced.find((item) => item.mode === "form")!;
    const authorize = resurfaced.find((item) => item.mode === "url")!;
    completed(await post({ resume: [
        { interruptId: profile.id, action: "accept", content: { name: "Ada" } },
        { interruptId: authorize.id, action: "accept" },
    ] }), provider, /Ada reviewed MCP/u);
    assert.deepEqual(fixture.cancellations, [], "the failed mutation neither cancels nor replaces the original Task");
    const disabled = await mutate("workspace.mcp.disable");
    assert.ok(disabled.some((event) => "result" in event), JSON.stringify(disabled));
    assert.deepEqual(fixture.cancellations, [], "completed Tasks are not cancelled again at connection close");
});

for (const source of ["MRTR", "Task", "resource", "prompt"] as const) {
    test(`{§mcp-host-composition}: ${source} input expires without a human answer and the session recovers`, { timeout: 20_000 }, async (t) => {
        let owner: Daemon | undefined;
        t.after(() => owner?.stop());
        const tool = source === "MRTR" || source === "Task";
        const fixture = tool ? taskHandler() : undefined;
        const served = fixture === undefined ? undefined : await serveMcpHttp(t, fixture.handler, fixture.route);
        const operation = tool ? '````fixture (deferred-review)\n{"topic":"MCP"}\n````'
            : source === "resource" ? "````READ (fixture:///resources/fixture%3A%2F%2Fguarded) <1,-1>````"
                : "````READ (fixture:///prompts/guarded?topic=MCP) <1,-1>````";
        const { provider, post, start, reconnect, assertNotPending, daemon } = await setup(t, operation, {
            fixture: served === undefined ? stdioEntry("interaction-server.mjs") : httpEntry(served.url),
        }, {
            PLURNK_MCP_REQUEST_TIMEOUT: "1000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
        });
        owner = daemon;
        const events = await start();
        const first = interaction(events, [tool ? "proceed" : "confirm"]);
        const pending = source !== "Task" ? [first] : interactions(await post({
            followUpElicitations: 2,
            resume: [{ interruptId: first.id, action: "accept", content: { proceed: true } }],
        }), 2);
        const wsUpdate = updatesOf(events).find((u) => u.sessionUpdate === "notice" && u.title === "workspace:state") as {
            _meta?: { plurnk?: { workspace?: { id: number } } };
        } | undefined;
        assert.ok(wsUpdate?._meta?.plurnk?.workspace);
        const workspaceId = wsUpdate._meta.plurnk.workspace.id;
        const [waiting] = await daemon.pendingClientInteractions(workspaceId);
        assert.ok(waiting);
        await waitForDb(() => daemon.pendingClientInteractions(workspaceId), (rows) => rows.length === 0,
            { timeoutMs: 3000 });
        await waitForDb(() => daemon.listSessionLoops({ workspaceId, sessionId: waiting.sessionId }),
            (loops) => loops.find(({ id }) => id === waiting.loopId)?.status === 200);
        assert.equal(provider.received.length, 2, "expiry resumes the same session with the operation failure");
        const packet = provider.received[1].map(chatMessageText).join("\n");
        assert.match(packet, /operation timeout/u);
        assert.match(packet, tool ? /tool-call-failed/u : /resource-read-failed/u);
        await assertNotPending(pending[0].id);
        const synced = await reconnect();
        const terminal = synced.at(-1) as { result?: Record<string, unknown> } | undefined;
        assert.ok(terminal?.result !== undefined);
        assert.equal(provider.received.length, 2, "late input and reconnect do not replay work");
        if (fixture !== undefined && served !== undefined) {
            assert.deepEqual(fixture.cancellations.map((cancellation) => cancellation.taskId), source === "Task" ? [taskId] : []);
            assert.deepEqual(fixture.updates, [], "expired human input is not submitted to the server");
            assert.equal(served.requests.map(wireRequest).filter(({ method }) => method === "tools/call").length,
                source === "Task" ? 2 : 1);
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin Composition ({§mcp-configuration})
// ─────────────────────────────────────────────────────────────────────────────

const parseOne = (input: string): PlurnkStatement => {
    const item = PlurnkParser.parseStatements(input, { executors: fixtureExecutors(input) }).items.find((candidate) => candidate.kind === "statement");
    assert.equal(item?.kind, "statement");
    return item.statement;
};

test("{§mcp-configuration} workspace management preserves plugin interpretation, restores inheritance, and leaves shared installations intact", { timeout: 30_000 }, async (t) => {
    const { hostPaths, env } = await mcpFixture(t, {});
    const project = join(hostPaths.home, "project");
    const root = join(hostPaths.projectPluginsDir(project), "bundle");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "plugin.json"), JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "bundle" }));
    const entry = stdioEntry("echo-server.mjs", { PLURNK_MCP_TEST_LAUNCH: "1", SAMPLE: "${PLUGIN_ROOT}", LITERAL: "${VALUE}" });
    const contents = JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: { example: entry } });
    await writeFile(join(root, "mcp.json"), contents);
    env.VALUE = "native-expansion";
    env.PLUGIN_ROOT = "native-root";
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null, hostPaths });
    daemon.registerModule(McpModule.init({ env }), "@plurnk/plurnk-mcp");
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const a = await daemon.createWorkspace({ name: "plugin-a", projectRoot: project });
    const b = await daemon.createWorkspace({ name: "plugin-b", projectRoot: null });
    const action = (workspaceId: number, verb: string, params = {}) => daemon.invokeModuleAction(`workspace.mcp.${verb}`, params, { scope: "workspace", workspaceId });
    const list = async (workspaceId: number) => (await action(workspaceId, "list") as FunctionalityListResult).definitions;
    assert.deepEqual((await list(a.workspaceId))[0]?.provenance, { kind: "plugin", source: join(root, "mcp.json"), reference: "/mcpServers/example" });
    assert.deepEqual(await list(b.workspaceId), []);
    const call = async () => {
        const before = (await db.test_entries_by_scheme_prefix.all({ workspace_id: a.workspaceId, scheme: "example", prefix: "/%" })).length;
        const [result] = await daemon.dispatchClientAction({ workspaceId: a.workspaceId, actor: TEST_OWNER, statements: [parseOne("````example (launch)\n{}\n````")] });
        assert.equal(result.status, 200);
        const output = await awaitExecOutcome(db, { workspaceId: a.workspaceId, scheme: "example", channel: "json", after: before });
        return JSON.parse((output.content as { text: string }[])[0].text);
    };
    const first = await call();
    assert.equal(first.cwd, root);
    assert.equal(first.root, root);
    assert.equal(first.sample, root);
    assert.equal(first.literal, "${VALUE}");
    assert.equal(first.data, hostPaths.pluginDataDir("bundle", root));
    const marker = join(first.data, "retained.txt");
    await writeFile(marker, "persistent");
    await action(a.workspaceId, "disable", { alias: "example" });
    assert.equal((await list(a.workspaceId))[0]?.state, "disabled");
    await action(a.workspaceId, "enable", { alias: "example" });
    assert.equal((await call()).data, first.data);
    await action(a.workspaceId, "add", { alias: "example", definition: { name: "example", ...entry } });
    const local = await call();
    assert.notEqual(local.cwd, root);
    assert.equal(local.root, undefined, "replacing the definition drops plugin-only environment injection");
    assert.equal(local.sample, "native-root", "native interpretation now owns the identical symbolic value");
    assert.equal(local.literal, "native-expansion");
    await action(a.workspaceId, "remove", { alias: "example" });
    const restored = await call();
    assert.equal(restored.cwd, root);
    assert.equal(restored.literal, "${VALUE}");
    assert.equal(restored.data, first.data);
    assert.equal(await readFile(marker, "utf8"), "persistent");
    assert.equal(await readFile(join(root, "mcp.json"), "utf8"), contents);
});

test("{§mcp-configuration} unsupported entries reach the model as diagnostics without blocking valid siblings or subsequent repair", { timeout: 30_000 }, async (t) => {
    serverProposals(t, "accept");
    const { hostPaths, env } = await mcpFixture(t, {});
    const project = join(hostPaths.home, "project");
    const root = join(hostPaths.projectPluginsDir(project), "bundle");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "plugin.json"), JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "bundle" }));
    const entry = stdioEntry("echo-server.mjs");
    const file = join(root, "mcp.json");
    await writeFile(file, JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: { example: entry, legacy: { type: "sse", url: "https://example.org/mcp" } } }));
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 1_000_000, responses: Array.from({ length: 2 }, () => makeMockResponse("````SEND [200]\nChecked.\n````")) });
    const daemon = new Daemon({ db, provider, hostPaths });
    daemon.registerModule(McpModule.init({ env }), "@plurnk/plurnk-mcp");
    t.after(async () => { await daemon.stop(); await db.close(); });
    const ended: number[] = [];
    t.after(daemon.subscribeToEvents((_w, method, params) => { if (method === "loop/terminated") ended.push((params as { loopId: number }).loopId); }));
    await daemon.start();
    const workspace = await daemon.createWorkspace({ name: "plugin-repair", projectRoot: project });
    const sessionId = await insertSession(db, workspace.workspaceId, null, "model", "model");
    const turn = async () => {
        const started = await daemon.runLoop({ ...workspace, sessionId, prompt: "Inspect configuration." });
        await waitFor(() => ended, (ids) => ids.includes(started.loopId), { timeoutMs: 10_000 });
    };
    await turn();
    assert.match(userText(provider.received[0]), /legacy SSE transport is unsupported/);
    const listed = await daemon.invokeModuleAction("workspace.mcp.list", {}, { scope: "workspace", workspaceId: workspace.workspaceId }) as FunctionalityListResult;
    assert.equal(listed.definitions.find(({ alias }) => alias === "example")?.state, "active");
    await writeFile(file, JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: { example: entry } }));
    await turn();
    assert.doesNotMatch(userText(provider.received[1]), /legacy SSE transport is unsupported/);
});
