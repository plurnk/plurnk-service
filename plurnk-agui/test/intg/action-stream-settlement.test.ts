// {§agui-broadcast-fan} An operation Run owns an execution from the row that announces it. A
// client command that writes late still concludes inside the Run that launched it, so a bridge
// client receives the conclusion before the action result, never a result for a command whose
// output is still to come. The real daemon executes the command; nothing is simulated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import type { AguiEvent } from "../../src/types.ts";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

const post = async (port: number, input: Readonly<Record<string, unknown>>): Promise<AguiEvent[]> => {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: crypto.randomUUID(), state: {}, messages: [], tools: [], context: [], ...input }),
    });
    assert.equal(response.status, 200);
    return (await response.text())
        .split("\n\n")
        .filter((frame) => frame.startsWith("data: "))
        .map((frame) => JSON.parse(frame.slice(6)) as AguiEvent);
};

const label = (event: AguiEvent): string => event.type === "CUSTOM" ? (event as { name: string }).name : event.type;

test("{§agui-broadcast-fan} a client command that writes late concludes inside its operation Run", { timeout: 60_000 }, async () => {
    await import(join(SERVICE, "test/setup.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));
    const db = await openTestDatabase();
    const root = await mkdtemp(join(tmpdir(), "plurnk-action-stream-"));
    const http = await bindListener();
    const daemon = new Daemon({ db, provider: new Mock({ contextWindow: 32768, responses: [] }), nodeModulesPath: join(SERVICE, "node_modules"), http });
    await daemon.start();
    try {
        const port = http.httpAddress().port;
        const workspace = { workspace: "action-stream", projectRoot: root };
        // A host command proposes; the Run terminates at the gate like any client op.
        const proposed = await post(port, {
            threadId: "action-stream",
            forwardedProps: { plurnk: { ...workspace, action: { kind: "op.exec", command: "sleep 1; printf late" } } },
        });
        const gate = proposed.at(-1) as { type?: string; outcome?: { type?: string; interrupts?: Array<{ interruptId?: string; id?: string }> } };
        assert.equal(gate.type, "RUN_FINISHED");
        assert.equal(gate.outcome?.type, "interrupt", JSON.stringify(proposed));
        const interrupt = gate.outcome?.interrupts?.[0];
        const interruptId = interrupt?.interruptId ?? interrupt?.id;
        assert.equal(typeof interruptId, "string");

        const resumed = await post(port, {
            threadId: "action-stream",
            forwardedProps: { plurnk: workspace },
            resume: [{ interruptId, status: "resolved", payload: { decision: "accept", outcome: "auto: sh" } }],
        });
        const order = resumed.map(label);
        const started = resumed.find((e) => label(e) === "plurnk.row"
            && typeof (e as { value?: { attrs?: { stream?: unknown } } }).value?.attrs?.stream === "string") as { value: { attrs: { stream: string }; rx: { outcome?: string } } } | undefined;
        assert.ok(started !== undefined, `the started row rides the resumed Run: ${order.join(" → ")}`);
        assert.equal(started.value.rx.outcome, "auto: sh", "the durable proposal result retains the client's resolution reason");
        const conclusion = resumed.findIndex((e) => label(e) === "plurnk.stream"
            && typeof (e as { value?: { result?: { status?: unknown } } }).value?.result?.status === "number");
        assert.notEqual(conclusion, -1, `the conclusion rides the Run that launched the command: ${order.join(" → ")}`);
        const result = order.indexOf("plurnk.action.result");
        assert.ok(conclusion < result && result < order.lastIndexOf("RUN_FINISHED"), `conclusion, then result, then finish: ${order.join(" → ")}`);
        const concluded = resumed[conclusion] as { value: { target: string; result: { status: number; exitCode?: number } } };
        assert.equal(concluded.value.result.status, 200);
        assert.equal(concluded.value.target, started.value.attrs.stream, "the conclusion names the address the row announced");
        assert.equal((resumed.at(-1) as { outcome?: { type?: string } }).outcome?.type, "success");
    } finally {
        await daemon.stop();
        await http.close();
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
