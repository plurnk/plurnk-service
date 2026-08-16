// {§mcp-model-projection} {§agui-proposal-resolve} — the assembled daemon proof:
// a client hot-attaches a current MCP server through AG-UI, the resulting exact
// tools enter the model packet, read effects execute directly, and host effects
// remain behind the standard terminate/resume review boundary.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

test("AG-UI hot attachment composes MCP Registry, execution, review, failure, and recovery", { timeout: 30_000 }, async () => {
    const provider = new PacketCapturingMock({
        contextWindow: 1_000_000,
        responses: [
            makeMockResponse([
                "# PLAN0",
                "Use the newly attached observation tool.",
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
                "Exercise the reviewed host tool and observe its reported failure.",
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
        assert.match(firstPacket, /## Registered Tools/);
        assert.match(firstPacket, /\| `\[fixture\]` \| `\(echo\)`<br>Echo one message\./);
        assert.match(firstPacket, /`\{"message": string\}`/);
        assert.match(firstPacket, /\| `\[fixture\]` \| `\(fail\)`<br>Return a deterministic tool error\./);
        assert.match(packet(provider.requests, 1), /hello from MCP/, "the remote result entered the next model packet");
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
        const recoveryPacket = packet(provider.requests, 3);
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
    }
});
