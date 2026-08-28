// {§agui-proposal-resolve} A controlling conversation receives both its own
// gate and a descendant's later gate through the same ordinary AG-UI
// terminate/resume contract. The real daemon owns proposal identity and Worker
// topology; the module neither simulates nor flattens either one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import type { ApplicationPort } from "@plurnk/plurnk-contracts";
import Module from "../../src/Module.ts";
import type { AguiEvent } from "../../src/types.ts";
import { openTestDatabase, SERVICE } from "./_helpers.ts";

const post = async (
    port: number,
    input: Readonly<Record<string, unknown>>,
): Promise<AguiEvent[]> => {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
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
            interrupts?: Array<{ interruptId?: string; id?: string }>;
        };
    } | undefined;
    assert.equal(terminal?.type, "RUN_FINISHED");
    assert.equal(terminal?.outcome?.type, "interrupt");
    const interrupt = terminal.outcome.interrupts?.[0];
    const id = interrupt?.interruptId ?? interrupt?.id;
    if (typeof id !== "string") assert.fail("the interrupt has no string identity");
    const args = events.find((event) => event.type === "TOOL_CALL_ARGS"
        && (event as { toolCallId?: unknown }).toolCallId === id) as {
        delta?: string;
    } | undefined;
    assert.ok(args?.delta !== undefined, JSON.stringify(events));
    assert.equal((JSON.parse(args.delta) as { op?: unknown }).op, op);
    return id;
};

test("a child proposal traverses its controlling conversation without losing either identity", {
    timeout: 60_000,
}, async () => {
    await import(join(SERVICE, "test/setup.ts"));
    const [{ default: Daemon }, { makeMockResponse }] = await Promise.all([
        import(join(SERVICE, "src/server/Daemon.ts")),
        import(join(SERVICE, "test/intg/_rpc.ts")),
    ]);
    const provider = new Mock({
        contextWindow: 32768,
        responses: [
            makeMockResponse(
                "## WORK0 (worker://guesser1)\nCreate child.txt and conclude.\n\n"
                + "## SEND0 [202] <-1>\nWaiting for guesser1.",
                10,
            ),
            makeMockResponse(
                "## EDIT0 (child.txt)\ncreated by child\n\n"
                + "## SEND0 [102]\nConfirming the write.",
                10,
            ),
            makeMockResponse("## SEND0 [200]\nChild work complete.", 10),
            makeMockResponse("## SEND0 [200]\nDelegated work confirmed.", 10),
        ],
    });
    const db = await openTestDatabase();
    const root = await mkdtemp(join(tmpdir(), "plurnk-descendant-proposal-"));
    const daemon = new Daemon({
        db,
        provider,
        nodeModulesPath: join(SERVICE, "node_modules"),
    });
    let module: Module | null = null;
    const registration = Module.init({ host: "127.0.0.1", port: 0 });
    daemon.registerModule({
        start: async (seam: ApplicationPort) => {
            module = await registration.start(seam);
            return module;
        },
    });
    await daemon.start({ host: "127.0.0.1", port: 0 });

    try {
        const port = (module as unknown as Module).address().port;
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
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
