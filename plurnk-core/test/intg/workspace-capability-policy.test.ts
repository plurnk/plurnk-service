// {§capability-policy-cascade} — the workspace layer uses the same selectors
// as every other layer and shapes both operation admission and generated tool
// references. There is no executor-specific policy channel.

import test from "node:test";
import assert from "node:assert/strict";
import type { CapabilityPolicy, ExecStatement } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import LoopDocs from "../../src/server/loopDocs.ts";
import WorkerName from "../../src/core/WorkerName.ts";
import { copyStmt, editStmt, killStmt, moveStmt, readStmt, dispositionStmt, urlPath } from "./_dsl.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, insertOperationTurn, testExecutors, DEFAULT_MIMETYPES } from "./_helpers.ts";

const execStmt = (runtime: string): ExecStatement => ({
    metadata: null,
    op: "EXEC",
    annotation: null,
    executor: runtime, target: null,
    lineMarker: null,
    body: "echo hi",
    position: { line: 1, column: 1 },
});

const runWithPolicy = async (capabilities: CapabilityPolicy, runtime: string) => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `workspace-policy-${crypto.randomUUID()}`);
        await db.test_set_workspace_settings.run({
            id: workspaceId,
            settings: JSON.stringify({ capabilities }),
        });
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "policy");
        const turnId = await insertTurn(db, loopId, 1, 102);
        return await engine.dispatch({
            statement: execStmt(runtime),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });
    } finally { await db.close(); }
};

test("{§capability-policy-cascade}: a workspace runtime denial refuses EXEC before executor resolution", async () => {
    const result = await runWithPolicy({ deny: [{ runtime: "sh" }] }, "sh");
    assert.equal(result.status, 403);
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/capability-denied");
    assert.equal(result.problem?.runtime, "sh");
    assert.equal(result.problem?.policyScope, "workspace");
    assert.equal(result.problem?.retryable, false);
    assert.equal(result.problem?.recovery, undefined);
});

test("{§capability-policy-cascade}: workspace only makes every omitted runtime unavailable", async () => {
    const result = await runWithPolicy({ only: [{ runtime: "jq" }] }, "sh");
    assert.equal(result.status, 403);
    assert.equal(result.problem?.runtime, "sh");
    assert.equal(result.problem?.policyScope, "workspace");
});

test("{§capability-policy-cascade}: one effective workspace policy filters executable references", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `workspace-policy-render-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const before = await engine.referenceEntries(workspaceId, workerId);
        assert.ok(before.some((doc) => doc.pathname === "/_plurnk/plurnk/node.md"));

        await db.test_set_workspace_settings.run({
            id: workspaceId,
            settings: JSON.stringify({ capabilities: { deny: [{ runtime: "node" }] } }),
        });
        const after = await engine.referenceEntries(workspaceId, workerId);
        assert.ok(!after.some((doc) => doc.pathname === "/_plurnk/plurnk/node.md"));
        assert.ok(after.some((doc) => doc.pathname === "/_plurnk/plurnk/sh.md"));

        const loopId = await insertLoop(db, workerId, 1, "policy teaching");
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [{ assistant: { content: "", reasoning: null, ops: [dispositionStmt("DONE")] } }],
        });
        const { turnId } = await engine.runTurn({
            provider,
            workspaceId,
            workerId,
            loopId,
            messages: [
                { role: "system", content: "definition" },
                { role: "user", content: "inspect the tools" },
            ],
        });
        const stored = await db.test_get_packet.get<{ packet: string }>({ id: turnId });
        assert.ok(stored !== undefined);
        const packet = JSON.parse(stored.packet) as { sections: Array<{ name: string }> };
        assert.equal(packet.sections.some(({ name }) => name === "tools"), false);
    } finally { await db.close(); }
});

test("{§capability-admission}: harness-authored initialization obeys the same loop capability policy", async () => {
    const previousFilesItems = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `loop-policy-init-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "finish without external capabilities");
        await db.engine_set_loop_policy.run({
            loop_id: loopId,
            policy: JSON.stringify({
                capabilities: {
                    deny: [
                        { operation: "COPY" },
                        { operation: "FIND" },
                        { operation: "READ" },
                    ],
                },
                proposals: "accept",
            }),
        });
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [{ assistant: { content: "", reasoning: null, ops: [dispositionStmt("DONE")] } }],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            workerId,
            loopId,
            messages: [
                { role: "system", content: "definition" },
                { role: "user", content: "finish" },
            ],
        });
        assert.equal(result.status, 200);
        const rows = await db.test_log_entries_by_loop.all<{ origin: string; op: string | null }>({ loop_id: loopId });
        const harnessOps = rows.filter(({ origin }) => origin === "_plurnk").map(({ op }) => op);
        assert.equal(harnessOps.includes("PLAN"), false);
        assert.equal(harnessOps.includes("NEXT"), true);
        assert.deepEqual(
            harnessOps.filter((op) => op === "COPY" || op === "FIND" || op === "READ"),
            [],
            "the harness neither advertises nor exercises capabilities denied to this loop",
        );
    } finally {
        await db.close();
        if (previousFilesItems === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
        else process.env.PLURNK_SERVICE_FILES_ITEMS = previousFilesItems;
    }
});

test("{§capability-admission}: Turn 0 catalogs only capabilities admitted by this loop", async () => {
    const previousFilesItems = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `loop-policy-catalog-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        await LoopDocs.materialize(engine, db, workspaceId, workerId);
        const loopId = await insertLoop(db, workerId, 2, "inspect the admitted catalog");
        await db.engine_set_loop_policy.run({
            loop_id: loopId,
            policy: JSON.stringify({
                capabilities: { deny: [{ runtime: "node" }] },
                proposals: "accept",
            }),
        });
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [{ assistant: { content: "", reasoning: null, ops: [dispositionStmt("DONE")] } }],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            workerId,
            loopId,
            messages: [
                { role: "system", content: "definition" },
                { role: "user", content: "finish" },
            ],
        });
        assert.equal(result.status, 200);
        const rows = await db.test_log_entries_by_loop.all<{
            op: string | null;
            pathname: string | null;
            rx: string;
        }>({ loop_id: loopId });
        const survey = rows.find(({ op, pathname }) =>
            op === "FIND" && pathname?.startsWith("/_plurnk/plurnk/") === true);
        assert.ok(survey !== undefined, "the admitted reference catalog remains available");
        const resultBody = JSON.parse(survey.rx) as { content?: string; results?: unknown[] };
        const items = (resultBody.results
            ?? (resultBody.content === undefined ? [] : JSON.parse(resultBody.content) as unknown[])) as Array<Array<{ path: string }>>;
        const paths = items.flat().map(({ path }) => path);
        assert.equal(paths.some((path) => path.endsWith("/node.md")), false, "a denied runtime is not taught");
        assert.equal(paths.some((path) => path.endsWith("/sh.md")), true, "an admitted peer remains taught");
    } finally {
        await db.close();
        if (previousFilesItems === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
        else process.env.PLURNK_SERVICE_FILES_ITEMS = previousFilesItems;
    }
});

for (const layer of ["service", "workspace", "worker-bound", "worker", "loop"] as const) test(`{§schemes-directory}: ${layer} read-only policy preserves discoverable, readable worker reference`, async (t) => {
    const previousFilesItems = process.env.PLURNK_SERVICE_FILES_ITEMS;
    const previousCapabilities = process.env.PLURNK_SERVICE_CAPABILITIES;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    t.after(() => {
        if (previousFilesItems === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
        else process.env.PLURNK_SERVICE_FILES_ITEMS = previousFilesItems;
        if (previousCapabilities === undefined) delete process.env.PLURNK_SERVICE_CAPABILITIES;
        else process.env.PLURNK_SERVICE_CAPABILITIES = previousCapabilities;
    });
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const workspaceId = await insertWorkspace(db, `reference-read-only-${layer}`);
        const capabilities: CapabilityPolicy = { only: [{ access: "observe" }] };
        const { id: workerId } = await WorkerName.claimAuto(db, {
            workspaceId, prefix: "reference", origin: "model",
            capabilityBound: layer === "worker-bound" ? capabilities : {},
        });
        if (layer === "service") process.env.PLURNK_SERVICE_CAPABILITIES = JSON.stringify(capabilities);
        if (layer === "workspace") await db.test_set_workspace_settings.run({
            id: workspaceId, settings: JSON.stringify({ capabilities }),
        });
        if (layer === "worker") await db.worker_settings_update.get({
            id: workerId, settings: JSON.stringify({ capabilities }),
        });
        await LoopDocs.materialize(engine, db, workspaceId, workerId);
        const loopId = await insertLoop(db, workerId, 2, "Read the worker reference.");
        if (layer === "loop") await db.engine_set_loop_policy.run({
            loop_id: loopId, policy: JSON.stringify({ capabilities, proposals: "accept" }),
        });
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: "", reasoning: null, ops: [
                readStmt({ ...urlPath("worker", "/_plurnk/plurnk/worker.md"), hostname: "~", raw: "worker://~/_plurnk/plurnk/worker.md" }, { marks: [1, -1] }),
                dispositionStmt("NEXT"),
            ] } },
        ] });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const rows = await db.test_log_entries_by_loop.all<{
            op: string; pathname: string; rx: string; status_rx: number;
        }>({ loop_id: loopId });
        const survey = rows.find(({ op, pathname }) => op === "FIND" && pathname.startsWith("/_plurnk/plurnk/"));
        assert.ok(survey, "read-only policy retains the native reference survey");
        const result = JSON.parse(survey.rx) as { content: string };
        const items = JSON.parse(result.content) as Array<Array<{ path: string; summary?: string }>>;
        const reference = items.flat().find(({ path }) => path.endsWith("/worker.md"));
        assert.ok(reference?.summary, `worker orientation is not hidden by its mutation examples: ${JSON.stringify(items)}`);
        const read = rows.find(({ op }) => op === "READ");
        assert.equal(read?.status_rx, 200, "the model can read the advertised reference through normal dispatch");
        assert.ok(JSON.parse(read!.rx).content.includes("## Lifecycle"));
    } finally { await db.close(); }
});

test("{§worker-generated-subtree}: runtime maintenance preserves external policy and writer boundaries", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const workspaceId = await insertWorkspace(db, "generated-state-policy");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "inspect references");
        const target = (path: string) => ({ ...urlPath("worker", path), hostname: "~", raw: `worker://~${path}` });
        const generated = target("/_plurnk/test.md");
        const external = target("/notes.md");
        let sequence = 0;
        const dispatch = async (statement: Parameters<Engine["dispatch"]>[0]["statement"], origin: Parameters<Engine["dispatch"]>[0]["origin"] = "_plurnk") => {
            const turnSequence = ++sequence;
            const turnId = origin === "model"
                ? await insertTurn(db, loopId, turnSequence, 102)
                : await insertOperationTurn(db, loopId, turnSequence, origin, 102);
            return engine.dispatch({ statement, workspaceId, workerId, loopId, turnId, sequence: 1, origin });
        };
        const policy = (capabilities: CapabilityPolicy) => db.test_set_workspace_settings.run({
            id: workspaceId, settings: JSON.stringify({ capabilities }),
        });
        await policy({ only: [{ access: "observe" }] });
        assert.equal((await dispatch(editStmt(generated, "reference"))).status, 201);
        assert.equal((await dispatch(editStmt(generated, "updated reference", { marks: [1, -1] }))).status, 200);
        assert.equal((await dispatch(readStmt(generated))).status, 200);
        for (const origin of ["model", "client", "plugin"] as const) {
            assert.equal((await dispatch(editStmt(generated, "overwrite"), origin)).status, 403, origin);
        }
        for (const operation of [editStmt(external, "outside"), copyStmt(generated, external), moveStmt(generated, external)]) {
            const result = await dispatch(operation);
            assert.equal(result.status, 403);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/capability-denied");
        }
        const copy = target("/_plurnk/copied.md");
        assert.equal((await dispatch(copyStmt(generated, copy))).status, 201, "only the admitted source observation remains an external demand");
        assert.equal((await dispatch(killStmt(copy))).status, 200);
        assert.equal((await dispatch(killStmt(generated))).status, 200);
        await policy({});
        assert.equal((await dispatch(editStmt(external, "source"))).status, 201);
        for (const origin of ["model", "client"] as const) {
            const result = await dispatch(editStmt(generated, "overwrite"), origin);
            assert.equal(result.status, 403);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/worker/worker-generated-read-only");
        }
        await policy({ only: [{ access: "mutate" }] });
        const deniedCopy = await dispatch(copyStmt(external, generated));
        assert.equal(deniedCopy.status, 403, "an intrinsic destination does not authorize its source read");
        assert.equal(deniedCopy.problem?.access, "observe");
        await policy({ only: [] });
        assert.equal((await dispatch(editStmt(generated, "owned state"))).status, 201);
        assert.equal((await dispatch(readStmt(generated))).status, 403, "runtime reads still use the worker policy");
    } finally { await db.close(); }
});

test("{§schemes-self-doc-materialization}: read-only reconciliation records creation, replacement, and removal", async () => {
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        let documentation = "# Reference\n\n## Summary\n\nFirst revision.";
        schemes.register("readable", {
            get manifest() {
                return {
                    name: "readable", category: "data", entryOwner: "worker", inherit: "none",
                    channels: { body: "text/plain" }, defaultChannel: "body",
                    writableBy: [], modelVisible: true, volatile: false, documentation,
                };
            },
        });
        const engine = new Engine({ db, schemes });
        const workspaceId = await insertWorkspace(db, "read-only-reconciliation");
        const workerId = await insertWorker(db, workspaceId);
        const policy = (deny: CapabilityPolicy["deny"] = []) => db.test_set_workspace_settings.run({
            id: workspaceId, settings: JSON.stringify({ capabilities: { only: [{ access: "observe" }], deny } }),
        });
        await policy();
        const current = async () => (await db.loop_docs_materialized.all<{ pathname: string; content: string }>({
            workspace_id: workspaceId, owner_id: workerId,
        })).find(({ pathname }) => pathname === "/_plurnk/plurnk/readable.md");
        await LoopDocs.materialize(engine, db, workspaceId, workerId);
        assert.equal((await current())?.content, documentation);
        documentation = "# Reference\n\n## Summary\n\nSecond revision.";
        await LoopDocs.materialize(engine, db, workspaceId, workerId);
        assert.equal((await current())?.content, documentation);
        await policy([{ scheme: "readable" }]);
        await LoopDocs.materialize(engine, db, workspaceId, workerId);
        assert.equal(await current(), undefined);
        const rows = await db.test_log_entries_by_worker.all<{
            op: string; pathname: string; origin: string; status_rx: number; turn_id: number;
        }>({ worker_id: workerId });
        const changes = rows.filter(({ pathname, op }) => pathname === "/_plurnk/plurnk/readable.md" && ["EDIT", "KILL"].includes(op));
        assert.deepEqual(changes.map(({ op, origin, status_rx }) => [op, origin, status_rx]), [
            ["EDIT", "_plurnk", 201], ["EDIT", "_plurnk", 200], ["KILL", "_plurnk", 200],
        ]);
        for (const { turn_id } of changes) {
            const turn = await db.test_get_turn.get<{ producer: string; kind: string; status: number }>({ id: turn_id });
            assert.equal(turn?.producer, "_plurnk");
            assert.equal(turn?.kind, "maintenance");
            assert.equal(turn?.status, 200);
        }
    } finally { await db.close(); }
});
