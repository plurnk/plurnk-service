import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import HostPaths from "../../src/core/HostPaths.ts";
import Daemon from "../../src/server/Daemon.ts";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import { openMigrated } from "./_db.ts";
import { bindListener } from "./_http.ts";
import type { Db } from "../../src/core/Db.ts";
import { ModelProvider, type AttributionHeaderField, type ProviderFetch } from "@plurnk/plurnk-providers";
import type { DaemonModule, ProviderMetadataContext, ProviderMetadataSeam } from "@plurnk/plurnk-modules";

const sseToolCallResponse = (
    toolName: string,
    args: Record<string, unknown>,
    id = "call_1",
): Response => new Response([
    `data: ${JSON.stringify({
        id: "cmpl-tool",
        object: "chat.completion.chunk",
        created: 1,
        model: "proxy-model",
        choices: [{
            index: 0,
            delta: {
                role: "assistant",
                tool_calls: [{
                    index: 0,
                    id,
                    type: "function",
                    function: { name: toolName, arguments: JSON.stringify(args) },
                }],
            },
            finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}`,
    "data: [DONE]",
].join("\n\n"), { headers: { "content-type": "text/event-stream" } });

const sseTextResponse = (content: string): Response => new Response([
    `data: ${JSON.stringify({
        id: "cmpl-text",
        object: "chat.completion.chunk",
        created: 1,
        model: "proxy-model",
        choices: [{
            index: 0,
            delta: { role: "assistant", content },
            finish_reason: "stop",
        }],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    })}`,
    "data: [DONE]",
].join("\n\n"), { headers: { "content-type": "text/event-stream" } });

const makeWireProvider = (
    attributionHeaders: ReadonlySet<AttributionHeaderField>,
    responses: Response[],
    modelName: string,
): {
    provider: ModelProvider;
    providerSpec: { readonly provider: string; readonly model: string };
    capturedHeaders: Headers[];
} => {
    const capturedHeaders: Headers[] = [];
    const queue = [...responses];
    const customFetch: ProviderFetch = async (input, init) => {
        const headers = init?.headers !== undefined
            ? new Headers(init.headers)
            : input instanceof Request
                ? new Headers(input.headers)
                : new Headers();
        capturedHeaders.push(headers);
        const next = queue.shift();
        if (next === undefined) throw new Error("test wire provider exhausted");
        return next;
    };
    const provider = new ModelProvider({
        model: modelName,
        url: "http://magic-proxy.test/v1/chat/completions",
        headers: { Authorization: "Bearer test-token" },
        attributionHeaders,
        fetch: customFetch,
        contextWindow: 32_768,
        outputBudget: 4_096,
        outputFloor: 1_024,
        fetchTimeoutMs: 5_000,
        operationTimeoutMs: 10_000,
        effort: { mode: "off", budget: null },
        temperature: null,
        repeatPenalty: null,
        retryAttempts: 0,
        source: "provider:openrouter",
    });
    const providerSpec = { provider: "openrouter", model: modelName } as const;
    ProviderInstantiate.registerInstance(provider, providerSpec, process.env, "off");
    return { provider, providerSpec, capturedHeaders };
};

const waitForLoopTerminal = async (
    db: Db,
    loopId: number,
): Promise<number> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const row = await db.engine_loop_status.get<{ status: number }>({ loop_id: loopId });
        if (row !== undefined && row.status !== 100 && row.status !== 102) return row.status;
        await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error(`loop ${loopId} did not settle`);
};

test("{§provider-request-authority} {§module-seam-slices} Daemon routes transmit X-Plurnk-* and module X-Plurnk-Meta-* headers only when opted in across emission and bare calls", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-attribution-intg-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const hostPaths = new HostPaths({ home: root, env: {} });

    // Case 1: Opt-in with all fields including `module`, exercising both emission and BARE calls.
    {
        const db = await openMigrated();
        const http = await bindListener();
        const { providerSpec, capturedHeaders } = makeWireProvider(
            new Set([
                "workspace",
                "workspace-id",
                "session",
                "session-id",
                "actor",
                "loop",
                "turn",
                "call-kind",
                "module",
            ]),
            [
                // Turn 1 emission invokes plurnk.bare
                sseToolCallResponse("mcp", {
                    server: "plurnk",
                    tool: "bare",
                    arguments: { prompt: "summarize this" },
                }),
                // Bare call answer
                sseTextResponse("bare summary"),
                // Turn 2 emission finishes cleanly
                sseToolCallResponse("mcp", {
                    server: "plurnk",
                    tool: "done",
                    arguments: { message: "finished" },
                }),
            ],
            "proxy-model-all",
        );
        const daemon = new Daemon({ db, hostPaths, provider: null, http });
        const observedContexts: ProviderMetadataContext[] = [];
        const billingModule: DaemonModule<ProviderMetadataSeam> = {
            setup(seam) {
                seam.registerProviderMetadataContributor((ctx) => {
                    observedContexts.push(ctx);
                    return {
                        "tenant-key": `ws-${ctx.workspaceName}`,
                        tier: "starter",
                    };
                });
            },
        };
        const regionModule: DaemonModule<ProviderMetadataSeam> = {
            setup(seam) {
                seam.registerProviderMetadataContributor(() => ({ region: "us-east" }));
            },
        };
        daemon.registerModule(billingModule, "@plurnk/test-billing");
        daemon.registerModule(regionModule, "@plurnk/test-region");
        await daemon.start();
        t.after(async () => {
            await daemon.stop();
            await http.close();
            await db.close();
        });

        const { workspaceId } = await daemon.createWorkspace({ name: "bot-tenant-a", projectRoot: null });
        const { sessionId } = await daemon.createSession({ workspaceId, name: "group-42" });
        const injected = await daemon.inject({
            workspaceId,
            sessionId,
            prompt: "run a bare summary and finish",
            source: "client:telegram:777",
            providerSpec,
            effort: "off",
            systemPrompt: "test system",
        });
        assert.ok(injected.loopId !== null);
        const status = await waitForLoopTerminal(db, injected.loopId);
        assert.equal(status, 200);

        assert.equal(capturedHeaders.length, 3, "expected turn-1 emission, bare call, and turn-2 emission");
        const [emission1, bareCall, emission2] = capturedHeaders;
        for (const [headers, expectedKind] of [
            [emission1, "emission"],
            [bareCall, "bare"],
            [emission2, "emission"],
        ] as const) {
            assert.equal(headers.get("authorization"), "Bearer test-token");
            assert.equal(headers.get("x-plurnk-workspace"), "bot-tenant-a");
            assert.equal(headers.get("x-plurnk-workspace-id"), String(workspaceId));
            assert.equal(headers.get("x-plurnk-session"), "group-42");
            assert.equal(headers.get("x-plurnk-session-id"), String(sessionId));
            assert.equal(headers.get("x-plurnk-actor"), "client:telegram:777");
            assert.equal(headers.get("x-plurnk-loop-id"), String(injected.loopId));
            assert.ok(Number(headers.get("x-plurnk-turn-id")) > 0);
            assert.equal(headers.get("x-plurnk-call-kind"), expectedKind);
            assert.equal(headers.get("x-plurnk-meta-tenant-key"), "ws-bot-tenant-a");
            assert.equal(headers.get("x-plurnk-meta-tier"), "starter");
            assert.equal(headers.get("x-plurnk-meta-region"), "us-east");
        }
        assert.deepEqual(
            observedContexts.map((ctx) => ({
                workspaceName: ctx.workspaceName,
                sessionName: ctx.sessionName,
                actor: ctx.actor,
                callKind: ctx.callKind,
                provider: ctx.provider,
                model: ctx.model,
            })),
            [
                { workspaceName: "bot-tenant-a", sessionName: "group-42", actor: "client:telegram:777", callKind: "emission", provider: "openrouter", model: "proxy-model-all" },
                { workspaceName: "bot-tenant-a", sessionName: "group-42", actor: "client:telegram:777", callKind: "bare", provider: "openrouter", model: "proxy-model-all" },
                { workspaceName: "bot-tenant-a", sessionName: "group-42", actor: "client:telegram:777", callKind: "emission", provider: "openrouter", model: "proxy-model-all" },
            ],
        );
    }

    // Case 2: Default off route emits zero X-Plurnk-* headers and never invokes module contributors.
    {
        const db = await openMigrated();
        const http = await bindListener();
        const { providerSpec, capturedHeaders } = makeWireProvider(new Set(), [
            sseToolCallResponse("mcp", { server: "plurnk", tool: "done", arguments: { message: "ok" } }),
        ], "proxy-model-off");
        const daemon = new Daemon({ db, hostPaths, provider: null, http });
        let contributorCalls = 0;
        daemon.registerModule({
            setup(seam) {
                seam.registerProviderMetadataContributor(() => {
                    contributorCalls += 1;
                    return { secret: "must-not-run" };
                });
            },
        }, "@plurnk/test-unopted");
        await daemon.start();
        t.after(async () => {
            await daemon.stop();
            await http.close();
            await db.close();
        });

        const { workspaceId } = await daemon.createWorkspace({ name: "private-ws", projectRoot: null });
        const { sessionId } = await daemon.createSession({ workspaceId, name: "private-session" });
        const injected = await daemon.inject({
            workspaceId,
            sessionId,
            prompt: "hello",
            source: "client:alice",
            providerSpec,
            effort: "off",
            systemPrompt: "test system",
        });
        assert.equal(await waitForLoopTerminal(db, injected.loopId), 200);
        assert.equal(contributorCalls, 0, "contributors must not run for routes with attribution off");
        assert.equal(capturedHeaders.length, 1);
        for (const [name] of capturedHeaders[0].entries()) {
            assert.ok(!name.startsWith("x-plurnk-"), `unopted route leaked ${name}`);
        }
    }

    // Case 3: Route opting into workspace+actor (without `module`) skips module contributors and emits no X-Plurnk-Meta-*.
    {
        const db = await openMigrated();
        const http = await bindListener();
        const { providerSpec, capturedHeaders } = makeWireProvider(new Set(["workspace", "actor"]), [
            sseToolCallResponse("mcp", { server: "plurnk", tool: "done", arguments: { message: "ok" } }),
        ], "proxy-model-partial");
        const daemon = new Daemon({ db, hostPaths, provider: null, http });
        let contributorCalls = 0;
        daemon.registerModule({
            setup(seam) {
                seam.registerProviderMetadataContributor(() => {
                    contributorCalls += 1;
                    return { tier: "enterprise" };
                });
            },
        }, "@plurnk/test-no-module-optin");
        await daemon.start();
        t.after(async () => {
            await daemon.stop();
            await http.close();
            await db.close();
        });

        const { workspaceId } = await daemon.createWorkspace({ name: "partial-ws", projectRoot: null });
        const { sessionId } = await daemon.createSession({ workspaceId, name: "partial-session" });
        const injected = await daemon.inject({
            workspaceId,
            sessionId,
            prompt: "hello",
            source: "client:bob",
            providerSpec,
            effort: "off",
            systemPrompt: "test system",
        });
        assert.equal(await waitForLoopTerminal(db, injected.loopId), 200);
        assert.equal(contributorCalls, 0, "contributors must not run unless `module` is in the opt-in allowlist");
        assert.equal(capturedHeaders[0].get("x-plurnk-workspace"), "partial-ws");
        assert.equal(capturedHeaders[0].get("x-plurnk-actor"), "client:bob");
        assert.equal(capturedHeaders[0].get("x-plurnk-session"), null);
        assert.equal(capturedHeaders[0].get("x-plurnk-meta-tier"), null);
    }
});

test("{§module-seam-slices} {§provider-configuration} duplicate contributor keys fail loudly and Daemon.validateConfiguration rejects malformed attribution knobs", async (t) => {
    const prior = process.env.PLURNK_PROVIDERS_PROVIDER_OPENROUTER_ATTRIBUTION_HEADERS;
    t.after(() => {
        if (prior === undefined) delete process.env.PLURNK_PROVIDERS_PROVIDER_OPENROUTER_ATTRIBUTION_HEADERS;
        else process.env.PLURNK_PROVIDERS_PROVIDER_OPENROUTER_ATTRIBUTION_HEADERS = prior;
    });

    process.env.PLURNK_PROVIDERS_PROVIDER_OPENROUTER_ATTRIBUTION_HEADERS = "workspace,unknown-token";
    assert.throws(
        () => Daemon.validateConfiguration(),
        /PLURNK_PROVIDERS_PROVIDER_OPENROUTER_ATTRIBUTION_HEADERS has invalid field "unknown-token"/u,
    );
    delete process.env.PLURNK_PROVIDERS_PROVIDER_OPENROUTER_ATTRIBUTION_HEADERS;

    const root = await mkdtemp(join(tmpdir(), "plurnk-attribution-conflict-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const hostPaths = new HostPaths({ home: root, env: {} });
    const db = await openMigrated();
    const http = await bindListener();
    const { providerSpec, capturedHeaders } = makeWireProvider(new Set(["module"]), [
        sseToolCallResponse("mcp", { server: "plurnk", tool: "done", arguments: { message: "ok" } }),
    ], "proxy-model-conflict");
    const daemon = new Daemon({ db, hostPaths, provider: null, http });
    let contributorACalls = 0;
    let contributorBCalls = 0;
    daemon.registerModule({
        setup(seam) {
            seam.registerProviderMetadataContributor(() => {
                contributorACalls += 1;
                return { plan: "a" };
            });
        },
    }, "@plurnk/test-conflict-a");
    daemon.registerModule({
        setup(seam) {
            seam.registerProviderMetadataContributor(() => {
                contributorBCalls += 1;
                return { plan: "b" };
            });
        },
    }, "@plurnk/test-conflict-b");
    await daemon.start();
    t.after(async () => {
        await daemon.stop();
        await http.close();
        await db.close();
    });

    const { workspaceId } = await daemon.createWorkspace({ name: "conflict-ws", projectRoot: null });
    const { sessionId } = await daemon.createSession({ workspaceId, name: "conflict-session" });
    const injected = await daemon.inject({
        workspaceId,
        sessionId,
        prompt: "hi",
        providerSpec,
        effort: "off",
        systemPrompt: "test system",
    });
    const status = await waitForLoopTerminal(db, injected.loopId);
    assert.equal(status, 500, "duplicate contributor key must fail the loop before provider dispatch");
    assert.equal(contributorACalls, 1, "first contributor must have run");
    assert.equal(contributorBCalls, 1, "second contributor must have run and triggered collision");
    assert.equal(capturedHeaders.length, 0, "provider must never be called when contributor merging fails");
});

test("{§provider-instantiation} {§provider-configuration} ProviderInstantiate cache separates provider-scoped attribution header settings on reload", async (t) => {
    const priorKey = process.env.OPENROUTER_API_KEY;
    const priorAttr = process.env.PLURNK_PROVIDERS_PROVIDER_OPENROUTER_ATTRIBUTION_HEADERS;
    t.after(() => {
        if (priorKey === undefined) delete process.env.OPENROUTER_API_KEY;
        else process.env.OPENROUTER_API_KEY = priorKey;
        if (priorAttr === undefined) delete process.env.PLURNK_PROVIDERS_PROVIDER_OPENROUTER_ATTRIBUTION_HEADERS;
        else process.env.PLURNK_PROVIDERS_PROVIDER_OPENROUTER_ATTRIBUTION_HEADERS = priorAttr;
    });
    process.env.OPENROUTER_API_KEY = "test-or-key";
    delete process.env.PLURNK_PROVIDERS_PROVIDER_OPENROUTER_ATTRIBUTION_HEADERS;
    const spec = { provider: "openrouter", model: "openai/gpt-4.1-mini" } as const;
    const withoutAttr = await ProviderInstantiate.instantiateProvider(spec, process.env, "off");
    assert.deepEqual([...(withoutAttr.attributionHeaders ?? [])], []);

    process.env.PLURNK_PROVIDERS_PROVIDER_OPENROUTER_ATTRIBUTION_HEADERS = "workspace,actor";
    const withAttr = await ProviderInstantiate.instantiateProvider(spec, process.env, "off");
    assert.notEqual(withAttr, withoutAttr, "changing provider-scoped attribution headers must invalidate the process cache");
    assert.deepEqual([...(withAttr.attributionHeaders ?? [])], ["workspace", "actor"]);
});
