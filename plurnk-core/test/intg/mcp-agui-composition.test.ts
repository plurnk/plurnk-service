// {§mcp-model-projection} {§agui-proposal-resolve} — the assembled daemon proof:
// a client hot-attaches a current MCP server through AG-UI, ordinary Plurnk
// resource discovery reaches its exact tools, read effects execute directly,
// and host effects remain behind the standard terminate/resume review boundary.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Module as AguiModule } from "@plurnk/plurnk-agui";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { Mock } from "@plurnk/plurnk-providers";
import Daemon from "../../src/server/Daemon.ts";
import { openMigrated } from "./_helpers.ts";
import { makeMockResponse } from "./_rpc.ts";

type Event = Readonly<Record<string, unknown>>;

class PacketCapturingMock extends Mock {
    readonly requests: Array<ReadonlyArray<{ readonly role: string; readonly content: string }>> = [];

    override generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
        this.requests.push(args[0].messages.map(({ role, content }) => ({ role, content })));
        return super.generate(...args);
    }
}

const fixture = fileURLToPath(
    new URL("../../../plurnk-mcp/src/fixtures/echo-server.mjs", import.meta.url),
);
const legacyFixture = fileURLToPath(
    new URL("../../../plurnk-mcp/src/fixtures/legacy-server.mjs", import.meta.url),
);

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

test("AG-UI hot attachment composes MCP discovery, execution, review, failure, and recovery", { timeout: 30_000 }, async () => {
    const previousFilesItems = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    const provider = new PacketCapturingMock({
        contextWindow: 1_000_000,
        responses: [
            makeMockResponse([
                "# PLAN0",
                "Inspect the newly attached tool family.",
                "",
                "## READ0 (worker://plurnk/tools/fixture.md) <1,-1>",
                "",
                "## SEND0 [102]",
                "Discover the exact tools from the family contract.",
            ].join("\n")),
            makeMockResponse([
                "# PLAN0",
                "Discover the fixture family's exact tools.",
                "",
                "## FIND0 (worker://plurnk/tools/fixture/*.md) <1,-1>",
                "",
                "## SEND0 [102]",
                "Select and inspect the echo contract.",
            ].join("\n")),
            makeMockResponse([
                "# PLAN0",
                "Read the selected echo invocation contract.",
                "",
                "## READ0 (worker://plurnk/tools/fixture/echo.md) <1,-1>",
                "",
                "## SEND0 [102]",
                "Invoke the documented observation tool.",
            ].join("\n")),
            makeMockResponse([
                "# PLAN0",
                "Use the documented observation tool.",
                "",
                "## EXEC0 [fixture] (echo)",
                '{"message":"hello from MCP"}',
                "",
                "## SEND0 [102]",
                "Inspect the tool result.",
            ].join("\n")),
            makeMockResponse("## SEND0 [200]\nThe MCP echo returned hello from MCP."),
            makeMockResponse([
                "# PLAN0",
                "Inspect the reviewed host tool before exercising it.",
                "",
                "## READ0 (worker://plurnk/tools/fixture/fail.md) <1,-1>",
                "",
                "## SEND0 [102]",
                "Invoke the documented host tool.",
            ].join("\n")),
            makeMockResponse([
                "# PLAN0",
                "Exercise the documented host tool and observe its reported failure.",
                "",
                "## EXEC0 [fixture] (fail)",
                "",
                "## SEND0 [102]",
                "Inspect the failure.",
            ].join("\n")),
            makeMockResponse("## SEND0 [200]\nThe MCP server reported its expected tool error; recovery is complete."),
        ],
    });
    const db = await openMigrated();
    const daemon = new Daemon({
        db,
        provider,
        nodeModulesPath: join(import.meta.dirname, "../../node_modules"),
    });
    daemon.registerModule(McpModule.init({
        env: {
            PLURNK_MCP_CONNECT_TIMEOUT: "30000",
            PLURNK_MCP_REQUEST_TIMEOUT: "30000",
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

        const attached = actionResult(await post(port, runInput(workspace, "attach", {
            forwardedProps: {
                plurnk: {
                    workspace,
                    projectRoot,
                    action: {
                        kind: "workspace.mcp.attach",
                        server: {
                            name: "fixture",
                            transport: "stdio",
                            command: process.execPath,
                            args: [fixture],
                            tools: ["echo", "fail"],
                            read: ["echo"],
                        },
                    },
                },
            },
        })));
        assert.equal(attached.ok, true, JSON.stringify(attached.problem));
        assert.equal(attached.result?.status, 201);

        const observed = await post(port, runInput(workspace, "read-tool", {
            messages: [{ id: "prompt-read", role: "user", content: "Use the attached echo tool, then report its result." }],
        }));
        assert.equal(observed.at(-1)?.type, "RUN_FINISHED");
        assert.equal((observed.at(-1)?.outcome as { type?: string } | undefined)?.type, "success");
        const firstPacket = packet(provider.requests, 0);
        assert.doesNotMatch(firstPacket, /## Registered Tools/);
        assert.match(firstPacket, /worker:\/\/plurnk\/tools\/fixture\.md/);
        assert.match(firstPacket, /Use enabled tools from the fixture MCP server\./);
        assert.doesNotMatch(firstPacket, /worker:\/\/plurnk\/tools\/fixture\/echo\.md/, "Turn0 surveys only family documents");
        assert.match(packet(provider.requests, 1), /worker:\/\/plurnk\/tools\/fixture\/\*\.md/, "the family document directs exact-tool discovery");
        const exactCatalog = packet(provider.requests, 2);
        assert.match(exactCatalog, /worker:\/\/plurnk\/tools\/fixture\/echo\.md/);
        assert.match(exactCatalog, /Echo one message\./);
        assert.match(exactCatalog, /worker:\/\/plurnk\/tools\/fixture\/fail\.md/);
        assert.match(exactCatalog, /Return a deterministic tool error\./);
        const echoContract = packet(provider.requests, 3);
        assert.match(echoContract, /## EXEC0 \[fixture\] \(echo\)/);
        assert.match(echoContract, /Signature: `\{"message": string\}`/);
        assert.doesNotMatch(echoContract, /output schema/i);
        assert.match(packet(provider.requests, 4), /hello from MCP/, "the remote result entered the next model packet");
        const observedSpeech = observed
            .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
            .map((event) => String(event.delta ?? ""))
            .join("");
        assert.match(observedSpeech, /echo returned hello from MCP/);

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
        const failContract = packet(provider.requests, 6);
        assert.match(failContract, /Return a deterministic tool error\./);
        assert.match(failContract, /## EXEC0 \[fixture\] \(fail\)/);
        const recoveryPacket = packet(provider.requests, 7);
        assert.match(recoveryPacket, /tool-reported-error/);
        assert.match(recoveryPacket, /MCP tool 'fail' on 'fixture' reported an error\./);
        const recoveredSpeech = resumed
            .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
            .map((event) => String(event.delta ?? ""))
            .join("");
        assert.match(recoveredSpeech, /reported its expected tool error; recovery is complete/);

        const legacy = actionResult(await post(port, runInput(workspace, "legacy-attach", {
            forwardedProps: {
                plurnk: {
                    workspace,
                    action: {
                        kind: "workspace.mcp.attach",
                        server: {
                            name: "legacy",
                            transport: "stdio",
                            command: process.execPath,
                            args: [legacyFixture],
                        },
                    },
                },
            },
        })));
        assert.equal(legacy.ok, false);
        assert.equal(
            legacy.problem?.type,
            "https://problems.plurnk.dev/mcp/management/protocol-revision-unsupported",
        );
        assert.equal(legacy.problem?.retryable, false);
        assert.equal(legacy.problem?.server, "legacy");
        assert.match(String(legacy.problem?.detail ?? ""), /upgrade or replace the legacy endpoint/i);
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
        skip: process.env.PLURNK_MCP_DOGFOOD !== "1",
        timeout: 120_000,
    },
    async () => {
        const previousFilesItems = process.env.PLURNK_SERVICE_FILES_ITEMS;
        process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
        const provider = new PacketCapturingMock({
            contextWindow: 1_000_000,
            responses: [
                makeMockResponse([
                    "# PLAN0",
                    "Inspect the enabled Kubernetes tool family.",
                    "",
                    "## READ0 (worker://plurnk/tools/kubernetes.md) <1,-1>",
                    "",
                    "## SEND0 [102]",
                    "Discover the exact Kubernetes tools from the family contract.",
                ].join("\n")),
                makeMockResponse([
                    "# PLAN0",
                    "Discover the enabled Kubernetes tools.",
                    "",
                    "## FIND0 (worker://plurnk/tools/kubernetes/*.md) <1,-1>",
                    "",
                    "## SEND0 [102]",
                    "Select the configuration tool.",
                ].join("\n")),
                makeMockResponse([
                    "# PLAN0",
                    "Inspect the selected Kubernetes tool contract before calling it.",
                    "",
                    "## READ0 (worker://plurnk/tools/kubernetes/configuration_view.md) <1,-1>",
                    "",
                    "## SEND0 [102]",
                    "Use the exact contract after reading it.",
                ].join("\n")),
                makeMockResponse([
                    "# PLAN0",
                    "Call the documented Kubernetes tool and inspect its result.",
                    "",
                    "## EXEC0 [kubernetes] (configuration_view)",
                    '{"minified":true}',
                    "",
                    "## SEND0 [102]",
                    "Inspect the returned configuration.",
                ].join("\n")),
                makeMockResponse("## SEND0 [200]\nThe current Kubernetes context is specimen."),
                makeMockResponse([
                    "# PLAN0",
                    "Inspect the remote HTTP tool family.",
                    "",
                    "## READ0 (worker://plurnk/tools/goji.md) <1,-1>",
                    "",
                    "## SEND0 [102]",
                    "Discover the exact GOJI tools from the family contract.",
                ].join("\n")),
                makeMockResponse([
                    "# PLAN0",
                    "Discover the enabled GOJI tools.",
                    "",
                    "## FIND0 (worker://plurnk/tools/goji/*.md) <1,-1>",
                    "",
                    "## SEND0 [102]",
                    "Select the terminology tool.",
                ].join("\n")),
                makeMockResponse([
                    "# PLAN0",
                    "Inspect the selected GOJI tool contract.",
                    "",
                    "## READ0 (worker://plurnk/tools/goji/goji_explain_term.md) <1,-1>",
                    "",
                    "## SEND0 [102]",
                    "Use the documented tool and resource.",
                ].join("\n")),
                makeMockResponse([
                    "# PLAN0",
                    "Use the documented remote HTTP tool and resource, then report both observations.",
                    "",
                    "## EXEC0 [goji] (goji_explain_term)",
                    '{"term":"AEO"}',
                    "",
                    "## READ0 (goji:///resources/goji%3A%2F%2Fabout)",
                    "",
                    "## SEND0 [102]",
                    "Inspect both remote results.",
                ].join("\n")),
                makeMockResponse("## SEND0 [200]\nGOJI defines AEO as Answer Engine Optimisation and identifies itself as a Melbourne digital agency."),
            ],
        });
        const db = await openMigrated();
        const daemon = new Daemon({
            db,
            provider,
            nodeModulesPath: join(import.meta.dirname, "../../node_modules"),
        });
        daemon.registerModule(McpModule.init({
            env: {
                PLURNK_MCP_CONNECT_TIMEOUT: "30000",
                PLURNK_MCP_REQUEST_TIMEOUT: "30000",
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

        try {
            await daemon.start();
            assert.ok(agui !== null);
            const port = (agui as AguiModule).address().port;
            const workspace = `mcp-dogfood-${crypto.randomUUID()}`;

            const kubernetes = actionResult(await post(port, runInput(workspace, "attach-kubernetes", {
                forwardedProps: {
                    plurnk: {
                        workspace,
                        projectRoot,
                        action: {
                            kind: "workspace.mcp.attach",
                            server: {
                                name: "kubernetes",
                                transport: "stdio",
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
                                tools: ["configuration_view"],
                                read: ["configuration_view"],
                            },
                        },
                    },
                },
            })));
            assert.equal(kubernetes.ok, true, JSON.stringify(kubernetes.problem));
            const kubernetesSummary = kubernetes.result?.server as {
                readonly enabledTools?: readonly string[];
                readonly tools?: readonly string[];
            } | undefined;
            assert.deepEqual(kubernetesSummary?.enabledTools, ["configuration_view"]);
            assert.equal(kubernetesSummary?.tools?.length, 14, "the real server advertises a larger catalog");

            const goji = actionResult(await post(port, runInput(workspace, "attach-goji", {
                forwardedProps: {
                    plurnk: {
                        workspace,
                        action: {
                            kind: "workspace.mcp.attach",
                            server: {
                                name: "goji",
                                transport: "http",
                                url: "https://mcp.goji.agency/mcp",
                                tools: ["goji_explain_term"],
                                read: ["goji_explain_term"],
                            },
                        },
                    },
                },
            })));
            assert.equal(goji.ok, true, JSON.stringify(goji.problem));

            const kubernetesRun = await post(port, runInput(workspace, "call-kubernetes", {
                messages: [{
                    id: "prompt-kubernetes",
                    role: "user",
                    content: "Use the attached Kubernetes configuration tool and report the current context.",
                }],
            }));
            assert.equal((kubernetesRun.at(-1)?.outcome as { type?: string } | undefined)?.type, "success");
            const familyCatalog = packet(provider.requests, 0);
            assert.match(familyCatalog, /worker:\/\/plurnk\/tools\/kubernetes\.md/);
            assert.match(familyCatalog, /worker:\/\/plurnk\/tools\/goji\.md/);
            assert.doesNotMatch(familyCatalog, /configuration_view/, "Turn0 surveys only family documents");
            assert.match(packet(provider.requests, 1), /worker:\/\/plurnk\/tools\/kubernetes\/\*\.md/);
            const kubernetesCatalog = packet(provider.requests, 2);
            assert.match(kubernetesCatalog, /worker:\/\/plurnk\/tools\/kubernetes\/configuration_view\.md/);
            assert.doesNotMatch(kubernetesCatalog, /pods_list/, "disabled remote tools stay out of exact-tool discovery");
            const kubernetesContract = packet(provider.requests, 3);
            assert.match(kubernetesContract, /## EXEC0 \[kubernetes\] \(configuration_view\)/);
            assert.doesNotMatch(kubernetesContract, /pods_list/, "one exact document carries only its selected tool contract");
            assert.match(packet(provider.requests, 4), /current-context: specimen/);

            const gojiRun = await post(port, runInput(workspace, "call-goji", {
                messages: [{
                    id: "prompt-goji",
                    role: "user",
                    content: "Ask GOJI to explain AEO and read its about resource.",
                }],
            }));
            assert.equal((gojiRun.at(-1)?.outcome as { type?: string } | undefined)?.type, "success");
            assert.match(packet(provider.requests, 6), /worker:\/\/plurnk\/tools\/goji\/\*\.md/);
            assert.match(packet(provider.requests, 7), /worker:\/\/plurnk\/tools\/goji\/goji_explain_term\.md/);
            assert.match(packet(provider.requests, 8), /## EXEC0 \[goji\] \(goji_explain_term\)/);
            const remoteResults = packet(provider.requests, 9);
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
