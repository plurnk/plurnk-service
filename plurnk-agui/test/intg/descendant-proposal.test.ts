// {§agui-proposal-resolve} An owning thread receives both its own
// gate and a descendant's later gate through the same ordinary AG-UI
// terminate/resume contract. The real daemon owns proposal identity and Worker
// topology; the module neither simulates nor flattens either one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import type { AguiEvent } from "../../src/types.ts";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

const post = async (
    port: number,
    input: Readonly<Record<string, unknown>>,
): Promise<AguiEvent[]> => {
    const response = await fetch(`http://127.0.0.1:${port}/agui`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            runId: crypto.randomUUID(),
            state: {},
            messages: [],
            tools: [],
            context: [],
            ...input,
        }),
    });
    assert.equal(response.status, 200);
    return (await response.text())
        .split("\n\n")
        .filter((frame) => frame.startsWith("data: "))
        .map((frame) => JSON.parse(frame.slice(6)) as AguiEvent);
};

const interruptedBy = (events: readonly AguiEvent[], op: string): string => {
    const terminal = events.at(-1) as {
        type?: string;
        outcome?: {
            type?: string;
            interrupts?: Array<{ id: string; toolCallId?: string }>;
        };
    } | undefined;
    assert.equal(terminal?.type, "RUN_FINISHED");
    assert.equal(terminal?.outcome?.type, "interrupt");
    const interrupt = terminal.outcome.interrupts?.[0] as { id?: string; toolCallId?: string; metadata?: { plurnk?: { proposal?: { op?: unknown } } } } | undefined;
    const id = interrupt?.id;
    if (typeof id !== "string") assert.fail("the interrupt has no string identity");
    // {§agui-proposal-resolve} The gate carries Core's projection of the operation, and names its call on a Run that
    // holds that worker's conversation.
    assert.equal(interrupt?.metadata?.plurnk?.proposal?.op, op, JSON.stringify(events));
    if (interrupt?.toolCallId !== undefined) {
        const call = events.find((event) => event.type === "TOOL_CALL_START"
            && (event as { toolCallId?: unknown }).toolCallId === interrupt.toolCallId) as { toolCallName?: string } | undefined;
        assert.equal(call?.toolCallName, op, "the call it names is the operation's");
    }
    return id;
};

test("{§agui-proposal-resolve} a child proposal traverses its owning thread without losing either identity", {
    timeout: 60_000,
}, async () => {
    await import(join(SERVICE, "test/setup.ts"));
    const [{ default: Daemon }, { makeMockResponse }] = await Promise.all([
        import(join(SERVICE, "src/server/Daemon.ts")),
        import(join(SERVICE, "test/intg/_mock.ts")),
    ]);
    const provider = new Mock({
        contextWindow: 32768,
        responses: [
            makeMockResponse(
                "````WORK (worker://guesser1)\nCreate child.txt and conclude.\n````\n"
                + "````WAIT\nWaiting for guesser1.\n````",
                10,
            ),
            makeMockResponse(
                "````EDIT (child.txt)\ncreated by child\n````\n"
                + "````NOTE\nConfirming the write.\n````",
                10,
            ),
            makeMockResponse("````SEND [200]\nChild work complete.\n````", 10),
            makeMockResponse("````SEND [200]\nDelegated work confirmed.\n````", 10),
        ],
    });
    const db = await openTestDatabase();
    const root = await mkdtemp(join(tmpdir(), "plurnk-descendant-proposal-"));
    const http = await bindListener();
    const daemon = new Daemon({
        db,
        provider,
        nodeModulesPath: join(SERVICE, "node_modules"),
        http,
    });
    await daemon.start();

    try {
        const port = http.httpAddress().port;
        const first = await post(port, {
            threadId: "delegated-proposal",
            messages: [{ id: "message-1", role: "user", content: "Delegate this task." }],
            forwardedProps: {
                plurnk: {
                    workspace: "delegated-proposal",
                    projectRoot: root,
                    maxTurns: 6,
                },
            },
        });
        const childInterrupt = interruptedBy(first, "EDIT");

        const final = await post(port, {
            threadId: "delegated-proposal",
            forwardedProps: { plurnk: { workspace: "delegated-proposal" } },
            resume: [{
                interruptId: childInterrupt,
                status: "resolved",
                payload: { decision: "accept" },
            }],
        });
        const terminal = final.at(-1) as {
            type?: string;
            outcome?: { type?: string };
        } | undefined;
        assert.equal(terminal?.type, "RUN_FINISHED");
        assert.equal(terminal?.outcome?.type, "success");
        assert.equal(provider.remaining, 0, "parent, child, and resumed parent each generated once");
        assert.equal(
            await readFile(join(root, "child.txt"), "utf8"),
            "created by child",
            "resolving the parent-delivered gate applies the exact child's proposed effect",
        );
    } finally {
        await daemon.stop();
        await http.close();
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
