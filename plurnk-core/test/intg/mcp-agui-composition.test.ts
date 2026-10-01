// {§mcp-model-projection} {§agui-proposal-resolve} — the assembled daemon proof:
// an installed plugin's cold MCP server composes through AG-UI, ordinary Plurnk
// resource discovery reaches its exact tools, read effects execute directly,
// and host effects remain behind the standard terminate/resume review boundary.

import { chatMessageText } from "@plurnk/plurnk-providers";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Module as AguiModule } from "@plurnk/plurnk-agui";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { Mock } from "@plurnk/plurnk-providers";
import Daemon from "../../src/server/Daemon.ts";
import { openMigrated } from "./_db.ts";
import { makeMockResponse } from "./_mock.ts";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import { httpEntry, mcpFixture, stdioEntry } from "./_mcp-config.ts";

type Event = Readonly<Record<string, unknown>>;

class PacketCapturingMock extends Mock {
    readonly requests: Array<ReadonlyArray<{ readonly role: string; readonly content: string }>> = [];

    override generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
        this.requests.push(args[0].messages.map((message) => ({ role: message.role, content: chatMessageText(message) })));
        return super.generate(...args);
    }
}

const parseEvents = (body: string): Event[] => body
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => JSON.parse(frame.slice(6)) as Event);

const post = async (port: number, input: Readonly<Record<string, unknown>>): Promise<Event[]> => {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    return parseEvents(await response.text());
};

const runInput = (
    workspace: string,
    runId: string,
    additions: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => ({
    threadId: workspace,
    runId,
    state: {},
    messages: [],
    tools: [],
    context: [],
    forwardedProps: { plurnk: { workspace } },
    ...additions,
});

const actionResult = (events: readonly Event[]): {
    readonly ok: boolean;
    readonly result?: Readonly<Record<string, unknown>>;
    readonly problem?: Readonly<Record<string, unknown>>;
} => {
    const event = events.find((candidate) =>
        candidate.type === "CUSTOM" && candidate.name === "plurnk.action.result") as {
        readonly value?: {
            readonly ok: boolean;
            readonly result?: Readonly<Record<string, unknown>>;
            readonly problem?: Readonly<Record<string, unknown>>;
        };
    } | undefined;
    assert.ok(event?.value !== undefined, "the AG-UI action returned its standard result event");
    return event.value;
};

const packet = (requests: PacketCapturingMock["requests"], index: number): string =>
    requests[index]?.map(({ content }) => content).join("\n\n") ?? "";

test("{§functionality-preparation-visibility} a stalled MCP catalog is visible over AG-UI before inference and inspectable on another connection", { timeout: 15_000 }, async (t) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const visible = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    const handler = createMcpHandler(() => {
        const server = new McpServer({ name: "slow-catalog", version: "1.0.0" });
        server.registerTool("inspect", { description: "Inspect fixture state." }, async () => ({ content: [{ type: "text", text: "fixture" }] }));
        return server;
    }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 });
    const served = await serveMcpHttp(t, handler, async (request) => {
        if ((await request.clone().json()).method !== "tools/list") return null;
        entered.resolve();
        await release.promise;
        return null;
    });
    const provider = new PacketCapturingMock({ responses: [makeMockResponse("```KILL\nOK\n```")], contextWindow: 1_000_000 });
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, { fixture: httpEntry(served.url) });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider, hostPaths });
    daemon.registerModule(McpModule.init({ env: { ...mcpEnv,
        PLURNK_MCP_CONNECT_TIMEOUT: "10000", PLURNK_MCP_REQUEST_TIMEOUT: "10000",
        PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
    } }));
    const started = Promise.withResolvers<AguiModule>();
    const registration = AguiModule.init({ host: "127.0.0.1", port: 0 });
    daemon.registerModule({ start: async (seam) => {
        const module = await registration.start(seam);
        started.resolve(module);
        return module;
    } });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const { port } = (await started.promise).address();
    const workspace = "preparation-visibility";
    await daemon.createWorkspace({ name: workspace });
    const inspect = () => post(port, runInput(workspace, crypto.randomUUID(), {
        forwardedProps: { plurnk: { workspace, action: { kind: "workspace.mcp.list" } } },
    }));
    const cold = actionResult(await inspect());
    assert.equal(cold.ok, true);
    assert.equal((cold.result!.definitions as { state: string }[])[0].state, "dormant");
    assert.equal(served.requests.length, 0, "inspection never connects to the MCP server");
    const response = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(runInput(workspace, "prompt", { messages: [{ id: "m", role: "user", content: "Reply OK." }] })),
    });
    assert.equal(response.status, 200);
    const events: Event[] = [];
    const finished = (async () => {
        let buffer = "";
        const decoder = new TextDecoder();
        for await (const chunk of response.body!) {
            buffer += decoder.decode(chunk, { stream: true });
            const frames = buffer.split("\n\n");
            buffer = frames.pop()!;
            for (const frame of frames) {
                for (const event of parseEvents(`${frame}\n\n`)) {
                    events.push(event);
                    if (event.type === "STATE_DELTA" && JSON.stringify(event.delta).includes('"alias":"fixture"')) visible.resolve();
                }
            }
        }
    })();
    await Promise.race([entered.promise, finished.then(() => assert.fail(`The run ended before catalog preparation: ${JSON.stringify(events)}`))]);
    await Promise.race([visible.promise, finished.then(() => assert.fail(`The run ended without preparation visibility: ${JSON.stringify(events)}`))]);
    assert.equal(provider.requests.length, 0, "the client can see startup before the provider is called");
    const during = await inspect();
    assert.equal(actionResult(during).ok, true, "inspection does not join the stalled activation");
    const snapshot = during.find((event) => event.type === "STATE_SNAPSHOT") as { snapshot: { plurnk: { status: { preparation: { family: string; alias: string | null }[] } } } };
    assert.ok(snapshot.snapshot.plurnk.status.preparation.some(({ family, alias }) => family === "mcp" && alias === "fixture"));
    release.resolve();
    await finished;
    assert.equal(provider.requests.length, 1);
    assert.ok(events.some((event) => event.type === "STATE_DELTA" && JSON.stringify(event.delta).includes('"path":"/plurnk/status/preparation","value":[]')));
    assert.ok(events.some((event) => event.type === "RUN_FINISHED"));
    assert.doesNotMatch(packet(provider.requests, 0), /workspace\/preparation/);
});

test("{§mcp-configuration} AG-UI composes configured MCP servers: execution, review, failure, and recovery", { timeout: 30_000 }, async (t) => {
    const previousFilesItems = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    const provider = new PacketCapturingMock({
        contextWindow: 1_000_000,
        responses: [
            makeMockResponse("\n````READ (worker:///_plurnk/tools/fixture.md) <1,-1>````\n````NOTE\nSelect and inspect the echo contract linked from the family document.\n````"),
            makeMockResponse("\n````READ (worker:///_plurnk/tools/fixture/echo.json) <1,-1>````\n````NOTE\nInvoke the documented observation tool.\n````"),
            makeMockResponse("\n````fixture (echo)\nhello from MCP\n````\n\n````NOTE\nInspect the attributable tool failure.\n````"),
            makeMockResponse("\n````KILL (log:///**/READ)````\n````fixture (echo)\n{\"message\":\"hello from MCP\"}\n````\n\n````NOTE\nInspect the corrected tool result.\n````"),
            makeMockResponse("\n````FIND (fixture:///**) <1,-1> [{\"pattern\":\"invalid-tool-arguments\"}]````\n\n````NOTE\nInspect the source's durable terminal result.\n````"),
            makeMockResponse("````KILL\nThe MCP echo returned hello from MCP and its earlier failure remains inspectable at the source.\n````"),
            makeMockResponse("\n````READ (worker:///_plurnk/tools/fixture.md) <1,-1>````\n````NOTE\nInvoke the documented host tool.\n````"),
            makeMockResponse("\n````fixture (fail)````\n````NOTE\nInspect the failure.\n````"),
            makeMockResponse("````KILL\nThe MCP server reported its expected tool error; recovery is complete.\n````"),
        ],
    });
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, {
        fixture: stdioEntry("echo-server.mjs", {
            PLURNK_MCP_TEST_TITLE: "Transport fixture",
            PLURNK_MCP_TEST_INSTRUCTIONS: "Echo tools for transport testing.\n\n## Usage\nPass the message field unchanged.",
        }),
        legacy: stdioEntry("legacy-server.mjs"),
    });
    const db = await openMigrated();
    const daemon = new Daemon({
        db,
        provider,
        nodeModulesPath: join(import.meta.dirname, "../../node_modules"),
        hostPaths,
    });
    daemon.registerModule(McpModule.init({
        env: {
            ...mcpEnv,
            PLURNK_MCP_CONNECT_TIMEOUT: "30000",
            PLURNK_MCP_REQUEST_TIMEOUT: "30000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
            PLURNK_MCP_fixture_TOOLS: '["echo","fail"]',
        },
    }));
    const aguiRegistration = AguiModule.init({ host: "127.0.0.1", port: 0 });
    let agui: AguiModule | null = null;
    daemon.registerModule({
        start: async (seam) => {
            agui = await aguiRegistration.start(seam);
            return agui;
        },
    });
    const projectRoot = await mkdtemp(join(tmpdir(), "plurnk-mcp-composition-"));

    try {
        await daemon.start();
        assert.ok(agui !== null);
        const port = (agui as AguiModule).address().port;
        const workspace = `mcp-composition-${crypto.randomUUID()}`;

        const listed = actionResult(await post(port, runInput(workspace, "list", {
            forwardedProps: { plurnk: { workspace, projectRoot, action: { kind: "workspace.mcp.list" } } },
        })));
        assert.equal(listed.ok, true, JSON.stringify(listed.problem));
        if (listed.result === undefined) throw new Error("workspace.mcp.list returned no result");
        assert.deepEqual(
            (listed.result.definitions as Array<{ alias: string; origin: string; state: string }>).map(({ alias, origin, state }) => ({ alias, origin, state })),
            [{ alias: "fixture", origin: "service", state: "dormant" }, { alias: "legacy", origin: "service", state: "dormant" }],
            "the installed plugin's servers are available and enabled, dormant until first use",
        );
        // Enabling the installed server activates the workspace, registering its tools before any turn.
        const enabled = actionResult(await post(port, runInput(workspace, "enable", {
            forwardedProps: { plurnk: { workspace, projectRoot, action: { kind: "workspace.mcp.enable", alias: "fixture" } } },
        })));
        assert.equal(enabled.ok, true, JSON.stringify(enabled.problem));
        assert.equal((enabled.result?.definition as { state?: string } | undefined)?.state, "active");
        assert.equal((enabled.result?.definition as { origin?: string } | undefined)?.origin, "service");

        // {§capability-admission} — exact MCP tools occupy the same selector
        // space as every other capability. One workspace restriction removes only
        // the denied tool from both dispatch and the model's generated contract.
        const attenuated = actionResult(await post(port, runInput(workspace, "deny-fail-tool", {
            forwardedProps: {
                plurnk: {
                    workspace,
                    projectRoot,
                    action: {
                        kind: "workspace.capabilities.set",
                        policy: { deny: [{ runtime: "fixture", tool: "fail" }] },
                    },
                },
            },
        })));
        assert.equal(attenuated.ok, true, JSON.stringify(attenuated.problem));
        assert.deepEqual(attenuated.result?.workspace, {
            deny: [{ runtime: "fixture", tool: "fail" }],
        });
        const deniedTool = actionResult(await post(port, runInput(workspace, "invoke-denied-tool", {
            forwardedProps: {
                plurnk: {
                    workspace,
                    projectRoot,
                    action: { kind: "op.parse", text: "````fixture (fail)\n{}\n````" },
                },
            },
        })));
        assert.equal(deniedTool.ok, true, JSON.stringify(deniedTool.problem));
        if (deniedTool.result === undefined) throw new Error("op.parse returned no result");
        const [deniedResult] = deniedTool.result.results as Array<{
            status: number;
            problem?: Readonly<Record<string, unknown>>;
        }>;
        assert.equal(deniedResult?.status, 403);
        assert.equal(deniedResult?.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/capability-denied");
        assert.equal(deniedResult?.problem?.runtime, "fixture");
        assert.equal(deniedResult?.problem?.tool, "fail");
        assert.equal(deniedResult?.problem?.policyScope, "workspace");

        const observed = await post(port, runInput(workspace, "read-tool", {
            messages: [{ id: "prompt-read", role: "user", content: "Use the attached echo tool, then report its result." }],
        }));
        assert.equal(observed.at(-1)?.type, "RUN_FINISHED");
        assert.equal((observed.at(-1)?.outcome as { type?: string } | undefined)?.type, "success");
        const workspaceRow = (await daemon.listWorkspaces()).find((row) => row.name === workspace);
        assert.ok(workspaceRow !== undefined);
        const [producer] = await daemon.listWorkers(workspaceRow.id, { origin: "model" });
        assert.ok(producer !== undefined);
        const streamEvents = observed.filter((event) => event.type === "CUSTOM" && event.name === "plurnk.stream")
            .map((event) => event.value as { workerId: number; target: string; result?: { status: number } });
        assert.ok(streamEvents.some((event) => event.result?.status === 200), "the producer's AG-UI Run receives its actual MCP conclusion");
        assert.ok(streamEvents.some((event) => event.result === undefined), "MCP output streams through AG-UI before its conclusion");
        assert.ok(streamEvents.every((event) => event.workerId === producer.id), "stream provenance identifies the producing conversation, not a storage owner");
        assert.ok(streamEvents.every((event) => !Object.hasOwn(event, "producerWorkerId")), "the wire carries one causal actor identity");
        assert.ok(streamEvents.every((event) => /^fixture:\/\/\/[a-f0-9]{8}$/u.test(event.target)));
        const firstPacket = packet(provider.requests, 0);
        assert.ok(firstPacket.includes("```mcp (list|discover|add|enable|disable|remove) <!-- Manage MCP servers -->\\\\n```"),
            "the initial survey teaches the manager's complete lifecycle");
        assert.doesNotMatch(firstPacket, /## Registered Tools/);
        assert.match(firstPacket, /Echo tools for transport testing\./);
        assert.doesNotMatch(firstPacket, /Pass the message field unchanged/, "full server instructions are not pushed into turn0");
        assert.match(firstPacket, /"path":"worker:\/\/\/_plurnk\/tools\/fixture\.md"/);
        assert.match(firstPacket, /```fixture \(echo\)/);
        assert.doesNotMatch(firstPacket, /```fixture \([^)]*fail/);
        assert.doesNotMatch(firstPacket, /"path":"worker:\/\/\/_plurnk\/tools\/fixture\/echo\.json"/, "without PLURNK_MCP_EXPANDED, turn 0 surveys family documents only");
        const familyContract = packet(provider.requests, 1);
        assert.match(familyContract, /Pass the message field unchanged\./, "READ of the family document retrieves the full authored instructions");
        assert.match(familyContract, /```fixture \(echo\) <!-- Echo one message\. Schema: worker:\/\/\/_plurnk\/tools\/fixture\/echo\.json -->/);
        assert.doesNotMatch(familyContract, /```fixture \(fail\)/);
        const echoContract = packet(provider.requests, 2);
        assert.match(echoContract, /"title": "fixture: echo"/);
        assert.match(echoContract, /"additionalProperties": false/, "the linked document preserves constraints omitted from the preview");
        assert.match(echoContract, /"required": \[/);
        assert.doesNotMatch(echoContract, /output schema/i);
        const failedInvocation = packet(provider.requests, 3);
        assert.match(failedInvocation, /invalid-tool-arguments/, "the first malformed invocation reached the model as the exact MCP failure");
        assert.match(failedInvocation, /One JSON object per MCP tool call/, "the failure names the form that works, not only the JSON diagnostic");
        assert.match(failedInvocation, /log:\/\/\/\d+\/\d+\/\d+\/READ/, "the failure has a stable log coordinate curated by the next turn");
        const correctedInvocation = packet(provider.requests, 4);
        assert.match(correctedInvocation, /hello from MCP/, "the corrected remote result entered the next model packet");
        assert.doesNotMatch(
            correctedInvocation,
            /invalid-tool-arguments/,
            "curating the first terminal receipt cannot cause the failed MCP stream to be delivered again",
        );
        const revisitedFailure = packet(provider.requests, 5);
        assert.match(revisitedFailure, /fixture:\/\/\/[a-f0-9]{8}/);
        assert.match(
            revisitedFailure,
            /invalid-tool-arguments/,
            "an explicit source query still composes its exact terminal producer failure after receipt curation",
        );
        const observedSpeech = observed
            .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
            .map((event) => String(event.delta ?? ""))
            .join("");
        assert.match(observedSpeech, /echo returned hello from MCP/);

        const restored = actionResult(await post(port, runInput(workspace, "restore-fail-tool", {
            forwardedProps: {
                plurnk: {
                    workspace,
                    projectRoot,
                    action: { kind: "workspace.capabilities.set", policy: {} },
                },
            },
        })));
        assert.equal(restored.ok, true, JSON.stringify(restored.problem));
        assert.deepEqual(restored.result?.workspace, {});

        const interrupted = await post(port, runInput(workspace, "host-tool-a", {
            messages: [{ id: "prompt-fail", role: "user", content: "Call the attached fail tool and recover from its result." }],
        }));
        const terminal = interrupted.at(-1);
        assert.equal(terminal?.type, "RUN_FINISHED");
        const outcome = terminal?.outcome as {
            readonly type?: string;
            readonly interrupts?: ReadonlyArray<{ readonly toolCallId?: string }>;
        } | undefined;
        assert.equal(outcome?.type, "interrupt");
        assert.equal(outcome?.interrupts?.length, 1);
        const interruptId = outcome?.interrupts?.[0]?.toolCallId;
        assert.match(interruptId ?? "", /^prop:\d+$/);

        const resumed = await post(port, runInput(workspace, "host-tool-b", {
            resume: [{
                interruptId,
                status: "resolved",
                payload: { decision: "accept" },
            }],
        }));
        assert.equal(resumed.at(-1)?.type, "RUN_FINISHED");
        assert.equal((resumed.at(-1)?.outcome as { type?: string } | undefined)?.type, "success");
        const failContract = packet(provider.requests, 7);
        assert.match(failContract, /Return a deterministic tool error\./);
        assert.match(failContract, /```fixture \(fail\)/);
        const recoveryPacket = packet(provider.requests, 8);
        assert.match(recoveryPacket, /tool-reported-error/);
        assert.match(recoveryPacket, /The MCP tool reported an error\./);
        assert.match(recoveryPacket, /"diagnostic":"fixture failure"/, "the durable observed result retains the server's explanation");
        const toolFailure = resumed.find((event) => event.type === "CUSTOM" && event.name === "plurnk.stream"
            && (event.value as { result?: { problem?: { tool?: string } } } | undefined)?.result?.problem?.tool === "fail");
        assert.ok(toolFailure, "the actual AG-UI stream conclusion carries the tool failure");
        const toolResult = (toolFailure.value as { result: { status: number; problem: { diagnostic?: string } } }).result;
        assert.equal(toolResult.status, 502);
        assert.equal(toolResult.problem.diagnostic, "fixture failure");
        const recoveredSpeech = resumed
            .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
            .map((event) => String(event.delta ?? ""))
            .join("");
        assert.match(recoveredSpeech, /reported its expected tool error; recovery is complete/);

        // {§mcp-authority} — a legacy peer negotiates below the pin and serves its
        // standard catalog instead of being rejected.
        const legacyList = actionResult(await post(port, runInput(workspace, "legacy-list", {
            forwardedProps: {
                plurnk: {
                    workspace,
                    action: { kind: "workspace.mcp.list" },
                },
            },
        })));
        const legacyServer = (legacyList.result?.definitions as ReadonlyArray<Readonly<Record<string, unknown>>> | undefined)
            ?.find((server) => server.alias === "legacy");
        assert.equal(legacyServer?.state, "active");
        assert.equal((legacyServer?.detail as { protocolVersion?: string } | undefined)?.protocolVersion, "2025-06-18");
        assert.deepEqual((legacyServer?.detail as { tools?: string[] } | undefined)?.tools, ["legacy_echo"]);
    } finally {
        await daemon.stop();
        await db.close();
        await rm(projectRoot, { recursive: true, force: true });
        if (previousFilesItems === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
        else process.env.PLURNK_SERVICE_FILES_ITEMS = previousFilesItems;
    }
});

test(
    "current third-party stdio and HTTP servers compose through the assembled product",
    {
        skip: process.env.PLURNK_TEST_MCP_DOGFOOD !== "1",
        timeout: 120_000,
    },
    async (t) => {
        const previousFilesItems = process.env.PLURNK_SERVICE_FILES_ITEMS;
        process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
        const provider = new PacketCapturingMock({
            contextWindow: 1_000_000,
            responses: [
                makeMockResponse("\n````READ (worker:///_plurnk/tools/kubernetes.md) <1,-1>````\n````NOTE\nSelect the configuration tool linked from the family document.\n````"),
                makeMockResponse("\n````READ (worker:///_plurnk/tools/kubernetes/configuration_view.json) <1,-1>````\n````NOTE\nUse the exact contract after reading it.\n````"),
                makeMockResponse("\n````kubernetes (configuration_view)\n{\"minified\":true}\n````\n\n````NOTE\nInspect the returned configuration.\n````"),
                makeMockResponse("````KILL\nThe current Kubernetes context is specimen.\n````"),
                makeMockResponse("\n````READ (worker:///_plurnk/tools/goji.md) <1,-1>````\n````NOTE\nSelect the terminology tool linked from the family document.\n````"),
                makeMockResponse("\n````READ (worker:///_plurnk/tools/goji/goji_explain_term.json) <1,-1>````\n````NOTE\nUse the documented tool and resource.\n````"),
                makeMockResponse("\n````goji (goji_explain_term)\n{\"term\":\"AEO\"}\n````\n\n````READ (goji:///resources/goji%3A%2F%2Fabout)````\n````NOTE\nInspect both remote results.\n````"),
                makeMockResponse("````KILL\nGOJI defines AEO as Answer Engine Optimisation and identifies itself as a Melbourne digital agency.\n````"),
            ],
        });
        const projectRoot = await mkdtemp(join(tmpdir(), "plurnk-mcp-dogfood-"));
        const kubeconfig = join(projectRoot, "kubeconfig");
        await writeFile(kubeconfig, [
            "apiVersion: v1",
            "kind: Config",
            "clusters:",
            "  - name: unreachable",
            "    cluster:",
            "      server: http://127.0.0.1:9",
            "contexts:",
            "  - name: specimen",
            "    context:",
            "      cluster: unreachable",
            "      user: anonymous",
            "current-context: specimen",
            "users:",
            "  - name: anonymous",
            "    user: {}",
            "",
        ].join("\n"));
        // {§mcp-configuration}
        const { hostPaths, env: mcpEnv } = await mcpFixture(t, {
            kubernetes: {
                type: "stdio",
                command: "npx",
                args: [
                    "--yes",
                    "kubernetes-mcp-server@0.0.66",
                    "--kubeconfig",
                    kubeconfig,
                    "--read-only",
                    "--log-file",
                    join(projectRoot, "kubernetes.log"),
                ],
            },
            goji: httpEntry("https://mcp.goji.agency/mcp"),
        });
        const db = await openMigrated();
        const daemon = new Daemon({
            db,
            provider,
            nodeModulesPath: join(import.meta.dirname, "../../node_modules"),
            hostPaths,
        });
        daemon.registerModule(McpModule.init({
            env: {
                ...mcpEnv,
                PLURNK_MCP_CONNECT_TIMEOUT: "30000",
                PLURNK_MCP_REQUEST_TIMEOUT: "30000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
                PLURNK_MCP_kubernetes_TOOLS: '["configuration_view"]',
                PLURNK_MCP_goji_TOOLS: '["goji_explain_term"]',
            },
        }));
        const aguiRegistration = AguiModule.init({ host: "127.0.0.1", port: 0 });
        let agui: AguiModule | null = null;
        daemon.registerModule({
            start: async (seam) => {
                agui = await aguiRegistration.start(seam);
                return agui;
            },
        });

        try {
            await daemon.start();
            assert.ok(agui !== null);
            const port = (agui as AguiModule).address().port;
            const workspace = `mcp-dogfood-${crypto.randomUUID()}`;

            const kubernetes = actionResult(await post(port, runInput(workspace, "enable-kubernetes", {
                forwardedProps: {
                    plurnk: {
                        workspace,
                        projectRoot,
                        action: { kind: "workspace.mcp.enable", alias: "kubernetes" },
                    },
                },
            })));
            assert.equal(kubernetes.ok, true, JSON.stringify(kubernetes.problem));
            const kubernetesSummary = kubernetes.result?.definition as {
                readonly detail?: { readonly tools?: readonly string[] };
            } | undefined;
            assert.equal(kubernetesSummary?.detail?.tools?.length, 14, "the real server advertises a larger catalog");

            const goji = actionResult(await post(port, runInput(workspace, "enable-goji", {
                forwardedProps: {
                    plurnk: {
                        workspace,
                        action: { kind: "workspace.mcp.enable", alias: "goji" },
                    },
                },
            })));
            assert.equal(goji.ok, true, JSON.stringify(goji.problem));
            // A tool's read effect is its server's own readOnlyHint ({§mcp-model-projection}); these Runs
            // accept proposals so the composition does not depend on third-party annotations.
            const policy = { proposals: "accept" };

            const kubernetesRun = await post(port, runInput(workspace, "call-kubernetes", {
                messages: [{
                    id: "prompt-kubernetes",
                    role: "user",
                    content: "Use the attached Kubernetes configuration tool and report the current context.",
                }],
                forwardedProps: { plurnk: { workspace, policy } },
            }));
            assert.equal((kubernetesRun.at(-1)?.outcome as { type?: string } | undefined)?.type, "success");
            const familyCatalog = packet(provider.requests, 0);
            assert.match(familyCatalog, /worker:\/\/\/_plurnk\/tools\/kubernetes\.md/);
            assert.match(familyCatalog, /worker:\/\/\/_plurnk\/tools\/goji\.md/);
            assert.doesNotMatch(familyCatalog, /configuration_view/, "Turn0 surveys only family documents");
            const kubernetesFamily = packet(provider.requests, 1);
            assert.match(kubernetesFamily, /worker:\/\/\/_plurnk\/tools\/kubernetes\/configuration_view\.md/);
            assert.doesNotMatch(kubernetesFamily, /pods_list/, "disabled remote tools stay out of the family contract");
            const kubernetesContract = packet(provider.requests, 2);
            assert.match(kubernetesContract, /```kubernetes \(configuration_view\)/);
            assert.doesNotMatch(kubernetesContract, /pods_list/, "one exact document carries only its selected tool contract");
            assert.match(packet(provider.requests, 3), /current-context: specimen/);

            const gojiRun = await post(port, runInput(workspace, "call-goji", {
                messages: [{
                    id: "prompt-goji",
                    role: "user",
                    content: "Ask GOJI to explain AEO and read its about resource.",
                }],
                forwardedProps: { plurnk: { workspace, policy } },
            }));
            assert.equal((gojiRun.at(-1)?.outcome as { type?: string } | undefined)?.type, "success");
            assert.match(packet(provider.requests, 5), /worker:\/\/\/_plurnk\/tools\/goji\/goji_explain_term\.md/);
            assert.match(packet(provider.requests, 6), /```goji \(goji_explain_term\)/);
            const remoteResults = packet(provider.requests, 7);
            assert.match(remoteResults, /Answer Engine Optimisation/);
            assert.match(remoteResults, /Melbourne-based full-service digital agency/);
            const speech = gojiRun
                .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
                .map((event) => String(event.delta ?? ""))
                .join("");
            assert.match(speech, /GOJI defines AEO as Answer Engine Optimisation/);
        } finally {
            await daemon.stop();
            await db.close();
            await rm(projectRoot, { recursive: true, force: true });
            if (previousFilesItems === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
            else process.env.PLURNK_SERVICE_FILES_ITEMS = previousFilesItems;
        }
    },
);
