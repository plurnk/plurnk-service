// {§agui-run-source} The client has an address. A run's user message is the causal actor
// behind the loop's message, and the module names it under the AG-UI principal the way the
// A2A adapter names its messages ({§message-causal-source}); the arrival row the model reads
// carries that source, so an operator's message is told from a worker's by address (#706).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import type { ApplicationPort } from "@plurnk/plurnk-contracts";
import Module from "../../src/Module.ts";
import type { AguiEvent } from "../../src/types.ts";
import { openTestDatabase, SERVICE } from "./_helpers.ts";

const post = async (port: number, input: Readonly<Record<string, unknown>>): Promise<AguiEvent[]> => {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: {}, messages: [], tools: [], context: [], ...input }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return text
        .split("\n\n")
        .filter((frame) => frame.startsWith("data: "))
        .map((frame) => JSON.parse(frame.slice(6)) as AguiEvent);
};

test("a client run's arrival row names its AG-UI message as the causal source", { timeout: 60_000 }, async () => {
    await import(join(SERVICE, "test/setup.ts"));
    const [{ default: Daemon }, { makeMockResponse }] = await Promise.all([
        import(join(SERVICE, "src/server/Daemon.ts")),
        import(join(SERVICE, "test/intg/_rpc.ts")),
    ]);
    const provider = new Mock({
        contextWindow: 32768,
        responses: [makeMockResponse("```SEND\nNamed.\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 10)],
    });
    const db = await openTestDatabase();
    const root = await mkdtemp(join(tmpdir(), "plurnk-run-source-"));
    const daemon = new Daemon({ db, provider, nodeModulesPath: join(SERVICE, "node_modules") });
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
        const events = await post(port, {
            threadId: "run-source",
            runId: "run-1",
            messages: [{ id: "message 1", role: "user", content: "Name your sender." }],
            forwardedProps: { plurnk: { workspace: "run-source", projectRoot: root, policy: { proposals: "accept" }, maxTurns: 3 } },
        });
        const terminal = events.at(-1) as { type?: string; outcome?: { type?: string } } | undefined;
        assert.equal(terminal?.type, "RUN_FINISHED");
        assert.equal(terminal?.outcome?.type, "success");

        const expected = "agui://anonymous/threads/run-source/runs/run-1/messages/message%201";
        const loops = (await db.test_all_loops.all()) as Array<{ id: number }>;
        const prompts = (await Promise.all(loops.map(async ({ id }) => {
            const rows = (await db.test_log_entries_by_loop.all({ loop_id: id })) as Array<{ op: string; origin: string; source: string | null; attrs: string }>;
            return rows.filter((row) => row.op === "SEND" && row.origin === "_plurnk").map((row) => ({ ...row, loopId: id }));
        }))).flat();
        assert.equal(prompts.length, 1, "the run published exactly one arrival row");
        const [prompt] = prompts;
        assert.equal(prompt!.origin, "_plurnk", "the harness published the row");
        assert.equal(prompt!.source, expected, "the row's causal actor is the AG-UI message, URI-encoded per segment");

        const turns = (await db.test_list_turns_in_loop.all({ loop_id: prompt!.loopId })) as Array<{ packet: string | null }>;
        const logSections = turns.flatMap(({ packet }) => packet === null ? [] : (JSON.parse(packet) as {
            sections?: Array<{ name: string; content: string }>;
        }).sections?.filter((section) => section.name === "log") ?? []);
        assert.ok(
            logSections.some(({ content }) => content.includes(`"source":"${expected}"`)),
            "the packet renders the source on the arrival row, so the model reads the sender by address",
        );
        const promptSections = turns.flatMap(({ packet }) => packet === null ? [] : (JSON.parse(packet) as {
            sections?: Array<{ name: string; content: string }>;
        }).sections?.filter((section) => section.name === "messages") ?? []);
        assert.ok(
            promptSections.some(({ content }) => /^\[\{"path":"log:\/\/\/1\/\d+\/1\/SEND","source":"agui:\/\/anonymous\/threads\/run-source\/runs\/run-1\/messages\/message%201"\}\]$/.test(content)),
            "the Open Messages pointer carries the same source beside the row's coordinate",
        );
        assert.ok(
            !logSections.some(({ content }) => /### log:\/\/\/\d+\/\d+\/\d+\/SEND\n\{[^\n]*"origin":"_plurnk"/.test(content)),
            "the arrival row carries no constant origin",
        );
    } finally {
        await daemon.stop();
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
