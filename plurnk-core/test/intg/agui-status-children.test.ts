// {§agui-status-children} — the bound Worker's alive direct children ride the status gauge as one
// integer the daemon computes: 0 in the Run's opening snapshot, 1 once the model's WORK spawned a
// child, 0 again when that child concluded. The client reads the number; it never polls the directory.
import test from "node:test";
import assert from "node:assert/strict";
import { Module as AguiModule } from "@plurnk/plurnk-agui";
import { Mock } from "@plurnk/plurnk-providers";
import Daemon from "../../src/server/Daemon.ts";
import { openMigrated } from "./_helpers.ts";
import { makeMockResponse } from "./_rpc.ts";

type Event = Readonly<Record<string, unknown>>;
type Delta = { readonly op: string; readonly path: string; readonly value: unknown };

const parseEvents = (body: string): Event[] => body
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => JSON.parse(frame.slice(6)) as Event);

test("the status gauge counts alive direct children: 0, then 1 on WORK, then 0 when the child concludes", { timeout: 30_000 }, async () => {
    const provider = new Mock({
        contextWindow: 1_000_000,
        responses: [
            makeMockResponse("```WORK (worker://counter)\nReply with the number 3.\n```\n\n```TASK <-1>\n[{\"content\":\"waiting for the child\",\"status\":\"waiting\"}]\n```"),
            makeMockResponse("```SEND\n3\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```"),
            makeMockResponse("```SEND\nthe child answered 3\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```"),
        ],
    });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider });
    const aguiRegistration = AguiModule.init({ host: "127.0.0.1", port: 0 });
    let agui: AguiModule | null = null;
    daemon.registerModule({ start: async (seam) => { agui = await aguiRegistration.start(seam); return agui; } });
    try {
        await daemon.start();
        assert.ok(agui !== null);
        const port = (agui as AguiModule).address().port;
        const workspace = `agui-children-${crypto.randomUUID()}`;
        const response = await fetch(`http://127.0.0.1:${port}/`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                threadId: workspace, runId: "spawn", state: {}, tools: [], context: [],
                messages: [{ id: "prompt", role: "user", content: "delegate the count" }],
                forwardedProps: { plurnk: { workspace, policy: { proposals: "accept" } } },
            }),
        });
        assert.equal(response.status, 200);
        const events = parseEvents(await response.text());
        assert.equal(events.at(-1)?.type, "RUN_FINISHED");
        assert.equal((events.at(-1)?.outcome as { type?: string } | undefined)?.type, "success");

        const snapshot = events.find((event) => event.type === "STATE_SNAPSHOT") as { snapshot?: { plurnk?: { status?: { children?: unknown } } } } | undefined;
        assert.equal(snapshot?.snapshot?.plurnk?.status?.children, 0, "the opening snapshot states no alive children");
        const counts = events
            .filter((event) => event.type === "STATE_DELTA")
            .flatMap((event) => (event.delta as Delta[]).filter(({ path }) => path === "/plurnk/status/children").map(({ value }) => value));
        assert.deepEqual(counts, [1, 0], "one child alive after the WORK, none once it concluded — each change published exactly once");
        const fullReplacements = events
            .filter((event) => event.type === "STATE_DELTA")
            .flatMap((event) => (event.delta as Delta[]).filter(({ path }) => path === "/plurnk/status").map(({ value }) => (value as { children?: unknown }).children));
        assert.ok(fullReplacements.every((value) => typeof value === "number"), "a whole-gauge replacement carries the count too");
    } finally {
        await daemon.stop();
        await db.close();
    }
});
