// {§worker-tool-admission} — the question runtime is an ordinary interaction-
// trait capability: one worker policy shapes both its documentation and its
// dispatch admission through the same resolver.

import test from "node:test";
import assert from "node:assert/strict";
import type { CapabilityPolicy, FindStatement, ExecStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import QuestionTool, { questionRuntimeDecl } from "../../src/schemes/QuestionTool.ts";
import LoopDocs from "../../src/server/loopDocs.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, DEFAULT_MIMETYPES } from "./_helpers.ts";

const findStatement = (): FindStatement => ({
    metadata: null,
    op: "FIND", delimiter: "", annotation: null, signal: ["+init", "+plurnk"],
    target: {
        kind: "url", raw: "worker://~/_plurnk/plurnk/*.md", scheme: "worker",
        username: null, password: null, hostname: "~", port: null,
        pathname: "/_plurnk/plurnk/*.md", query: null, fragment: null,
    },
    body: null,
    lineMarker: { marks: [1, -1] }, position: { line: 1, column: 1 },
});

const execStatement = (): ExecStatement => ({
    metadata: null,
    op: "EXEC", annotation: null, delimiter: "", signal: "question",
    target: null, lineMarker: null,
    body: JSON.stringify({ message: "Which branch?", requestedSchema: { type: "object" } }),
    position: { line: 1, column: 1 },
});

const boot = async (capabilities: CapabilityPolicy = {}) => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
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
    const workspaceId = await insertWorkspace(db, `tool-admission-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    await db.worker_settings_update.run({
        id: workerId,
        settings: JSON.stringify({ capabilities }),
    });
    await LoopDocs.materialize(engine, db, workspaceId, workerId);
    const loopId = await insertLoop(db, workerId, 2, "admission");
    const turnId = await insertTurn(db, loopId, 1, 102);
    return { db, schemes, engine, workspaceId, workerId, loopId, turnId };
};

test("{§worker-tool-admission}: an interaction-denied worker's FIND omits the question tool", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await boot({ deny: [{ traits: ["interaction"] }] });
    try {
        const found = await engine.dispatch({
            statement: findStatement(),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(found.status, 200);
        const names = (found.results as Array<Array<{ path: string }>>).map((group) => group[0]?.path ?? "");
        assert.ok(!names.some((path) => path.includes("question.md")), "the question doc does not exist for the non-interactive worker");
        assert.ok(!String(found.content ?? "").includes("question.md"), "the rendered catalog agrees with the location list");
    } finally {
        await db.close();
    }
});

test("{§worker-tool-admission}: an unrestricted worker's FIND lists the question tool", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await boot();
    try {
        const found = await engine.dispatch({
            statement: findStatement(),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(found.status, 200);
        const names = (found.results as Array<Array<{ path: string }>>).map((group) => group[0]?.path ?? "");
        assert.ok(names.some((path) => path.includes("question.md")), "the interactive worker sees the question tool");
    } finally {
        await db.close();
    }
});

test("{§worker-tool-admission}: EXEC dispatch refuses an interaction-denied question runtime", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await boot({ deny: [{ traits: ["interaction"] }] });
    try {
        const result = await engine.dispatch({
            statement: execStatement(),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 403);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/capability-denied");
        assert.equal(result.problem?.runtime, "question");
        assert.deepEqual(result.problem?.traits, ["interaction"]);
        assert.equal(result.problem?.policyScope, "worker");
    } finally {
        await db.close();
    }
});

test("{§worker-tool-admission}: the interaction access class gates known interactive runtimes", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await boot({ deny: [{ access: "interact" }] });
    try {
        const result = await engine.dispatch({
            statement: execStatement(),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 403);
        assert.equal(result.problem?.access, "interact");
        assert.equal(result.problem?.runtime, "question");
        assert.equal(result.problem?.policyScope, "worker");
    } finally {
        await db.close();
    }
});
