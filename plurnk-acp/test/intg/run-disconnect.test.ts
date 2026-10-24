import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import type { ApplicationLoopProjection, OperationResult } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import type { AcpEvent } from "../../src/types.ts";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

const frames = (body: string): AcpEvent[] => body.split("\n\n")
    .filter((frame) => frame.startsWith("data: ")).map((frame) => JSON.parse(frame.slice(6)) as AcpEvent);

{
    test("{§acp-run-disconnect}: a resumed message Run's disconnect leaves its executor to finish; the decision stands", { timeout: 30_000 }, async (t) => {
        await import(join(SERVICE, "test/setup.ts"));
        const [{ default: Daemon }, { makeMockResponse }, { waitForDb }] = await Promise.all([
            import(join(SERVICE, "src/server/Daemon.ts")), import(join(SERVICE, "test/intg/_mock.ts")),
            import(join(SERVICE, "test/intg/_rpc.ts")),
        ]);
        const command = "printf ready; sleep 1; printf done";
        const provider = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse(`\`\`\`sh\n${command}\n\`\`\``), makeMockResponse("```WAIT\n```"),
        ] });
        const db = await openTestDatabase();
        const http = await bindListener();
        const daemon = new Daemon({ db, http, provider, nodeModulesPath: join(SERVICE, "node_modules") });
        const application: ApplicationPort = daemon;
        const ready = Promise.withResolvers<void>();
        const concluded = Promise.withResolvers<{ workerId: number; result: OperationResult }>();
        const controller = new AbortController();
        const off = application.subscribeToEvents((_workspace, method, params) => {
            if (method === "stream/event" && (params as { contentLength: number }).contentLength > 0) ready.resolve();
            if (method === "stream/concluded") concluded.resolve(params as { workerId: number; result: OperationResult });
        });
        const input = {
            threadId: "disconnect", messages: [], tools: [],
            state: {}, context: [], forwardedProps: { plurnk: { workspace: "disconnect", projectRoot: null } },
        };
        const post = (extra: Record<string, unknown>, signal: AbortSignal) => fetch(`http://127.0.0.1:${http.httpAddress().port}/acp`, {
            method: "POST", headers: { "content-type": "application/json" }, signal,
            body: JSON.stringify({ ...input, runId: crypto.randomUUID(), ...extra }),
        });
        try {
            await daemon.start();
            const initial = frames(await (await post({ messages: [{ id: "start", role: "user", content: "Run the command and wait." }] }, t.signal)).text());
            const terminal = initial.at(-1);
            assert.ok(terminal?.type === "RUN_FINISHED" && terminal.outcome?.type === "interrupt");
            const [workspace] = await daemon.listWorkspaces();
            const [proposal] = await daemon.pendingProposals(workspace.id);
            assert.ok(proposal, "normal interrupt closure leaves the operation pending");
            const response = await post({ resume: [{ interruptId: terminal.outcome.interrupts[0].id,
                status: "resolved", payload: { decision: "accept" } }] }, AbortSignal.any([controller.signal, t.signal]));
            const body = assert.rejects(response.text(), { name: "AbortError" });
            await ready.promise;
            controller.abort();
            await body;
            const stream = await concluded.promise;
            assert.equal(stream.workerId, proposal.workerId, "the accepted operation's own worker finishes it");
            assert.equal(stream.result.status, 200, "the executor runs to its own end rather than being reaped");
            assert.deepEqual(await daemon.pendingProposals(workspace.id), [], "the accepted decision stands");
            const loops: ApplicationLoopProjection[] = await waitForDb(() => application.listWorkerLoops({ workspaceId: workspace.id, workerId: proposal.workerId }),
                (rows: ApplicationLoopProjection[]) => rows.some((row) => row.id === proposal.loopId));
            const result = loops.find((loop) => loop.id === proposal.loopId)?.terminalResult;
            assert.notEqual(result?.status, 499, "nothing cancelled the loop");
            assert.notEqual(result?.problem?.reason, "client_disconnected");
        } finally {
            controller.abort();
            off();
            await daemon.stop();
            await http.close();
            await db.close();
        }
    });
}

test("{§acp-run-disconnect} {§connection-lifecycle}: an operation Run's disconnect leaves the command it started running, like every other", { timeout: 30_000 }, async (t) => {
    await import(join(SERVICE, "test/setup.ts"));
    const [{ default: Daemon }, { waitForDb }] = await Promise.all([
        import(join(SERVICE, "src/server/Daemon.ts")), import(join(SERVICE, "test/intg/_rpc.ts")),
    ]);
    const db = await openTestDatabase();
    const http = await bindListener();
    const daemon = new Daemon({ db, http, provider: new Mock({ contextWindow: 32768, responses: [] }), nodeModulesPath: join(SERVICE, "node_modules") });
    const application: ApplicationPort = daemon;
    // The stream address each operation's row announced, which of them have written, and how each concluded.
    const announced: string[] = [];
    const writing = new Set<string>();
    const concluded = new Map<string, OperationResult>();
    const off = application.subscribeToEvents((_workspace, method, params) => {
        if (method === "log/entry") {
            const stream = (params as { entry: { attrs?: { stream?: unknown } | null } }).entry.attrs?.stream;
            if (typeof stream === "string" && !announced.includes(stream)) announced.push(stream);
        }
        if (method === "stream/event" && (params as { contentLength: number }).contentLength > 0) writing.add((params as { target: string }).target);
        if (method === "stream/concluded") concluded.set((params as { target: string }).target, (params as { result: OperationResult }).result);
    });
    const mine = new AbortController();
    const theirs = new AbortController();
    const exec = (threadId: string, signal: AbortSignal) => fetch(`http://127.0.0.1:${http.httpAddress().port}/acp`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.any([signal, t.signal]),
        body: JSON.stringify({ threadId, runId: crypto.randomUUID(), messages: [], tools: [], state: {}, context: [],
            forwardedProps: { plurnk: { workspace: "disconnect", projectRoot: null, action: { kind: "op.exec", command: "printf ready; sleep 1; printf done" } } } }),
    });
    try {
        await daemon.start();
        const mineBody = assert.rejects((await exec("mine", mine.signal)).text(), { name: "AbortError" });
        await waitForDb(async () => announced.filter((stream) => writing.has(stream)).length, (count: number) => count === 1);
        const myCommand = announced[0];
        const theirBody = assert.rejects((await exec("theirs", theirs.signal)).text(), { name: "AbortError" });
        await waitForDb(async () => announced.filter((stream) => writing.has(stream)).length, (count: number) => count === 2);
        const theirCommand = announced[1];

        mine.abort();
        await mineBody;
        const finished: OperationResult = await waitForDb(async () => concluded.get(myCommand), (result: OperationResult | undefined) => result !== undefined);
        assert.equal(finished.status, 200, "the command ran to its own end after its connection closed");
        theirs.abort();
        await theirBody;
        const other: OperationResult = await waitForDb(async () => concluded.get(theirCommand), (result: OperationResult | undefined) => result !== undefined);
        assert.equal(other.status, 200, "and so did the other operation's");
    } finally {
        mine.abort();
        theirs.abort();
        off();
        await daemon.stop();
        await http.close();
        await db.close();
    }
});
