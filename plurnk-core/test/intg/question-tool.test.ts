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
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, testExecutors } from "./_helpers.ts";

const execStmt = (body: string): ExecStatement => ({
    op: "EXEC", annotation: null, delimiter: "", signal: "question",
    target: null, lineMarker: null, body, position: { line: 1, column: 1 },
});

test("{§question-tool}: a dispatched question pauses on the shared lifecycle and resumes with the answer", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const exec = schemes.get("exec") as Exec;
    const engine = new Engine({ db, schemes });
    engine.setExecutors(await testExecutors());
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
        await db.worker_settings_update.run({ id: workerId, settings: JSON.stringify({ requestUserInput: true }) });
        const loopId = await insertLoop(db, workerId, 1, "question");
        const turnId = await insertTurn(db, loopId, 1, 102);

        let logEntryId = -1;
        const dispatched = engine.dispatch({
            statement: execStmt(JSON.stringify({
                message: "Which branch?",
                requestedSchema: { type: "object", properties: { branch: { type: "string", enum: ["main", "feat/x"] } }, required: ["branch"] },
            })),
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
