// {§question-tool} — the assembled proof: EXEC[question] through the real
// Exec scheme pauses on the shared client-interaction lifecycle and resumes
// with the standard ElicitResult in its results channel.

import test from "node:test";
import assert from "node:assert/strict";
import type { ExecStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Exec from "../../src/schemes/Exec.ts";
import QuestionTool, { questionRuntimeDecl } from "../../src/schemes/QuestionTool.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { makeMockResponse, waitForDb, withDaemon } from "./_rpc.ts";
import { localPath } from "./_dsl.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn } from "./_helpers.ts";

const execStmt = (body: string): ExecStatement => ({
    metadata: null,
    op: "EXEC", executor: "question", annotation: null, target: null, lineMarker: null, body, position: { line: 1, column: 1 },
});

for (const target of [null, "question", "user"]) test(`{§question-tool}: dispatched question accepts target ${target} and returns the answer`, async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const exec = schemes.get("exec") as Exec;
    const engine = new Engine({ db, schemes });
    engine.setExecutors(await ExecutorRegistry.build({ defaultRuntime: "sh", cwd: process.cwd() }));
    engine.registerRuntimes([{
        tag: "question",
        entry: {
            executor: new QuestionTool({ runtime: "question", glyph: "❓" }),
            namespaceOwner: { kind: "module", name: "core" },
            glyph: "❓",
            summary: questionRuntimeDecl.summary,
            invocation: questionRuntimeDecl.invocation,
            details: questionRuntimeDecl.details ?? "",
            available: true,
            detail: "in-process",
        },
    }]);
    try {
        const workspaceId = await insertWorkspace(db, `question-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "question");
        const turnId = await insertTurn(db, loopId, 1, 102);

        let logEntryId = -1;
        const dispatched = engine.dispatch({
            statement: { ...execStmt(JSON.stringify({
                message: "Which branch?",
                requestedSchema: { type: "object", properties: { branch: { type: "string", enum: ["main", "feat/x"] } }, required: ["branch"] },
            })), target: target === null ? null : localPath(target) },
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => { logEntryId = id; },
        });

        const pending = await (async () => {
            for (let i = 0; i < 100; i++) {
                const list = await engine.pendingClientInteractions(workspaceId);
                if (list.length > 0) return list[0];
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            return undefined;
        })();
        assert.ok(pending !== undefined, "the question produced one durable pending interaction");
        assert.equal(pending.request.toolName, "question");
        assert.equal(pending.request.message, "Which branch?");

        await engine.resolveClientInteraction(pending.interactionId, {
            status: "resolved",
            payload: { action: "accept", content: { branch: "main" } },
        });
        const result = await dispatched;
        await exec.idle();
        assert.equal(result.status, 200);

        const log = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
        const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
        const entry = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "question", pathname });
        assert.ok(entry, "the question output entry is addressed under the runtime tag");
        const results = await db.test_get_channel.get<{ content: string; state: string }>({ entry_id: entry.id, name: "results" });
        assert.equal(results?.state, "closed");
        assert.deepEqual(JSON.parse(results?.content ?? "null"), { action: "accept", content: { branch: "main" } });
    } finally {
        await exec.idle();
        await db.close();
    }
});

for (const timing of ["before park", "after park"] as const) {
    for (const action of ["accept", "cancel"] as const) {
        test(`{§question-tool}: ${action} ${timing} resumes the same WAIT loop`, async () => {
            const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
            process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = timing === "before park" ? "1000" : "0";
            const body = JSON.stringify({ message: "Which branch?", requestedSchema: {
                type: "object", properties: { branch: { type: "string" }, notes: { type: "string" } },
            } });
            const provider = new Mock({ contextWindow: 100_000, responses: [
                makeMockResponse(`\`\`\`question
${body}
\`\`\`
\`\`\`WAIT
Waiting for your answer.
\`\`\``),
                makeMockResponse("```DONE\nThe answer arrived.\n```"),
            ] });
            try {
                await withDaemon(provider, async (db, daemon) => {
                    const workspace = await daemon.createWorkspace({ name: `question-${timing}-${action}` });
                    const workerId = await daemon.ensureModelWorker(workspace.workspaceId);
                    const run = await daemon.runLoop({ workspaceId: workspace.workspaceId, workerId, prompt: "Ask me." });
                    const pending = await waitForDb(
                        () => daemon.pendingClientInteractions(workspace.workspaceId),
                        (rows) => rows.length === 1,
                    );
                    if (timing === "after park") await waitForDb(
                        () => db.test_get_loop_status.get<{ status: number }>({ id: run.loopId }),
                        (row) => row?.status === 202,
                    );
                    await daemon.resolveClientInteraction(pending[0]!.interactionId, action === "accept"
                        ? { status: "resolved", payload: { action, content: { branch: "main" } } }
                        : { status: "cancelled" });
                    await waitForDb(
                        () => db.test_get_loop_status.get<{ status: number }>({ id: run.loopId }),
                        (row) => row?.status === 200,
                    );
                    assert.equal(provider.remaining, 0, "exactly one continuation receives the answer");
                    const turns = await db.test_list_turns_in_loop.all<{ producer: string }>({ loop_id: run.loopId });
                    assert.equal(turns.filter(({ producer }) => producer === "model").length, 2,
                        "both model turns belong to the original loop, independently of harness observation turns");
                    assert.deepEqual(await daemon.pendingClientInteractions(workspace.workspaceId), []);
                    const rows = await db.test_log_entries_by_loop.all<{ op: string; rx: string }>({ loop_id: run.loopId });
                    const answer = rows.find((row) => row.op === "READ" && JSON.parse(row.rx).content?.includes(`"${action}"`));
                    assert.ok(answer, "the answer or cancellation is materialized in the resumed loop");
                });
            } finally {
                if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
                else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
            }
        });
    }
}

test("{§question-tool}: cancelling the worker concludes a pending question as cancellation, not an executor crash", async () => {
    const provider = new Mock({ contextWindow: 100_000, responses: [makeMockResponse(
        "```question\n{\"message\":\"Which branch?\",\"requestedSchema\":{\"type\":\"object\",\"properties\":{\"branch\":{\"type\":\"string\"}}}}\n```\n```WAIT\nAwaiting an answer.\n```",
    )] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "question-user-cancel" });
        const workerId = await daemon.ensureModelWorker(workspaceId);
        const run = await daemon.runLoop({ workspaceId, workerId, prompt: "Ask me." });
        await waitForDb(() => daemon.pendingClientInteractions(workspaceId), (rows) => rows.length === 1);
        await daemon.cancelWorker({ workspaceId, workerId, reason: "user_escape" });
        const loop = await db.test_get_loop_status.get<{ status: number }>({ id: run.loopId });
        assert.equal(loop?.status, 499);
        assert.deepEqual(await daemon.pendingClientInteractions(workspaceId), []);
        const entry = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "question", pathname: "/1/2/3/EXEC" });
        assert.ok(entry);
        const channel = await waitForDb(
            () => db.test_get_channel_terminal.get<{ producer_result: string }>({ entry_id: entry.id, name: "results" }),
            (row) => row?.producer_result != null,
        );
        const result = JSON.parse(channel?.producer_result ?? "null");
        assert.equal(result?.status, 499);
        assert.equal(result?.problem?.type, "https://problems.plurnk.xyz/scheme/exec/execution-cancelled");
    });
});

test("{§client-interactions}: KILL ends the question's own waiter without cancelling its loop", async () => {
    const provider = new Mock({ contextWindow: 100_000, responses: [
        makeMockResponse("```question\n{\"message\":\"Which branch?\",\"requestedSchema\":{\"type\":\"object\",\"properties\":{\"branch\":{\"type\":\"string\"}}}}\n```\n```NEXT\nContinue while the question is pending.\n```"),
        makeMockResponse("```KILL (question:///1/2/3/EXEC)```\n```NEXT\nCancel the question.\n```"),
        makeMockResponse("```DONE\nDone.\n```"),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "question-exec-cancel" });
        const workerId = await daemon.ensureModelWorker(workspaceId);
        const run = await daemon.runLoop({ workspaceId, workerId, prompt: "Ask, then cancel the question.", policy: { proposals: "accept" } });
        await waitForDb(() => db.test_get_loop_status.get<{ status: number }>({ id: run.loopId }), (row) => row?.status === 200, { timeoutMs: 15_000 });
        assert.equal(provider.remaining, 0);
        assert.deepEqual(await daemon.pendingClientInteractions(workspaceId), []);
        const entry = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "question", pathname: "/1/2/3/EXEC" });
        assert.ok(entry);
        const channel = await db.test_get_channel_terminal.get<{ producer_result: string }>({ entry_id: entry.id, name: "results" });
        const result = JSON.parse(channel?.producer_result ?? "null");
        assert.equal(result?.status, 499);
        assert.equal(result?.problem?.type, "https://problems.plurnk.xyz/scheme/exec/execution-cancelled");
    });
});
