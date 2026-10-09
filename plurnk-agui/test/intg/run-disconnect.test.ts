import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import type { ApplicationLoopProjection, ApplicationPort, OperationResult } from "@plurnk/plurnk-contracts";
import type { AguiEvent } from "../../src/types.ts";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

const frames = (body: string): AguiEvent[] => body.split("\n\n")
    .filter((frame) => frame.startsWith("data: ")).map((frame) => JSON.parse(frame.slice(6)) as AguiEvent);

for (const kind of ["conversation", "action"] as const) {
    test(`{§agui-run-disconnect}: a resumed ${kind} disconnect reaps its actual executor`, { timeout: 30_000 }, async (t) => {
        await import(join(SERVICE, "test/setup.ts"));
        const [{ default: Daemon }, { makeMockResponse }, { waitForDb }] = await Promise.all([
            import(join(SERVICE, "src/server/Daemon.ts")), import(join(SERVICE, "test/intg/_mock.ts")),
            import(join(SERVICE, "test/intg/_rpc.ts")),
        ]);
        const command = "printf ready; sleep 60";
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
            threadId: "disconnect", messages: [], tools: [{ name: "request_approval", description: "Review", parameters: { type: "object" } }],
            state: {}, context: [], forwardedProps: { plurnk: { workspace: "disconnect", projectRoot: null } },
        };
        const post = (extra: Record<string, unknown>, signal: AbortSignal) => fetch(`http://127.0.0.1:${http.httpAddress().port}/agui`, {
            method: "POST", headers: { "content-type": "application/json" }, signal,
            body: JSON.stringify({ ...input, runId: crypto.randomUUID(), ...extra }),
        });
        try {
            await daemon.start();
            const initial = frames(await (await post(kind === "action" ? {
                forwardedProps: { plurnk: { ...input.forwardedProps.plurnk, action: { kind: "op.exec", command } } },
            } : { messages: [{ id: "start", role: "user", content: "Run the command and wait." }] }, t.signal)).text());
            const terminal = initial.at(-1);
            assert.ok(terminal?.type === "RUN_FINISHED" && terminal.outcome?.type === "interrupt");
            const [workspace] = await daemon.listWorkspaces();
            const [proposal] = await daemon.pendingProposals(workspace.id);
            assert.ok(proposal, "normal interrupt closure leaves the operation pending");
            const response = await post({ resume: [{ interruptId: terminal.outcome.interrupts[0]!.id,
                status: "resolved", payload: { decision: "accept" } }] }, AbortSignal.any([controller.signal, t.signal]));
            const body = assert.rejects(response.text(), { name: "AbortError" });
            await ready.promise;
            controller.abort();
            await body;
            const stream = await concluded.promise;
            assert.equal(stream.workerId, proposal.workerId, "the original operation worker is cancelled, not a guessed conversation worker");
            assert.equal(stream.result.status, 499, "the executor is reaped rather than detached");
            if (kind === "conversation") {
                const loops: ApplicationLoopProjection[] = await waitForDb(() => application.listWorkerLoops({ workspaceId: workspace.id, workerId: proposal.workerId }),
                    (rows: ApplicationLoopProjection[]) => rows.some((row) => row.terminalResult !== null));
                const result = loops.find((loop) => loop.id === proposal.loopId)?.terminalResult;
                assert.equal(result?.status, 499);
                assert.equal(result?.problem?.reason, "client_disconnected");
            }
        } finally {
            controller.abort();
            off();
            await daemon.stop();
            await http.close();
            await db.close();
        }
    });
}
