// {§methods-invocation} {§worker-obligations} — a row that discharges an obligation names the operation that opened it,
// so a client pairs the answer with its call without matching addresses.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { AiSdkProvider } from "@plurnk/plurnk-providers";
import type { ApplicationLoopProjection, LogEntryWire } from "@plurnk/plurnk-contracts";
import type Daemon from "../../src/server/Daemon.ts";
import type { Db } from "../../src/core/Db.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { serverProposals } from "./_approval.ts";
import { waitForDb, withDaemon } from "./_rpc.ts";
import { namedModelWorker } from "./_workers.ts";

const streamed = (content: string): Response => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
        const frame = { id: "invocation", model: "invocation-witness", choices: [{ index: 0, delta: { content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`));
        controller.close();
    },
}), { headers: { "content-type": "text/event-stream" } });

// One loop of `main` against a scripted model whose calls the WAITs serialize; each named worker's log after it, in order,
// and its loops.
const run = async (
    t: TestContext,
    script: readonly string[],
    peers: readonly string[],
    check: (
        logs: (name: string) => Promise<LogEntryWire[]>,
        announced: readonly LogEntryWire[],
        worker: (name: string) => Promise<{ id: number; loops: readonly ApplicationLoopProjection[] }>,
    ) => Promise<void>,
): Promise<void> => {
    serverProposals(t, "accept");
    let calls = 0;
    const provider = new AiSdkProvider({
        model: "invocation-witness", url: "https://example.test/v1/chat/completions",
        contextWindow: 100_000, streaming: true, fetchTimeoutMs: 5000, operationTimeoutMs: 5000,
        temperature: null, repeatPenalty: null, effort: { mode: "adaptive", budget: null }, retryAttempts: 0,
        fetch: async () => streamed(script[Math.min(calls++, script.length - 1)]!),
    });
    await withDaemon(provider, async (db: Db, daemon: Daemon) => {
        const announced: LogEntryWire[] = [];
        daemon.subscribeToEvents((_workspaceId, method, params) => {
            if (method === "log/entry") announced.push((params as { entry: LogEntryWire }).entry);
        });
        const { workspaceId } = await daemon.createWorkspace({ name: `invocation-${crypto.randomUUID()}` });
        const workerId = await namedModelWorker(daemon, workspaceId, "main");
        for (const peer of peers) await namedModelWorker(daemon, workspaceId, peer);
        const { loopId } = await daemon.runLoop({ workspaceId, workerId, prompt: "Begin." });
        const status = await waitForDb(() => new LoopLifecycle(db).status(loopId), (value) => value === 200 || value >= 400);
        assert.equal(status, 200, "main concludes");
        const named = async (name: string): Promise<number> => {
            const worker = (await daemon.listWorkers(workspaceId)).find((candidate) => candidate.name === name);
            assert.ok(worker, `${name} exists`);
            return worker.id;
        };
        await check(
            async (name) => (await daemon.readLog({ workspaceId, workerId: await named(name), limit: 1000 })).toSorted((left, right) => left.id - right.id),
            announced,
            async (name) => {
                const id = await named(name);
                return { id, loops: await daemon.listWorkerLoops({ workspaceId, workerId: id }) };
            },
        );
    });
};

const address = (row: LogEntryWire): string => `log:///${row.loop_seq}/${row.turn_seq}/${row.sequence}/${row.op}`;
const attrs = (row: LogEntryWire): Record<string, unknown> => row.attrs as Record<string, unknown>;

test("{§methods-invocation} a stream's observation names its execution, and a FORK's copy names the same one", async (t) => {
    await run(t, [
        "````sh\nprintf 'hello\\n'\n````\n````WAIT\n````",
        "````FORK (worker://branch)\nConfirm the greeting.\n````\n````WAIT\n````",
        "````SEND [200]\nConfirmed.\n````",
        "````SEND [200]\nDone.\n````",
    ], [], async (logs, announced) => {
        const main = await logs("main");
        const execution = main.find(({ op }) => op === "sh")!;
        const observation = main.find(({ invocation }) => invocation === address(execution));
        assert.equal((observation?.rx as { content?: unknown } | undefined)?.content, "hello\n", "the observation names the execution that opened its stream");
        assert.equal(observation?.source, null, "the observation's attribution is unchanged");
        assert.equal(announced.find(({ id }) => id === observation!.id)?.invocation, observation!.invocation, "log/entry carries it as readLog does");
        const copy = (await logs("branch")).find((row) =>
            row.origin === "_plurnk" && row.loop_seq === observation!.loop_seq && row.turn_seq === observation!.turn_seq && row.sequence === observation!.sequence);
        assert.equal(copy?.invocation, observation!.invocation, "the branch's copy names the execution at the same coordinate");
    });
});

test("{§methods-invocation} {§worker-obligations} a delegation is answered by its child's conclusion, and a message by its completion reply", async (t) => {
    await run(t, [
        "````WORK (worker://helper)\nSay hello.\n````\n````WAIT\n````",
        "````SEND [200]\nhello from the helper\n````",
        "````SEND (worker://peer)\nWhat is the answer?\n````\n````WAIT\n````",
        "````SEND [200]\nforty-two\n````",
        "````SEND [200]\nThe helper said hello; the answer is forty-two.\n````",
    ], ["peer"], async (logs, _announced, worker) => {
        const main = await logs("main");
        const work = main.find(({ op }) => op === "WORK")!;
        const send = main.find(({ op, attrs: opened }) => op === "SEND" && typeof (opened as { message?: unknown }).message === "string")!;
        assert.match(String(attrs(work).message), /^message:\/\/helper\//u, "the WORK names the message it sent");
        assert.match(String(attrs(send).message), /^message:\/\/peer\//u, "the SEND names the message it sent");
        const answers = main.filter(({ invocation }) => invocation !== undefined).map(({ invocation, op, source, attrs: kind }) =>
            ({ invocation, op, source, kind: (kind as { kind?: unknown }).kind }));
        assert.deepEqual(answers, [
            { invocation: address(work), op: "READ", source: "worker://helper", kind: "loop_termination" },
            { invocation: address(send), op: "SEND", source: "worker://peer", kind: "reply" },
        ], "the child's conclusion answers the WORK and the peer's completion answers the SEND, each once");
        const wait = main.find(({ op, sequence, turn_seq }) => op === "WAIT" && turn_seq === send.turn_seq && sequence > send.sequence);
        assert.equal(wait?.status_rx, 202, "the open message held its sender, so the WAIT parked until the reply");
        const peer = await logs("peer");
        assert.equal(peer.find(({ op, origin }) => op === "SEND" && origin === "_plurnk")?.source, "worker://main", "the message names its sender");
        // {§methods-worker-loops} A loop names the operation that opened it; a person's prompt is no worker's operation.
        const sender = await worker("main");
        assert.deepEqual((await worker("helper")).loops.map(({ invocation }) => invocation), [{ workerId: sender.id, address: address(work) }],
            "the child's loop was opened by the WORK");
        assert.deepEqual((await worker("peer")).loops.map(({ invocation }) => invocation), [{ workerId: sender.id, address: address(send) }],
            "the peer's loop was opened by the SEND");
        assert.deepEqual(sender.loops.map(({ invocation }) => invocation), [null], "main's loop was opened by a person's prompt");
    });
});
