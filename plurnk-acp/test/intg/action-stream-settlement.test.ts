// {§acp-broadcast-fan} An operation Run owns an execution from the row that announces it. A
// client command that writes late still concludes inside the Run that launched it, so the
// client receives the conclusion before the action result, never a result for a command whose
// output is still to come. The real daemon executes the command; nothing is simulated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import type { AcpEvent } from "../../src/types.ts";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

const post = async (port: number, input: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<AcpEvent[]> => {
    const response = await fetch(`http://127.0.0.1:${port}/acp`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: crypto.randomUUID(), state: {}, messages: [], tools: [], context: [], ...input }),
    });
    assert.equal(response.status, 200);
    return (await response.text())
        .split("\n\n")
        .filter((frame) => frame.startsWith("data: "))
        .map((frame) => JSON.parse(frame.slice(6)) as AcpEvent);
};

const label = (event: AcpEvent): string => event.type === "CUSTOM" ? (event as { name: string }).name : event.type;

test("{§acp-broadcast-fan} a client command that writes late concludes inside its operation Run", { timeout: 60_000 }, async (t) => {
    await import(join(SERVICE, "test/setup.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));
    const db = await openTestDatabase();
    const root = await mkdtemp(join(tmpdir(), "plurnk-action-stream-"));
    const http = await bindListener();
    const daemon = new Daemon({ db, provider: new Mock({ contextWindow: 32768, responses: [] }), nodeModulesPath: join(SERVICE, "node_modules"), http });
    await daemon.start();
    try {
        const events = await post(http.httpAddress().port, {
            threadId: "action-stream",
            forwardedProps: { plurnk: { workspace: "action-stream", projectRoot: root, action: { kind: "op.exec", command: "sleep 1; printf late" } } },
        }, t.signal);
        const order = events.map(label);
        const started = events.find((e) => label(e) === "plurnk.ambient"
            && typeof (e as { value?: { attrs?: { stream?: unknown } } }).value?.attrs?.stream === "string") as { value: { attrs: { stream: string } } } | undefined;
        assert.ok(started !== undefined, `the started row rides the operation's Run: ${order.join(" → ")}`);
        const conclusion = events.findIndex((e) => label(e) === "plurnk.stream"
            && typeof (e as { value?: { result?: { status?: unknown } } }).value?.result?.status === "number");
        assert.notEqual(conclusion, -1, `the conclusion rides the Run that launched the command: ${order.join(" → ")}`);
        const finished = order.lastIndexOf("RUN_FINISHED");
        assert.ok(conclusion < finished, `conclusion, then the finish that carries the result: ${order.join(" → ")}`);
        assert.equal((events[finished] as { result?: { kind?: string } } | undefined)?.result?.kind, "op.exec",
            "{§acp-plurnk-metadata} the Run finishes with the action's outcome as its result");
        const concluded = events[conclusion] as { value: { target: string; result: { status: number } } };
        assert.equal(concluded.value.result.status, 200);
        assert.equal(concluded.value.target, started.value.attrs.stream, "the conclusion names the address the row announced");
        assert.equal((events.at(-1) as { outcome?: { type?: string } }).outcome?.type, "success");
    } finally {
        await daemon.stop();
        await http.close();
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§proposal-disposition} a person's command runs at once under review", { timeout: 15_000 }, async (t) => {
    await import(join(SERVICE, "test/setup.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));
    const db = await openTestDatabase();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider: new Mock({ contextWindow: 32768, responses: [] }), nodeModulesPath: join(SERVICE, "node_modules"), http });
    try {
        await daemon.start();
        const events = await post(http.httpAddress().port, {
            threadId: "own-command",
            forwardedProps: { plurnk: { workspace: "own-command", action: { kind: "op.exec", command: "printf mine" } } },
        }, t.signal);
        const result = (events.find(({ type }) => type === "RUN_FINISHED") as { result?: { ok?: boolean } } | undefined)?.result;
        assert.equal(result?.ok, true, JSON.stringify(events));
        const receipt = events.find((event) => label(event) === "plurnk.ambient") as { value?: { rx?: { outcome?: string } } } | undefined;
        assert.equal(receipt?.value?.rx?.outcome, "client_operation", "the person's own decision, never routed for review");
        const finish = events.at(-1) as { type?: string; outcome?: { type?: string } } | undefined;
        assert.equal(finish?.type, "RUN_FINISHED");
        assert.equal(finish?.outcome?.type, "success", "no interrupt: nothing waits for a decision");
        const [workspace] = await daemon.listWorkspaces();
        assert.deepEqual(await daemon.pendingProposals(workspace!.id), []);
    } finally {
        await daemon.stop();
        await http.close();
        await db.close();
    }
});
