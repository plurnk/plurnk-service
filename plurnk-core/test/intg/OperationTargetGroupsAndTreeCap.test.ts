import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import LogEntryProjection from "../../src/core/LogEntryProjection.ts";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import AdministrativeLoop from "../../src/core/AdministrativeLoop.ts";
import RuntimeSession from "../../src/core/RuntimeSession.ts";
import Envelope from "../../src/server/envelope.ts";
import { serverProposals } from "./_approval.ts";
import { insertWorkspace, openMigrated, insertLoop, insertTurn, insertSession, seedEntryWithChannel } from "./_db.ts";
import { Mock, type MockResponse, type ProviderAlias } from "@plurnk/plurnk-providers";
import { makeMockResponse } from "./_mock.ts";
import { connect, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";
import { type Db } from "../../src/core/Db.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";

describe("Engine.operation-target-groups", () => {
const response = (content: string): MockResponse => ({
    assistant: { content, reasoning: null },
});

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `target-groups-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "exercise target groups");
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    return { db, workspaceId, sessionId, loopId, engine };
};

const seedLogRead = async (
    db: Db,
    sessionId: number,
    loopId: number,
    turnId: number,
    sequence: number,
): Promise<number> => {
    const row = await db.engine_insert_log_entry.get<{ id: number }>({
        session_id: sessionId,
        loop_id: loopId,
        turn_id: turnId,
        sequence,
        origin: "model",
        source: null,
        model_call_id: null,
        op: "read",
        scheme: "workspace",
        username: null,
        password: null,
        hostname: null,
        port: null,
        pathname: `/source-${sequence}.md`,
        query: null,
        fragment: null,
        lineMarker: null,
        tx: `await plurnk.read({"path":"workspace:///source-${sequence}.md"});`,
        mimetype_tx: "text/vnd.plurnk",
        rx: JSON.stringify({
            status: 200,
            content: `line from source ${sequence}`,
            mimetype: "text/plain",
            startLine: 1,
        }),
        mimetype_rx: "application/json",
        status_rx: 200,
        weight: 1,
        state: "resolved",
        outcome: null,
        attrs: "{}",
    });
    if (row === undefined) throw new Error("READ fixture insert returned no row");
    return row.id;
};

test("{§slot-order}: one admitted READ dispatches every explicit URI member", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        await seedEntryWithChannel(db, {
            workspaceId,
            pathname: "/alpha.md",
            content: "alpha",
        });
        await seedEntryWithChannel(db, {
            workspaceId,
            pathname: "/beta.md",
            content: "beta",
        });
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [response("await plurnk.read({\"path\":\"workspace:///alpha.md\"});\n\nawait plurnk.read({\"path\":\"workspace:///beta.md\"});\n\nawait plurnk.note({\"text\":\"Both reads are pending review.\"});")],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "Read both resources." }],
        });
        const rows = await db.test_log_entries_by_turn.all<{
            op: string | null;
            attrs: string;
            pathname: string | null;
            status_rx: number;
        }>({ turn_id: result.turnId });

        assert.deepEqual(
            rows
                .filter((row) => row.op === "read" && !LogEntryProjection.isEmission(row))
                .map(({ pathname, status_rx }) => ({ pathname, status: status_rx })),
            [
                { pathname: "/alpha.md", status: 200 },
                { pathname: "/beta.md", status: 200 },
            ],
        );
    } finally {
        await db.close();
    }
});

test("{§slot-order}: one admitted scoped KILL curates every explicit URI member", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const sourceTurnId = await insertTurn(db, loopId, 1);
        const firstId = await seedLogRead(db, sessionId, loopId, sourceTurnId, 1);
        const secondId = await seedLogRead(db, sessionId, loopId, sourceTurnId, 2);
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [response("await plurnk.kill({\"path\":\"log:///1/1/1/read\",\"range\":\"1,-1\"});\n\nawait plurnk.kill({\"path\":\"log:///1/1/2/read\",\"range\":\"1,-1\"});\n\nawait plurnk.note({\"text\":\"Both read bodies are suppressed.\"});")],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "Curate both reads." }],
        });
        const rendered = await db.engine_render_log.all<{ id: number; folded: string }>({
            session_id: sessionId,
        });
        const foldedById = new Map(rendered.map(({ id, folded }) => [id, folded]));
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null }>({
            turn_id: result.turnId,
        });

        assert.equal(foldedById.get(firstId), "[[1,-1]]");
        assert.equal(foldedById.get(secondId), "[[1,-1]]");
        assert.equal(rows.filter(({ op }) => op === "kill").length, 2);
    } finally {
        await db.close();
    }
});

test("{§slot-order}: one admitted KILL dispatches every explicit URI member independently", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const sourceTurnId = await insertTurn(db, loopId, 1);
        const firstId = await seedLogRead(db, sessionId, loopId, sourceTurnId, 1);
        const secondId = await seedLogRead(db, sessionId, loopId, sourceTurnId, 2);
        const source = "await plurnk.kill({\"path\":\"log:///1/1/99/read\"});\n\nawait plurnk.kill({\"path\":\"log:///1/1/1/read\"});\n\nawait plurnk.kill({\"path\":\"log:///1/1/2/read\"});\n\nawait plurnk.note({\"text\":\"Review the independent KILL outcomes.\"});";
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [response(source)],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "Retire the selected history." }],
        });
        const rows = await db.test_log_entries_by_turn.all<{
            id: number;
            op: string | null;
            pathname: string | null;
            status_rx: number;
            attrs: string;
            rx: string;
        }>({ turn_id: result.turnId });
        const kills = rows.filter(({ op }) => op === "kill");
        assert.deepEqual(
            kills.map(({ pathname, status_rx }) => ({ pathname, status: status_rx })),
            [
                { pathname: "/1/1/99/read", status: 404 },
                { pathname: "/1/1/1/read", status: 200 },
                { pathname: "/1/1/2/read", status: 200 },
            ],
            "one failed member does not hide either later successful KILL",
        );

        const sources = await db.test_log_entries_by_turn.all<{ id: number; active: number }>({
            turn_id: sourceTurnId,
        });
        assert.deepEqual(
            sources.map(({ id, active }) => ({ id, active })),
            [
                { id: firstId, active: 0 },
                { id: secondId, active: 0 },
            ],
            "both durable source events leave only the active projection",
        );

        const effects = (await db.test_log_curation_effects_by_session.all<{
            operation_log_entry_id: number;
            target_log_entry_id: number;
            active_before: number;
            active_after: number;
            op: string;
        }>({ session_id: sessionId })).filter(({ op }) => op === "kill");
        assert.deepEqual(
            effects.map(({ operation_log_entry_id, target_log_entry_id, active_before, active_after }) => ({
                operation_log_entry_id,
                target_log_entry_id,
                active_before,
                active_after,
            })),
            [
                { operation_log_entry_id: kills[1].id, target_log_entry_id: firstId, active_before: 1, active_after: 0 },
                { operation_log_entry_id: kills[2].id, target_log_entry_id: secondId, active_before: 1, active_after: 0 },
            ],
            "each successful member owns its exact append-only curation effect",
        );

        const programs = await db.test_turn_sources.all<{ kind: string; content: string }>({ session_id: sessionId });
        assert.ok(programs.some((row) => row.kind === "ops" && row.content === source), "the authored grouped program remains exact and unexpanded");
    } finally {
        await db.close();
    }
});

test("{§slot-order} {§slot-order}: a KILL written one path per slot curates every member, the scope binding to its slot; the program stays as authored", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const sourceTurnId = await insertTurn(db, loopId, 1);
        const firstId = await seedLogRead(db, sessionId, loopId, sourceTurnId, 1);
        const secondId = await seedLogRead(db, sessionId, loopId, sourceTurnId, 2);
        const heading = 'await plurnk.kill({"paths":["log:///1/1/1/read",{"path":"log:///1/1/2/read","range":"1,-1"}]});';
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [response(`${heading}

await plurnk.note({"text":"The first is retired, the second trimmed."});`)],
        });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "user", content: "Curate both reads." }] });
        const rows = await db.test_log_entries_by_loop.all<{ id: number; op: string | null; turn_id: number; status_rx: number; folded: string; active: number }>({ loop_id: loopId });
        const byId = new Map(rows.map((row) => [row.id, row]));
        assert.equal(byId.get(firstId)?.active, 0, "an unscoped member retires its row whole");
        assert.equal(byId.get(secondId)?.active, 1);
        assert.equal(byId.get(secondId)?.folded, "[[1,-1]]", "the scope binds to the slot it follows");
        assert.deepEqual(rows.filter((row) => row.turn_id === result.turnId && row.op === "kill").map(({ status_rx }) => status_rx), [200, 200], "one row per member");
        const programs = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
        const ops = programs.find(({ turn_id, kind }) => turn_id === result.turnId && kind === "ops");
        assert.ok(ops !== undefined && ops.content.includes(heading), "the stored program is the authored group, unexpanded");
    } finally {
        await db.close();
    }
});

test("{§slot-order} {§slot-order}: a READ written one path per slot lands one row per member", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        await seedEntryWithChannel(db, { workspaceId, pathname: "/alpha.md", content: "alpha" });
        await seedEntryWithChannel(db, { workspaceId, pathname: "/beta.md", content: "beta" });
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [response("await plurnk.read({\"path\":\"workspace:///alpha.md\"});\n\nawait plurnk.read({\"path\":\"workspace:///beta.md\"});\n\nawait plurnk.note({\"text\":\"Both reads are pending review.\"});")],
        });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "user", content: "Read both resources." }] });
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; attrs: string; pathname: string | null; status_rx: number }>({ turn_id: result.turnId });
        assert.deepEqual(
            rows.filter((row) => row.op === "read" && !LogEntryProjection.isEmission(row)).map(({ pathname, status_rx }) => ({ pathname, status: status_rx })),
            [{ pathname: "/alpha.md", status: 200 }, { pathname: "/beta.md", status: 200 }],
        );
    } finally {
        await db.close();
    }
});

test("{§slot-order}: READ keeps each scope while applying the heading matcher to every member", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const content = "outside\nlocal\nshared\nlocal\nshared\noutside";
        await seedEntryWithChannel(db, { workspaceId, pathname: "/alpha.md", content });
        await seedEntryWithChannel(db, { workspaceId, pathname: "/beta.md", content });
        const source = "await plurnk.read({\"path\":\"workspace:///alpha.md\",\"range\":\"2,3\",\"pattern\":\"/shared/\"});\n\nawait plurnk.read({\"path\":\"workspace:///beta.md\",\"range\":\"4,5\",\"pattern\":\"/shared/\"});";
        const provider = new Mock({ contextWindow: 100_000, responses: [response(source)] });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "user", content: "Read the selected lines." }] });
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; attrs: string; pathname: string; rx: string; status_rx: number }>({ turn_id: result.turnId });
        const reads = rows.filter((row) => row.op === "read" && !LogEntryProjection.isEmission(row));
        assert.deepEqual(reads.map(({ pathname, status_rx, rx }) => [pathname, status_rx, JSON.parse(rx).content]),
            [["/alpha.md", 200, "shared"], ["/beta.md", 200, "shared"]]);
        assert.deepEqual(reads.map(({ rx }) => JSON.parse(rx).lineOrdinals), [[3], [5]]);
    } finally { await db.close(); }
});

test("{§parse-recovery}: an ambiguous grouped KILL changes no member, while its sibling NOTE still executes", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const sourceTurnId = await insertTurn(db, loopId, 1);
        const ids = [await seedLogRead(db, sessionId, loopId, sourceTurnId, 1), await seedLogRead(db, sessionId, loopId, sourceTurnId, 2)];
        const source = 'await plurnk.kill({"paths":["log:///1/1/1/read","log:///1/1/2/read"],"pattern":"/source/","range":"<x>"});\n\nawait plurnk.note({"text":"sibling retained"});';
        const provider = new Mock({ contextWindow: 100_000, responses: [response(source)] });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "user", content: "Curate selected lines." }] });
        const originals = await db.test_log_entries_by_turn.all<{ id: number; active: number; folded: string }>({ turn_id: sourceTurnId });
        assert.deepEqual(originals.filter(({ id }) => ids.includes(id)).map(({ id, active, folded }) => [id, active, folded]),
            ids.map((id) => [id, 1, "[]"]));
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; status_rx: number; rx: string }>({ turn_id: result.turnId });
        assert.equal(rows.some(({ op }) => op === "kill"), false);
        assert.ok(rows.some(({ op, status_rx }) => op === "note" && status_rx === 200));
        assert.ok(rows.some(({ status_rx, rx }) => status_rx >= 400 && rx.includes("invalid scope")));
    } finally { await db.close(); }
});

for (const limit of [0, 1, 2]) {
    test(`{§operator-config-workspace-settings} {§slot-order}: limit ${limit} counts compiled targets, not headings`, async () => {
        const original = process.env.PLURNK_SERVICE_MAX_COMMANDS;
        process.env.PLURNK_SERVICE_MAX_COMMANDS = limit === 0 ? "-1" : String(limit);
        const { db, workspaceId, sessionId, loopId, engine } = await setup();
        try {
            if (limit === 0) await db.test_set_workspace_settings.run({ id: workspaceId, settings: JSON.stringify({ maxCommands: 0 }) });
            await seedEntryWithChannel(db, { workspaceId, pathname: "/alpha.md", content: "alpha" });
            await seedEntryWithChannel(db, { workspaceId, pathname: "/beta.md", content: "beta" });
            const source = "await plurnk.read({\"path\":\"workspace:///alpha.md\"});\n\nawait plurnk.read({\"path\":\"workspace:///beta.md\"});\n\nawait plurnk.note({\"text\":\"after the group\"});\n\nawait plurnk.done({});\n\nawait plurnk.wait({});";
            const provider = new Mock({ contextWindow: 100_000, responses: [response(source)] });
            const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "user", content: "Read both resources." }] });
            const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; attrs: string; pathname: string; rx: string; status_rx: number }>({ turn_id: result.turnId });
            const reads = rows.filter((row) => row.op === "read" && !LogEntryProjection.isEmission(row));
            assert.deepEqual(reads.map(({ pathname, status_rx }) => [pathname, status_rx]),
                [["/alpha.md", 200], ["/beta.md", 200]].slice(0, limit));
            assert.equal(rows.some(({ op }) => op === "note"), false);
            assert.equal(rows.some(({ op, origin }) => origin === "model" && op === "send"), false, "reply delivery counts as an operation");
            assert.ok(rows.some(({ op }) => op === "wait"), "the yield remains outside the action cap");
            const error = rows.map(({ rx }) => JSON.parse(rx)).find((rx) => rx.problem?.type.endsWith("max-commands-exceeded"));
            assert.ok(error !== undefined, "omitted operations have the ordinary durable limit notice");
            assert.equal(error.problem.omittedOperations, 4 - limit);
            assert.notEqual(result.status, 200, "dropped work cannot be reported as completed");
        } finally {
            await db.close();
            if (original === undefined) delete process.env.PLURNK_SERVICE_MAX_COMMANDS;
            else process.env.PLURNK_SERVICE_MAX_COMMANDS = original;
        }
    });
}
});

describe("Engine.tree-cap", () => {
// {§operator-config-workspace-settings} — the ceiling is the session tree's budget of model calls: BARE
// calls and a child's turns spend it, and a batch stops opening calls at the ceiling.
const declaredProviderEnv = new Map<string, string | undefined>();
test.afterEach(() => {
    for (const [key, value] of declaredProviderEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    declaredProviderEnv.clear();
});
const declaredProvider = (name: string, model: string): ProviderAlias => {
    const spec = { alias: `${name}-${crypto.randomUUID()}`, provider: "openai", model };
    const key = `PLURNK_MODEL_${spec.alias}`;
    declaredProviderEnv.set(key, process.env[key]);
    process.env[key] = `${spec.provider}/${spec.model}`;
    return spec;
};

const modelUnderRuntime = async (db: Db, workspaceId: number): Promise<number> => {
    const runtimeId = await RuntimeSession.ensure(db, workspaceId);
    const bookkeeping = await AdministrativeLoop.open(db, runtimeId);
    await Envelope.closeClientLoop(db, bookkeeping.id, { status: 200 });
    return insertSession(db, workspaceId, runtimeId, "model-tree", "model");
};

test("{§operator-config-workspace-settings}: runtime ancestry does not replace the shared child/grandchild ceiling", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 32_768, responses: [
        makeMockResponse("await plurnk.work({\"target\":\"session://child\",\"prompt\":\"Delegate to a grandchild.\"});\n\nawait plurnk.wait({});"),
        makeMockResponse("await plurnk.work({\"target\":\"session://grandchild\",\"prompt\":\"Do the leaf work.\"});\n\nawait plurnk.wait({});"),
        makeMockResponse("await plurnk.note({\"text\":\"Leaf work is in progress.\"});"),
        makeMockResponse("await plurnk.done({\"text\":\"Leaf work is complete.\"});"),
        makeMockResponse("await plurnk.done({\"text\":\"This fifth call exceeds the explicit ceiling.\"});"),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: `runtime-tree-${crypto.randomUUID()}` });
            const { id: workspaceId } = created.result as { id: number };
            const sessionId = await modelUnderRuntime(db, workspaceId);
            const result = await runLoopToTerminal(ws, 2, {
                sessionId, prompt: "delegate twice", maxTurns: 4,
            }, { timeoutMs: 20_000 });
            assert.equal(result.finalStatus, 429);
            assert.equal(result.hitMaxTurns, true);
            assert.deepEqual(
                [result.result.problem?.treeModelCalls, result.result.problem?.maximumTurns],
                [4, 4],
                "one parent call, one child call and two grandchild calls exhaust the same ceiling",
            );
            assert.equal(mock.received.length, 4, "the runtime ancestor cannot make the model tree uncapped");
            assert.equal(mock.remaining, 1);
            const sessions = await db.test_sessions_with_parent.all<{ id: number; name: string; parent_session_id: number | null }>({});
            const child = sessions.find(({ name }) => name === "child");
            const grandchild = sessions.find(({ name }) => name === "grandchild");
            assert.equal(child?.parent_session_id, sessionId);
            assert.equal(grandchild?.parent_session_id, child?.id);
        } finally { ws.close(); }
    });
});

test("{§operator-config-workspace-settings}: BARE under the runtime actor still respects the model tree's cap", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const childSpec = declaredProvider("runtime-bare", "runtime-bare-model");
    const parent = new Mock({ contextWindow: 32_768, responses: [
        makeMockResponse("await plurnk.bare({\"prompt\":\"One allowed answer.\"});\n\nawait plurnk.bare({\"prompt\":\"No room for another answer.\"});\n\nawait plurnk.note({\"text\":\"Review the results.\"});"),
        makeMockResponse("await plurnk.done({\"text\":\"This call must not run.\"});"),
    ] });
    const child = new Mock({ contextWindow: 8_192, responses: [
        { assistant: { content: "allowed", reasoning: null } },
        { assistant: { content: "beyond the ceiling", reasoning: null } },
    ] });
    ProviderInstantiate.registerInstance(child, childSpec);
    await withDaemon(parent, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: `runtime-bare-${crypto.randomUUID()}` });
            const { id: workspaceId } = created.result as { id: number };
            const sessionId = await modelUnderRuntime(db, workspaceId);
            const result = await runLoopToTerminal(ws, 2, {
                sessionId, prompt: "answer twice", childSelector: childSpec.alias,
                maxTurns: 2,
            });
            assert.equal(result.finalStatus, 429);
            assert.equal(result.hitMaxTurns, true);
            assert.equal(parent.received.length, 1);
            assert.equal(child.received.length, 1);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number }>({ loop_id: result.loopId });
            assert.deepEqual(rows.filter(({ op }) => op === "bare").map(({ status_rx }) => status_rx), [200, 429]);
        } finally { ws.close(); }
    });
});

test("{§operator-config-workspace-settings}: BARE calls spend the loop's budget, and a batch is refused past the ceiling", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const parentSpec = declaredProvider("tree-cap-parent", "tree-cap-parent-model");
    const childSpec = declaredProvider("tree-cap-child", "tree-cap-child-model");
    const parent = new Mock({ contextWindow: 16_384, responses: [
        makeMockResponse("await plurnk.bare({\"prompt\":\"first\"});\n\nawait plurnk.bare({\"prompt\":\"second\"});\n\nawait plurnk.bare({\"prompt\":\"third\"});\n\nawait plurnk.note({\"text\":\"three isolated calls\"});"),
        makeMockResponse("await plurnk.note({\"text\":\"still going\"});"),
        makeMockResponse("await plurnk.note({\"text\":\"still going\"});"),
    ] });
    const child = new Mock({ contextWindow: 8_192, responses: [
        { assistant: { content: "one", reasoning: null } },
        { assistant: { content: "two", reasoning: null } },
        { assistant: { content: "three", reasoning: null } },
    ] });
    ProviderInstantiate.registerInstance(parent, parentSpec);
    ProviderInstantiate.registerInstance(child, childSpec);
    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `tree-cap-bare-${crypto.randomUUID()}` });
            const result = await runLoopToTerminal(ws, 2, {
                prompt: "spend the budget on isolated calls",
                selector: parentSpec.alias,
                childSelector: childSpec.alias,
                maxTurns: 3,
            }, { timeoutMs: 20_000 });
            assert.equal(result.hitMaxTurns, true);
            assert.equal(result.finalStatus, 429, "the tree's ceiling ends the loop at 429 {§tokenomics}");
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: result.loopId });
            const bares = rows.filter((row) => row.op === "bare" && row.origin === "model");
            assert.deepEqual(bares.map((row) => row.status_rx), [200, 200, 429],
                "turn 1 is call one; the first two BAREs are calls two and three; the third meets the ceiling and makes no call");
            const refused = JSON.parse(bares[2].rx) as { problem: { type: string; treeModelCalls: number; maximumTurns: number } };
            assert.match(refused.problem.type, /\/max-turns$/u);
            assert.deepEqual([refused.problem.treeModelCalls, refused.problem.maximumTurns], [3, 3]);
            assert.equal(child.received.length, 2, "the refused BARE never reached the child provider");
            assert.equal(parent.remaining, 2, "the parent's second turn was never requested: the ceiling was met before it");
        } finally { ws.close(); }
    });
});

test("{§operator-config-workspace-settings}: a child's turns spend the parent's budget", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16_384, responses: [
        makeMockResponse("await plurnk.work({\"target\":\"session://helper\",\"prompt\":\"Do one small thing.\"});\n\nawait plurnk.wait({\"text\":\"delegated\"});", 10),
        makeMockResponse("await plurnk.note({\"text\":\"child working\"});", 10),
        makeMockResponse("await plurnk.done({\"text\":\"child done\"});", 10),
        makeMockResponse("await plurnk.note({\"text\":\"parent continues\"});", 10),
        makeMockResponse("await plurnk.note({\"text\":\"never requested: the tree's ceiling is met first\"});", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `tree-cap-child-${crypto.randomUUID()}` });
            const result = await runLoopToTerminal(ws, 2, { prompt: "delegate", maxTurns: 4 }, { timeoutMs: 20_000 });
            assert.equal(result.hitMaxTurns, true);
            assert.equal(result.finalStatus, 429);
            const problem = (result.result as { problem?: { treeModelCalls?: number; maximumTurns?: number } }).problem;
            assert.deepEqual([problem?.treeModelCalls, problem?.maximumTurns], [4, 4], "two parent turns and two child turns met a ceiling of four");
            const parentTurns = await db.lifecycle_loop_model_turn_count.get<{ count: number }>({ loop_id: result.loopId });
            assert.equal(parentTurns?.count, 2, "the parent itself ran two turns; the child's two were counted against the same budget");
            assert.equal(mock.remaining, 1, "the fifth response was never requested");
        } finally { ws.close(); }
    });
});
});
