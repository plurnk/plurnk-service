// {§worker-tool-admission} {§owner-interaction-ring} — the question runtime is an ordinary
// interaction-trait capability: the workspace policy and the asking worker's owner shape both
// its documentation and its dispatch through the same resolver.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import type { CapabilityPolicy, FindStatement, ExecStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import CapabilityResolver from "../../src/core/CapabilityResolver.ts";
import QuestionTool, { questionRuntimeDecl } from "../../src/schemes/QuestionTool.ts";
import LoopDocs from "../../src/server/loopDocs.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn } from "./_db.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { ownWorker } from "./_approval.ts";

const findStatement = (): FindStatement => ({
    metadata: null,
    op: "FIND", aside: null,
    target: {
        kind: "url", raw: "worker:///_plurnk/plurnk/*.md", scheme: "worker",
        username: null, password: null, hostname: null, port: null,
        pathname: "/_plurnk/plurnk/*.md", query: null, fragment: null,
    },
    matcher: null, body: null,
    lineMarker: { marks: [1, -1] }, position: { line: 1, column: 1 },
});

const execStatement = (): ExecStatement => ({
    metadata: null,
    runtime: "question", aside: null, target: null, lineMarker: null,
    body: JSON.stringify({ message: "Which branch?", requestedSchema: { type: "object" } }),
    position: { line: 1, column: 1 },
});

const boot = async (capabilities: CapabilityPolicy = {}) => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    engine.setExecutors(await ExecutorRegistry.build({ cwd: process.cwd() }));
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
    await db.test_set_workspace_settings.run({
        id: workspaceId,
        settings: JSON.stringify({ capabilities }),
    });
    await LoopDocs.materialize(engine, db, workspaceId);
    const loopId = await insertLoop(db, workerId, 2, "admission");
    const turnId = await insertTurn(db, loopId, 1, 102);
    const dispatch = { workspaceId, workerId, loopId, turnId, origin: "model" as const };
    // What the worker's FIND of the reserved reference set shows: its paths and its rendered catalog.
    const catalog = async () => {
        const found = await engine.dispatch({ ...dispatch, sequence: 1, statement: findStatement() });
        assert.equal(found.status, 200);
        const paths = (found.results as Array<Array<{ path: string }>>).map((group) => group[0]?.path ?? "");
        return { paths, content: String(found.content ?? "") };
    };
    return { db, schemes, engine, workspaceId, workerId, dispatch, catalog };
};

test("{§worker-tool-admission}: an interaction-denied workspace omits the question tool even for an interactive owner", async () => {
    const { db, workspaceId, workerId, catalog } = await boot({ deny: [{ traits: ["interaction"] }] });
    try {
        await ownWorker(db, workspaceId, workerId);
        const { paths, content } = await catalog();
        assert.ok(!paths.some((path) => path.includes("question.md")), "the question doc does not exist for the workspace");
        assert.ok(!content.includes("question.md"), "the rendered catalog agrees with the location list");
    } finally {
        await db.close();
    }
});

test("{§owner-interaction-ring}: a worker whose interactive owner declares question sees the tool", async () => {
    const { db, workspaceId, workerId, catalog } = await boot();
    try {
        await ownWorker(db, workspaceId, workerId);
        const { paths } = await catalog();
        assert.ok(paths.some((path) => path.endsWith("/question.md")), "the interactive worker sees the question tool");
    } finally {
        await db.close();
    }
});

for (const [label, owner] of [
    ["the runtime owner", null],
    ["an owner nobody attends", { tools: ["request_approval", "question"], interactive: false }],
    ["an attended owner that does not declare question", { tools: ["request_approval"], interactive: true }],
] as const) test(`{§owner-interaction-ring}: a worker owned by ${label} neither sees nor dispatches question`, async () => {
    const { db, engine, workspaceId, workerId, dispatch, catalog } = await boot();
    try {
        if (owner !== null) await ownWorker(db, workspaceId, workerId, [...owner.tools], owner.interactive);
        const { paths, content } = await catalog();
        assert.ok(paths.some((path) => path.endsWith("/sh.md")), "noninteractive tools remain discoverable");
        assert.ok(!paths.some((path) => path.endsWith("/question.md")), "the shared reference set hides the tool from this worker");
        assert.ok(!content.includes("question.md"), "the rendered catalog agrees with the location list");
        const result = await engine.dispatch({ ...dispatch, sequence: 2, statement: execStatement() });
        assert.equal(result.status, 403);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/capability-denied");
        assert.equal(result.problem?.runtime, "question");
        assert.equal(result.problem?.access, "interact");
        assert.equal(result.problem?.policyScope, "owner");
        assert.equal(result.problem?.recovery, CapabilityResolver.UNATTENDED_RECOVERY);
    } finally {
        await db.close();
    }
});

test("{§pinned-wording-core}: the owner ring's refusal says why the tool is gone and what to do instead", () => {
    assert.equal(CapabilityResolver.UNATTENDED_RECOVERY,
        "Nobody is present to answer. Decide from what you already have, or conclude stating what you could not resolve.");
});

test("{§worker-tool-admission}: execution dispatch refuses an interaction-denied question runtime", async () => {
    const { db, engine, workspaceId, workerId, dispatch } = await boot({ deny: [{ traits: ["interaction"] }] });
    try {
        await ownWorker(db, workspaceId, workerId);
        const result = await engine.dispatch({ ...dispatch, sequence: 1, statement: execStatement() });
        assert.equal(result.status, 403);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/capability-denied");
        assert.equal(result.problem?.runtime, "question");
        assert.deepEqual(result.problem?.traits, ["interaction"]);
        assert.equal(result.problem?.policyScope, "workspace");
        assert.equal(result.problem?.recovery, undefined, "operator configuration speaks for itself");
    } finally {
        await db.close();
    }
});

test("{§worker-tool-admission}: the interaction access class gates known interactive runtimes", async () => {
    const { db, engine, workspaceId, workerId, dispatch } = await boot({ deny: [{ access: "interact" }] });
    try {
        await ownWorker(db, workspaceId, workerId);
        const result = await engine.dispatch({ ...dispatch, sequence: 1, statement: execStatement() });
        assert.equal(result.status, 403);
        assert.equal(result.problem?.access, "interact");
        assert.equal(result.problem?.runtime, "question");
        assert.equal(result.problem?.policyScope, "workspace");
    } finally {
        await db.close();
    }
});

test("{§question-tool}: neither the shipped defaults nor the real-model profile switch question off", () => {
    for (const path of ["../../../plurnk-execs/.env.defaults", "../../.env.test"]) {
        const profile = parseEnv(readFileSync(new URL(path, import.meta.url), "utf8"));
        assert.equal(profile.PLURNK_EXECS_QUESTION, undefined, `${path} leaves the tool to the owner ring`);
    }
});

test("{§question-tool}: the executor switch removes question and its teaching", async () => {
    const previous = process.env.PLURNK_EXECS_QUESTION;
    process.env.PLURNK_EXECS_QUESTION = "0";
    try {
        const { db, engine, schemes, workspaceId, workerId, dispatch, catalog } = await boot();
        try {
            await ownWorker(db, workspaceId, workerId);
            assert.equal(schemes.has("question", workerId), false);
            const { paths } = await catalog();
            assert.ok(paths.some((path) => path.endsWith("/sh.md")), "noninteractive tools remain discoverable");
            assert.ok(!paths.some((path) => path.endsWith("/question.md")));
            const result = await engine.dispatch({ ...dispatch, sequence: 2, statement: execStatement() });
            assert.equal(result.status, 400);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/exec/executor-not-registered");
            assert.equal(result.problem?.requestedRuntime, "question");
        } finally {
            await db.close();
        }
    } finally {
        if (previous === undefined) delete process.env.PLURNK_EXECS_QUESTION;
        else process.env.PLURNK_EXECS_QUESTION = previous;
    }
});
