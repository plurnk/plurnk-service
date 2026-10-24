// {§mcp-model-projection} {§acp-proposal-resolve} — the assembled daemon proof:
// an installed plugin's cold MCP server composes through ACP, ordinary Plurnk
// resource discovery reaches its exact tools, read effects execute directly,
// and host effects remain behind the standard terminate/resume review boundary.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { actionResult, type Event, packet, PacketCapturingMock, parseEvents, post, runInput } from "./_acp-run.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import Daemon from "../../src/server/Daemon.ts";
import { bindListener } from "./_a2a.ts";
import { openMigrated } from "./_db.ts";
import { makeMockResponse } from "./_mock.ts";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import { httpEntry, mcpFixture, stdioEntry } from "./_mcp-config.ts";

test("{§functionality-preparation-visibility} a stalled MCP catalog is visible over ACP before inference and inspectable on another connection", { timeout: 15_000 }, async (t) => {
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
    const provider = new PacketCapturingMock({ responses: [makeMockResponse("```SEND [200]\nOK\n```")], contextWindow: 1_000_000 });
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, { fixture: httpEntry(served.url) });
    const db = await openMigrated();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider, hostPaths, http });
    daemon.registerModule(McpModule.init({ env: { ...mcpEnv,
        PLURNK_MCP_CONNECT_TIMEOUT: "10000", PLURNK_MCP_REQUEST_TIMEOUT: "10000",
        PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
    } }), "@plurnk/plurnk-mcp");
    t.after(async () => { await daemon.stop(); await http.close(); await db.close(); });
    await daemon.start();
    const { port } = http.httpAddress();
    const workspace = "preparation-visibility";
    await daemon.createWorkspace({ name: workspace });
    const inspect = () => post(port, runInput(workspace, crypto.randomUUID(), {
        forwardedProps: { plurnk: { workspace, action: { kind: "workspace.mcp.list" } } },
    }));
    const cold = actionResult(await inspect());
    assert.equal(cold.ok, true);
    assert.equal((cold.result!.definitions as { state: string }[])[0].state, "dormant");
    assert.equal(served.requests.length, 0, "inspection never connects to the MCP server");
    const response = await fetch(`http://127.0.0.1:${port}/acp`, {
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
    // {§acp-workspace-state} Preparation is the workspace's, so a Run that binds no worker carries it too.
    const snapshot = during.find((event) => event.type === "STATE_SNAPSHOT") as { snapshot: { plurnk: { workspace: { preparation: { family: string; alias: string | null }[] } } } };
    assert.ok(snapshot.snapshot.plurnk.workspace.preparation.some(({ family, alias }) => family === "mcp" && alias === "fixture"));
    release.resolve();
    await finished;
    assert.equal(provider.requests.length, 1);
    assert.ok(events.some((event) => event.type === "STATE_DELTA" && JSON.stringify(event.delta).includes('"path":"/plurnk/workspace/preparation","value":[]')));
    assert.ok(events.some((event) => event.type === "RUN_FINISHED"));
    assert.doesNotMatch(packet(provider.requests, 0), /workspace\/preparation/);
});

test("{§mcp-configuration} ACP composes configured MCP servers: execution, review, failure, and recovery", { timeout: 30_000 }, async (t) => {
    const previousFilesItems = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    const provider = new PacketCapturingMock({
        contextWindow: 1_000_000,
        responses: [
            makeMockResponse("\n````READ (worker:///_plurnk/tools/fixture.md) <1,-1>````\n````NOTE\nSelect and inspect the echo contract linked from the runtime document.\n````"),
            makeMockResponse([
                PlurnkParser.frame("READ (worker:///_plurnk/tools/fixture/echo.json) <1,-1>", null),
                PlurnkParser.frame('FIND (worker:///_plurnk/tools/fixture.json) $.tools[?(@.name=="echo")].name <1,-1>', null),
                PlurnkParser.frame('READ (worker:///_plurnk/tools/fixture.json) $.tools[?(@.name=="echo")] <1,-1>', null),
                PlurnkParser.frame("NOTE", "Invoke the documented observation tool."),
            ].join("\n\n")),
            makeMockResponse("\n````fixture (echo)\nhello from MCP\n````\n\n````NOTE\nInspect the attributable tool failure.\n````"),
            makeMockResponse("\n````KILL (log:///**/READ)````\n````fixture (echo)\n{\"message\":\"hello from MCP\"}\n````\n\n````NOTE\nInspect the corrected tool result.\n````"),
            makeMockResponse("\n````FIND (fixture:///**) <1,-1> [{\"pattern\":\"invalid-tool-arguments\"}]````\n\n````NOTE\nInspect the source's durable terminal result.\n````"),
            makeMockResponse("````SEND [200]\nThe MCP echo returned hello from MCP and its earlier failure remains inspectable at the source.\n````"),
            makeMockResponse("\n````READ (worker:///_plurnk/tools/fixture.md) <1,-1>````\n````NOTE\nInvoke the documented host tool.\n````"),
            makeMockResponse("\n````fixture (fail)````\n````NOTE\nInspect the failure.\n````"),
            makeMockResponse("````SEND [200]\nThe MCP server reported its expected tool error; recovery is complete.\n````"),
        ],
    });
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, {
        fixture: stdioEntry("echo-server.mjs", {
            PLURNK_MCP_TEST_TITLE: "Transport fixture",
            PLURNK_MCP_TEST_WHERE: "1",
            PLURNK_MCP_TEST_INSTRUCTIONS: "Echo tools for transport testing.\n\n## Usage\nPass the message field unchanged.",
        }),
        legacy: stdioEntry("legacy-server.mjs"),
    });
    const db = await openMigrated();
    const http = await bindListener();
    const daemon = new Daemon({
        db,
        provider,
        nodeModulesPath: join(import.meta.dirname, "../../node_modules"),
        hostPaths,
        http,
    });
    daemon.registerModule(McpModule.init({
        env: {
            ...mcpEnv,
            PLURNK_MCP_CONNECT_TIMEOUT: "30000",
            PLURNK_MCP_REQUEST_TIMEOUT: "30000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
            PLURNK_MCP_fixture_TOOLS: '["echo","fail"]',
        },
    }), "@plurnk/plurnk-mcp");
    const projectRoot = await mkdtemp(join(tmpdir(), "plurnk-mcp-composition-"));

    try {
        await daemon.start();
        const { port } = http.httpAddress();
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
        assert.ok(streamEvents.some((event) => event.result?.status === 200), "the producer's ACP Run receives its actual MCP conclusion");
        assert.ok(streamEvents.some((event) => event.result === undefined), "MCP output streams through ACP before its conclusion");
        assert.ok(streamEvents.every((event) => event.workerId === producer.id), "stream provenance identifies the producing worker, not a storage owner");
        assert.ok(streamEvents.every((event) => !Object.hasOwn(event, "producerWorkerId")), "the wire carries one causal actor identity");
        assert.ok(streamEvents.every((event) => /^fixture:\/\/\/[a-f0-9]{8}$/u.test(event.target)));
        const firstPacket = packet(provider.requests, 0);
        assert.ok(firstPacket.includes("```mcp (list|add|replace|enable|disable|remove) <!-- Manage MCP servers -->\\n```"),
            "the initial survey teaches the manager's lifecycle; with no registry it has no discover");
        assert.match(firstPacket, /Echo tools for transport testing\./);
        assert.doesNotMatch(firstPacket, /Pass the message field unchanged/, "full server instructions are not pushed into turn0");
        assert.match(firstPacket, /"path":"worker:\/\/\/_plurnk\/tools\/fixture\.md"/);
        assert.match(firstPacket, /```fixture \(echo\)/);
        assert.doesNotMatch(firstPacket, /```fixture \([^)]*fail/);
        assert.doesNotMatch(firstPacket, /"path":"worker:\/\/\/_plurnk\/tools\/fixture\/echo\.json"/, "without PLURNK_MCP_EXPANDED, turn 0 surveys runtime documents only");
        assert.doesNotMatch(firstPacket, /fixture\.json|inputSchema|readOnlyHint/,
            "the catalog and its full definitions are not injected into turn0");
        const runtimeContract = packet(provider.requests, 1);
        assert.match(runtimeContract, /Pass the message field unchanged\./, "READ of the runtime document retrieves the full authored instructions");
        assert.match(runtimeContract, /```fixture \(echo\) <!-- Echo one message\. Schema: worker:\/\/\/_plurnk\/tools\/fixture\/echo\.json -->/);
        assert.doesNotMatch(runtimeContract, /```fixture \(fail\)/);
        assert.match(runtimeContract, /worker:\/\/\/_plurnk\/tools\/fixture\.json/);
        const echoContract = packet(provider.requests, 2);
        assert.match(echoContract, /"title": "fixture: echo"/);
        assert.match(echoContract, /"additionalProperties": false/, "the linked document preserves constraints omitted from the preview");
        assert.match(echoContract, /"required": \[/);
        assert.doesNotMatch(echoContract, /output schema/i);
        assert.match(echoContract, /"name": "echo"/);
        assert.match(echoContract, /"inputSchema": \{/);
        assert.match(echoContract, /"readOnlyHint": true/,
            "an ordinary JSONPath READ materializes the selected complete tool record in the log");
        assert.doesNotMatch(echoContract, /pattern-(?:invalid|unsupported)|entry-not-found/);
        const toolsCatalog = async () => {
            const parsed = PlurnkParser.parseStatements(PlurnkParser.frame("READ (worker:///_plurnk/tools/fixture.json) <1,-1>", null));
            const item = parsed.items[0];
            assert.equal(item?.kind, "statement");
            if (item?.kind !== "statement") throw new Error("Expected one READ");
            // A person's READ, acting for the producing model worker ({§actor-boundary-client-operations}).
            const [result] = await daemon.dispatchClientAction({
                workspaceId: workspaceRow.id, actor: "test://primary", contextWorkerId: producer.id, statements: [item.statement],
            });
            assert.equal(result.status, 200);
            return JSON.parse(result.content as string) as { tools: { name: string; inputSchema: object }[] };
        };
        assert.deepEqual((await toolsCatalog()).tools.map(({ name }) => name), ["echo"],
            "the catalog excludes both capability-denied fail and non-allowlisted where");
        const found = actionResult(await post(port, runInput(workspace, "find-tool-definition", {
            forwardedProps: { plurnk: { workspace, action: { kind: "op.parse",
                text: PlurnkParser.frame('FIND (worker:///_plurnk/tools/fixture.json) $.tools[?(@.name=="echo")].name <1,-1>', null),
            } } },
        })));
        assert.equal(found.ok, true, JSON.stringify(found.problem));
        const [match] = found.result!.results as { status: number; matchingPathCount: number; matchLocationCount: number }[];
        assert.equal(match?.status, 200);
        assert.equal(match.matchingPathCount, 1);
        assert.equal(match.matchLocationCount, 1, "ordinary FIND locates the requested tool in the JSON catalog");
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
            .map((event) => (typeof event.delta === "string" ? event.delta : ""))
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
        assert.deepEqual((await toolsCatalog()).tools.map(({ name }) => name), ["echo", "fail"],
            "policy reconciliation restores only the configured tools");

        const interrupted = await post(port, runInput(workspace, "host-tool-a", {
            messages: [{ id: "prompt-fail", role: "user", content: "Call the attached fail tool and recover from its result." }],
        }));
        const terminal = interrupted.at(-1);
        assert.equal(terminal?.type, "RUN_FINISHED");
        const outcome = terminal?.outcome as {
            readonly type?: string;
            readonly interrupts?: ReadonlyArray<{ readonly id: string; readonly toolCallId?: string }>;
        } | undefined;
        assert.equal(outcome?.type, "interrupt");
        assert.equal(outcome?.interrupts?.length, 1);
        const interruptId = outcome?.interrupts?.[0]?.id;
        assert.ok(interruptId);
        // {§acp-proposal-resolve} The gate names the operation's own call, which its Run presented before it.
        const gated = outcome?.interrupts?.[0]?.toolCallId;
        assert.match(gated ?? "", /^\d+\/\d+\/\d+$/);
        assert.ok(interrupted.some((event) => event.type === "TOOL_CALL_START" && (event as { toolCallId?: unknown }).toolCallId === gated),
            "the gated call precedes its interrupt");

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
        assert.ok(toolFailure, "the actual ACP stream conclusion carries the tool failure");
        const toolResult = (toolFailure.value as { result: { status: number; problem: { diagnostic?: string } } }).result;
        assert.equal(toolResult.status, 502);
        assert.equal(toolResult.problem.diagnostic, "fixture failure");
        const recoveredSpeech = resumed
            .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
            .map((event) => (typeof event.delta === "string" ? event.delta : ""))
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
        await http.close();
        await db.close();
        await rm(projectRoot, { recursive: true, force: true });
        if (previousFilesItems === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
        else process.env.PLURNK_SERVICE_FILES_ITEMS = previousFilesItems;
    }
});
