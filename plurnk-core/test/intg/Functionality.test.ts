import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Daemon from "../../src/server/Daemon.ts";
import Results, { OperationFailureError } from "../../src/core/results.ts";
import LoopDocs from "../../src/server/loopDocs.ts";
import WorkspaceGate from "../../src/core/WorkspaceGate.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { TEST_OWNER, serverProposals } from "./_approval.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Problems, type FunctionalityFamilyHandle, type FunctionalityListResult, type FunctionalityOutcome, type FunctionalityProvenance, type PlurnkStatement, type ProblemDetails } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import { type RuntimeRegistration, type Executor } from "@plurnk/plurnk-execs";
import { type HostFunctionalityAdapter, type HostSetupSeam } from "../../src/server/ModuleHost.ts";
import { awaitExecOutcome } from "./_execs.ts";
import { fixtureExecutors, makeMockResponse, makeRawMockResponse } from "./_mock.ts";
import { insertWorkspace, insertSession, openMigrated } from "./_db.ts";
import { type Db } from "../../src/core/Db.ts";
import { connect, rpcCall, runLoopToTerminal, waitForDb } from "./_rpc.ts";
import { modelOperation, namedModelSession } from "./_sessions.ts";

describe("Functionality", () => {
// {§functionality-coordinator} — the shared workspace Functionality lifecycle proven
// through a fixture adapter: one client projection, one generated runtime,
// one durable workspace-owned state, one atomic publication.
const OWNER = "fx fixture adapter";

const parseOne = (input: string): PlurnkStatement => {
    const parsed = PlurnkParser.parseStatements(input, { executors: fixtureExecutors(input) });
    const item = parsed.items.find((x) => x.kind === "statement");
    if (item?.kind !== "statement") throw new Error(`no statement parsed from ${input}`);
    return item.statement;
};

// One statement as a person's client operation ({§connection-lifecycle}), acting for `contextSessionId` when named.
const clientOperation = async (daemon: Daemon, workspaceId: number, statement: PlurnkStatement, contextSessionId?: number) =>
    (await daemon.dispatchClientAction({
        workspaceId, actor: TEST_OWNER, ...(contextSessionId === undefined ? {} : { contextSessionId }), statements: [statement],
    }))[0];

const runtime = (tag: string, log: string[]): RuntimeRegistration => ({
    namespaceOwner: OWNER,
    decl: {
        name: tag,
        glyph: "🔌",
        summary: `${tag} fixture capability.`,
        invocation: { body: { role: "fixture input", required: false }, example: { body: "fixture" } },
    },
    executor: {
        runtime: tag, glyph: "🔌",
        get manifest() {
            return {
                name: tag, channels: { results: "application/json" }, defaultChannel: "results", category: "data",
                writableBy: [], volatile: true, modelVisible: true,
            } as never;
        },
        get defaultChannel() { return "results"; },
        get channels() { return { results: { mimetype: "application/json" } }; },
        run: async () => { log.push(`run:${tag}`); return { status: 200 }; },
        probe: async () => ({ available: true, detail: "fixture" }),
        effect: () => "read",
    } as unknown as Executor,
    availability: { available: true, detail: "fixture" },
});

// A family whose definitions are {kind: ok | fail | doc | auth}. Service contributes
// `svc`, enabled by default. `fail` refuses preparation; `doc` also publishes a
// document of its own.
const fixtureAdapter = (log: string[]): HostFunctionalityAdapter => ({
    family: "fx",
    namespaceOwner: OWNER,
    summary: "Manage fixture capabilities.",
    definitionSchema: {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: { kind: { enum: ["ok", "fail", "doc", "auth"] } },
    },
    available: async () => [{ alias: "svc", definition: { kind: "ok" }, enabled: true }],
    discovery: { inputs: ["query"] },
    discover: async (query) => [{
        alias: `found-${query.query!}`,
        definition: { kind: "ok" },
        provenance: { kind: "fixture", source: query.query! },
    }],
    admit: async (input) => {
        const { alias, definition } = input as { alias?: string; definition: object };
        return { alias: alias ?? "anonymous", definition };
    },
    prepare: async ({ enabled, failure }) => {
        log.push(`prepare:${[...enabled.keys()].join(",")}`);
        const outcomes = new Map<string, FunctionalityOutcome>();
        const runtimes: RuntimeRegistration[] = [];
        const documents: Array<{ pathname: string; content: string }> = [];
        for (const [alias, { definition }] of enabled) {
            const kind = (definition as { kind: string }).kind;
            if (kind === "auth") {
                outcomes.set(alias, { state: "authorization-required", authorization: {} });
                continue;
            }
            if (kind === "fail") {
                const problem: ProblemDetails = Problems.create("fx:fixture", "refused", 502, `${alias} refused to prepare.`, { retryable: true });
                if (failure === "reject") throw new OperationFailureError(Results.failure("fx:fixture", "refused", 502, `${alias} refused to prepare.`, {}, { retryable: true }));
                outcomes.set(alias, { state: "unavailable", problem });
                continue;
            }
            outcomes.set(alias, { state: "active" });
            runtimes.push(runtime(alias, log));
            if (kind === "doc") documents.push({ pathname: `fx/${alias}.md`, content: `# ${alias}\n\nfixture document` });
        }
        return {
            runtimes,
            documents,
            outcomes,
            snapshot: { aliases: [...enabled.keys()] },
            publish: () => { log.push(`publish:${[...enabled.keys()].join(",")}`); return () => { log.push(`undo:${[...enabled.keys()].join(",")}`); }; },
            commit: async () => { log.push(`commit:${[...enabled.keys()].join(",")}`); },
            abort: async () => { log.push(`abort:${[...enabled.keys()].join(",")}`); },
        };
    },
    teardown: async (snapshot) => { log.push(`teardown:${(snapshot as { aliases: string[] }).aliases.join(",")}`); },
});

test("{§functionality-model-projection} an adapter's docs/<family>.md rides inside the family's tool schema description; a wrong add example fails boot", async () => {
    const docsDir = await mkdtemp(join(tmpdir(), "plurnk-fx-docs-"));
    const db = await openMigrated();
    try {
        await mkdir(join(docsDir, "docs"));
        await writeFile(join(docsDir, "docs", "fx.md"), "# fx\n\n## Choosing a fixture\n\nAuthored fixture teaching.\n");
        const log: string[] = [];
        const daemon = new Daemon({ db, provider: null });
        daemon.registerModule({ setup: (seam: HostSetupSeam) => {
            seam.registerFunctionalityAdapter({ ...fixtureAdapter(log), docsDir, example: { alias: "one", definition: { kind: "ok" } } });
        } }, "test-module");
        await daemon.start();
        try {
            const workspaceId = await insertWorkspace(db, `fx-docs-${crypto.randomUUID()}`);
            await insertSession(db, workspaceId, null, "model", "model");
            await daemon.invokeModuleAction("workspace.fx.enable", { alias: "svc" }, workspaceContext(workspaceId));
            const entries = await daemon.engine.referenceEntries(workspaceId);
            const doc = entries.find(({ pathname }) => pathname === "/_plurnk/tools/plurnk.md");
            assert.ok(doc, "the plurnk tool index is a reference entry");
            assert.equal(doc.content.startsWith("# plurnk\n\n## Summary\n\n```plurnk ("), true, "the generated header owns the H1 and the summary");
            assert.ok(doc.content.includes("## Tools"), "the generated tool table is present");
            const schema = entries.find(({ pathname }) => pathname === "/_plurnk/tools/plurnk/fx.json");
            assert.ok(schema, "the family tool schema is a reference entry");
            const parsed = JSON.parse(schema.content) as { title: string; description: string };
            assert.equal(parsed.title, "plurnk: fx");
            assert.ok(parsed.description.endsWith("## Choosing a fixture\n\nAuthored fixture teaching."), `the authored body closes the description, its authoring title removed:\n${parsed.description}`);
            assert.equal((parsed.description.match(/^# /gmu) ?? []).length, 0, "no duplicate H1 in description");
        } finally {
            await daemon.stop();
        }

        const wrong = new Daemon({ db, provider: null });
        wrong.registerModule({ setup: (seam: HostSetupSeam) => {
            seam.registerFunctionalityAdapter({ ...fixtureAdapter([]), example: { alias: "bogus", definition: { kind: "not-a-kind" } } });
        } }, "test-module");
        await assert.rejects(wrong.start(), /Functionality family 'fx' teaches an add example that violates its own add input/u,
            "a taught example that lies about the schema fails boot, never the model");
        await wrong.stop().catch(() => {});
    } finally {
        await db.close();
        await rm(docsDir, { recursive: true, force: true });
    }
});

const boot = async (db: Db, log: string[]): Promise<Daemon> => {
    const daemon = new Daemon({ db, provider: null });
    daemon.registerModule({ setup: (seam: HostSetupSeam) => { seam.registerFunctionalityAdapter(fixtureAdapter(log)); } }, "test-module");
    await daemon.start();
    return daemon;
};

const workspaceContext = (workspaceId: number) => ({ scope: "workspace" as const, workspaceId });

test("{§functionality-model-projection} one raw model program observes each management result in authored order", { timeout: 20_000 }, async (t) => {
    serverProposals(t, "accept");
    const frame = (verb: string, params: object = {}) => PlurnkParser.frame("plurnk (fx)", JSON.stringify({ verb, ...params }));
    const provider = new Mock({ contextWindow: 1_000_000, responses: [
        makeRawMockResponse([
            frame("add", { alias: "candidate", definition: { kind: "doc" } }), frame("list"),
            PlurnkParser.frame("READ (workspace:///_plurnk/fx/candidate.md)", ""),
            frame("disable", { alias: "candidate" }), frame("list"),
            frame("enable", { alias: "candidate" }), frame("list"),
            frame("replace", { alias: "candidate", definition: { kind: "fail" } }), frame("list"),
            frame("remove", { alias: "candidate" }), frame("list"),
            frame("discover", { query: "next" }),
            PlurnkParser.frame("NOTE", "Review the results."),
        ].join("\n\n")),
        makeRawMockResponse(PlurnkParser.frame("SEND [200]", "Finished.")),
    ] });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider });
    daemon.registerModule({ setup: (seam) => { seam.registerFunctionalityAdapter(fixtureAdapter([])); } }, "test-module");
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "ordered-program" });
    const sessionId = await insertSession(db, workspaceId, null, "reader", "model");
    const loop = await daemon.runLoop({ workspaceId, sessionId, prompt: "Exercise the fixture lifecycle.", maxTurns: 2 });
    const lifecycle = new LoopLifecycle(db);
    await waitForDb(() => lifecycle.status(loop.loopId), (status) => status !== null && status >= 200);
    const rows = await daemon.readLog({ workspaceId, sessionId, limit: Number.MAX_SAFE_INTEGER });
    const operations = rows.filter((row) => row.origin === "model" && row.op === "plurnk").toReversed();
    assert.deepEqual(operations.map(({ status_rx }) => status_rx), [201, 200, 200, 200, 200, 200, 502, 200, 200, 200, 200]);
    const listed = await db.test_entries_by_scheme_prefix.all<{ id: number; pathname: string }>({ workspace_id: workspaceId, scheme: "plurnk", prefix: "/%" });
    const states: Array<string | undefined> = [];
    for (const { pathname } of listed.toSorted((a, b) => a.id - b.id)) {
        const channel = await db.test_get_channel_by_pathname_scheme.get<{ content: string; state: string }>({ pathname, scheme: "plurnk", name: "results" });
        assert.ok(channel?.state === "closed" || channel?.state === "errored");
        const body = JSON.parse(channel.content) as Record<string, unknown>;
        if (Array.isArray(body.definitions)) states.push((body.definitions as Array<{ alias: string; state: string }>).find(({ alias }) => alias === "candidate")?.state);
    }
    assert.deepEqual(states, ["active", "disabled", "active", "active", undefined], "inspection snapshots match their own execution point, including the failed replacement");
    assert.ok(rows.some((row) => row.origin === "model" && row.op === "READ" && row.status_rx === 200 && JSON.stringify(row.rx).includes("fixture document")), "READ sees the newly published document without another turn");
    assert.equal(await lifecycle.status(loop.loopId), 200);
});

test("{§functionality-model-projection} concurrent configuration bypasses occupied external execution slots", { timeout: 15_000 }, async (t) => {
    const prior = process.env.PLURNK_SERVICE_EXEC_CONCURRENCY;
    process.env.PLURNK_SERVICE_EXEC_CONCURRENCY = "1";
    t.after(() => { if (prior === undefined) delete process.env.PLURNK_SERVICE_EXEC_CONCURRENCY; else process.env.PLURNK_SERVICE_EXEC_CONCURRENCY = prior; });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    daemon.registerModule({ setup: async (seam) => {
        seam.registerFunctionalityAdapter(fixtureAdapter([]));
        const held = runtime("held", []);
        held.executor.run = async () => { entered.resolve(); await resume.promise; return { status: 200 }; };
        await seam.registerRuntimes([held]);
    } }, "test-module");
    t.after(async () => { resume.resolve(); await daemon.stop(); await db.close(); });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "ordered-concurrent" });
    assert.equal((await clientOperation(daemon, workspaceId, parseOne(PlurnkParser.frame("held", "fixture")))).status, 200);
    await entered.promise;
    const results = await Promise.all(["first", "second"].map((alias) => clientOperation(daemon, workspaceId,
        parseOne(PlurnkParser.frame("plurnk (fx)", JSON.stringify({ verb: "add", alias, definition: { kind: "ok" } }))))));
    assert.deepEqual(results.map(({ status }) => status), [201, 201], "both changes settle while the external tool remains in flight");
    const listed = await daemon.invokeModuleAction("workspace.fx.list", {}, workspaceContext(workspaceId)) as FunctionalityListResult;
    assert.deepEqual(listed.definitions.map(({ alias, state }) => [alias, state]), [["first", "active"], ["second", "active"], ["svc", "active"]]);
});

test("{§functionality-adapter} cancelling an operation joins preparation and leaves no later publication", { timeout: 15_000 }, async (t) => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    const preparing = Promise.withResolvers<void>();
    const log: string[] = [];
    const adapter = fixtureAdapter(log);
    daemon.registerModule({ setup: (seam) => { seam.registerFunctionalityAdapter({
        ...adapter,
        prepare: async (input) => {
            const prepared = await adapter.prepare(input);
            if (!input.enabled.has("cancelled")) return prepared;
            preparing.resolve();
            await new Promise<void>((res) => {
                if (input.signal.aborted) res();
                else input.signal.addEventListener("abort", () => res(), { once: true });
            });
            return prepared;
        },
    }); } }, "test-module");
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "cancel-publication" });
    let loopId!: number;
    const pending = daemon.dispatchClientAction({
        workspaceId, actor: TEST_OWNER, onLoop: ({ loopId: id }) => { loopId = id; },
        statements: [parseOne(PlurnkParser.frame("plurnk (fx)", JSON.stringify({ verb: "add", alias: "cancelled", definition: { kind: "doc" } })))],
    });
    await preparing.promise;
    assert.equal(await daemon.cancelLoop({ workspaceId, loopId }), true);
    await assert.rejects(pending, (cause: unknown) => {
        assert.ok(cause instanceof OperationFailureError);
        assert.equal(cause.result.status, 499);
        assert.equal(cause.result.problem.type, "https://problems.plurnk.xyz/daemon/client/operation-cancelled");
        return true;
    });
    assert.equal(log.includes("abort:cancelled,svc"), true, "candidate resources are joined and cleaned up");
    assert.equal(log.includes("commit:cancelled,svc"), false);
    const listed = await daemon.invokeModuleAction("workspace.fx.list", {}, workspaceContext(workspaceId)) as FunctionalityListResult;
    assert.deepEqual(listed.definitions.map(({ alias }) => alias), ["svc"]);
    assert.equal(daemon.schemes.has("cancelled", workspaceId), false);
    assert.equal((await clientOperation(daemon, workspaceId, parseOne(PlurnkParser.frame("plurnk (fx)", "")))).status, 200, "the cancellation leaves the workspace usable");
});

for (const caller of ["action", "operation"] as const) {
    test(`{§functionality-replacement} ${caller} replacement preserves enabledness and rejects without losing the prior publication`, { timeout: 30_000 }, async (t) => {
        const db = await openMigrated();
        const log: string[] = [];
        const daemon = await boot(db, log);
        t.after(async () => { await daemon.stop(); await db.close(); });
        const workspaceId = await insertWorkspace(db, `replacement-${caller}`);
        const action = (verb: string, params: Readonly<Record<string, unknown>>) => daemon.invokeModuleAction(`workspace.fx.${verb}`, params, workspaceContext(workspaceId));
        const listed = async () => (await action("list", {}) as FunctionalityListResult).definitions;
        const run = (statement: PlurnkStatement) => clientOperation(daemon, workspaceId, statement);
        const operate = (verb: string, params: object) => run(parseOne(PlurnkParser.frame("plurnk (fx)", JSON.stringify({ verb, ...params }))));
        const invoke = async (verb: string, params: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> => {
            if (caller === "action") {
                try { return await action(verb, params) as Record<string, unknown>; }
                catch (cause) {
                    if (cause instanceof OperationFailureError) return { ...cause.result };
                    throw cause;
                }
            }
            const after = (await db.test_entries_by_scheme_prefix.all({ workspace_id: workspaceId, scheme: "plurnk", prefix: "/%" })).length;
            const dispatched = await operate(verb, params);
            if (dispatched.status >= 400) return { ...dispatched };
            const result = await awaitExecOutcome(db, { workspaceId, scheme: "plurnk", after });
            await daemon.settleFunctionality(workspaceId);
            return result;
        };
        const replace = (alias: string, kind: string) => invoke("replace", { alias, definition: { kind } });
        await action("add", { alias: "local", definition: { kind: "ok" } });
        const original = await listed();
        const invalid = await invoke("replace", { alias: "local", definition: {} });
        assert.equal(invalid.status, 400);
        assert.equal((invalid.problem as ProblemDetails).type, "https://problems.plurnk.xyz/functionality/arguments-invalid");
        assert.deepEqual(await listed(), original);
        const unavailable = await replace("local", "fail");
        assert.equal(unavailable.status, 502);
        assert.equal((unavailable.problem as ProblemDetails).type, "https://problems.plurnk.xyz/fx/fixture/refused");
        assert.deepEqual(await listed(), original, "preparation failure preserves the complete prior state");
        assert.equal((await run(parseOne(PlurnkParser.frame("local", "fixture")))).status, 200,
            "the preceding capability still executes after replacement fails");

        if (caller === "action") {
            const auth = await replace("local", "auth");
            assert.equal(auth.status, 202, "authorization-required is a successful handoff, not a refused replacement");
            assert.equal((await listed()).find(({ alias }) => alias === "local")?.state, "authorization-required");
            assert.equal((await replace("local", "ok")).status, 200);
        } else {
            let IntermediateState: string | undefined;
            const unsubscribe = daemon.subscribeToEvents((eventWorkspaceId, method, params) => {
                if (eventWorkspaceId !== workspaceId || method !== "notice/event") return;
                const notice = (params as { notice?: { kind?: string } }).notice;
                if (notice?.kind === "authorization_required") {
                    void (async () => {
                        IntermediateState = (await listed()).find(({ alias }) => alias === "local")?.state;
                        await action("replace", { alias: "local", definition: { kind: "ok" } });
                    })();
                }
            });
            try {
                const auth = await replace("local", "auth");
                assert.equal(IntermediateState, "authorization-required");
                assert.equal(auth.status, 200, "operation holds across authorization-required and settles with the resolved state");
                assert.equal((auth.definition as { state?: string } | undefined)?.state, "active");
            } finally { unsubscribe(); }
        }
        await action("disable", { alias: "local" });
        assert.equal((await replace("local", "fail")).status, 200, "disabled definitions do not prepare their unavailable candidate");
        assert.deepEqual((await listed()).find(({ alias }) => alias === "local"), {
            alias: "local", origin: "workspace", definition: { kind: "fail" }, state: "disabled",
        });
        assert.equal((await replace("local", "doc")).status, 200);
        assert.equal((await listed()).find(({ alias }) => alias === "local")?.state, "disabled");
        await action("enable", { alias: "local" });
        assert.equal((await replace("local", "doc")).status, 200, "identical replacement is idempotent");

        const published = await listed();
        const refused = Results.failure("fx:fixture", "publication-refused", 409, "Fixture publication refused.", {}, { retryable: true });
        t.mock.method(daemon, "replaceWorkspaceCapabilities", async () => { throw new OperationFailureError(refused); }, { times: 1 });
        assert.deepEqual(await replace("local", "ok"), refused);
        assert.deepEqual(await listed(), published, "publication failure preserves the admitted configuration");
        assert.ok((await daemon.engine.referenceEntries(workspaceId)).some(({ pathname, content }) =>
            pathname === "/_plurnk/fx/local.md" && content.includes("fixture document")), "the preceding document remains published");

        await action("disable", { alias: "svc" });
        assert.equal((await replace("svc", "doc")).status, 201, "replacement can create a local override");
        assert.deepEqual((await listed()).find(({ alias }) => alias === "svc"), {
            alias: "svc", origin: "workspace", definition: { kind: "doc" }, state: "disabled",
        }, "an inherited disabled definition stays disabled when overridden");
        await action("remove", { alias: "svc" });
        assert.deepEqual((await listed()).find(({ alias }) => alias === "svc"), {
            alias: "svc", origin: "service", definition: { kind: "ok" }, state: "active",
        }, "removing the local replacement restores the inherited definition and enabledness");

        assert.equal((await replace("new", "ok")).status, 201, "named assignment creates an absent definition");
        assert.equal((await listed()).find(({ alias }) => alias === "new")?.state, "active");
        const unnamed = await invoke("replace", { definition: { kind: "ok" } });
        assert.equal(unnamed.status, 400, "replacement always names its alias");
        assert.equal((unnamed.problem as ProblemDetails).type, "https://problems.plurnk.xyz/functionality/arguments-invalid");
        if (caller === "operation") {
            // {§proposal-disposition} A person's operation is that person's decision; the server's reject still applies.
            serverProposals(t, "reject");
            const before = await listed();
            log.length = 0;
            assert.equal((await operate("replace", { alias: "local", definition: { kind: "ok" } })).status, 400);
            assert.deepEqual(await listed(), before);
            assert.deepEqual(log, [], "a rejected replacement never prepares or publishes");
        }
    });
}

test("{§functionality-replacement} mutations distinguish local creation, settlement, and authorization", async (t) => {
    const db = await openMigrated();
    const daemon = await boot(db, []);
    t.after(async () => { await daemon.stop(); await db.close(); });
    const workspaceId = await insertWorkspace(db, "mutation-status");
    const invoke = async (verb: string, alias: string, kind?: string) =>
        daemon.invokeModuleAction(`workspace.fx.${verb}`, {
            alias, ...(kind === undefined ? {} : { definition: { kind } }),
        }, workspaceContext(workspaceId)) as Promise<{ status: number; definition?: { state: string }; removed?: boolean }>;
    assert.equal((await invoke("add", "local", "ok")).status, 201);
    assert.equal((await invoke("add", "local", "ok")).status, 200);
    await assert.rejects(invoke("add", "local", "doc"), (cause: unknown) => {
        assert.ok(cause instanceof OperationFailureError);
        assert.equal(cause.result.status, 409);
        assert.equal(cause.result.problem.type, "https://problems.plurnk.xyz/functionality/alias-exists");
        return true;
    });
    assert.equal((await invoke("add", "svc", "ok")).status, 201, "an inherited override creates a local definition");
    assert.equal((await invoke("disable", "local")).status, 200);
    assert.equal((await invoke("enable", "local")).status, 200);
    assert.equal((await invoke("remove", "local")).status, 200);
    for (const verb of ["add", "add", "enable"]) {
        const pending = await invoke(verb, "login", verb === "add" ? "auth" : undefined);
        assert.equal(pending.status, 202, `${verb} reports the authorization outcome, not local creation or reuse`);
        assert.equal(pending.definition?.state, "authorization-required");
    }
    assert.equal((await invoke("disable", "login")).status, 200);
    assert.equal((await invoke("enable", "login")).status, 202);
    assert.equal((await invoke("remove", "login")).status, 200);
});

test("{§module-workspace-residency} a model turn and concurrent catalog refresh both complete without reversing their locks", { timeout: 10000 }, async (t) => {
    serverProposals(t, "accept");
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 1_000_000, responses: [makeMockResponse("```SEND [200]\nReady.\n```")] });
    const daemon = new Daemon({ db, provider });
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const queued = Promise.withResolvers<void>();
    const log: string[] = [];
    let handle!: FunctionalityFamilyHandle;
    daemon.registerModule({ setup: (seam) => {
        handle = seam.registerFunctionalityAdapter({
            ...fixtureAdapter(log),
            refreshIfChanged: async (identity) => {
                entered.resolve();
                await resume.promise;
                await handle.refresh(identity, { gate: "none", ifChanged: true });
            },
        });
    } }, "test-module");
    t.after(async () => { resume.resolve(); await daemon.stop(); await db.close(); });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "refresh-during-admission" });
    const sessionId = await insertSession(db, workspaceId, null, "reader", "model");
    await daemon.invokeModuleAction("workspace.fx.enable", { alias: "svc" }, workspaceContext(workspaceId));
    const before = log.filter((event) => event.startsWith("commit:")).length;
    const loop = await daemon.runLoop({ workspaceId, sessionId, prompt: "Confirm readiness." });
    await entered.promise;
    const request = WorkspaceGate.prototype.requestExclusive;
    t.mock.method(WorkspaceGate.prototype, "requestExclusive", function (this: WorkspaceGate, id: number) {
        const held = request.call(this, id);
        queued.resolve();
        return held;
    }, { times: 1 });
    const refresh = handle.refresh({ workspaceId });
    await queued.promise;
    assert.equal(provider.received.length, 0, "the current turn is still in admission");
    resume.resolve();
    await refresh;
    const lifecycle = new LoopLifecycle(db);
    await waitForDb(() => lifecycle.status(loop.loopId), (status) => status === 200);
    assert.equal(provider.received.length, 1, "the current turn reaches inference and concludes");
    assert.equal(log.filter((event) => event.startsWith("commit:")).length, before + 1, "the background refresh subsequently publishes once");
    const listed = await daemon.invokeModuleAction("workspace.fx.list", {}, workspaceContext(workspaceId)) as FunctionalityListResult;
    assert.equal(listed.definitions.find(({ alias }) => alias === "svc")?.state, "active");
});

for (const boundary of ["available", "prepare"] as const) {
    test(`{§configuration-repair-path} a warm ${boundary} failure withdraws capabilities, preserves definitions, and recovers normally`, async (t) => {
        const db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `repair-${boundary}`);
        const log: string[] = [];
        const adapter = fixtureAdapter(log);
        const daemon = new Daemon({ db, provider: null });
        let broken = false;
        let handle!: FunctionalityFamilyHandle;
        const error = new ConfigurationError("PLURNK_FX_bad", "PLURNK_FX_bad must contain a complete definition.");
        daemon.registerModule({ setup: (seam) => { handle = seam.registerFunctionalityAdapter({
            ...adapter,
            available: async (identity) => {
                if (broken && boundary === "available") throw error;
                return adapter.available(identity);
            },
            prepare: async (input) => {
                if (broken && boundary === "prepare") throw error;
                return adapter.prepare(input);
            },
        }); } }, "test-module");
        t.after(async () => { await daemon.stop(); await db.close(); });
        await daemon.start();
        await daemon.invokeModuleAction("workspace.fx.add", { alias: "local", definition: { kind: "doc" } }, workspaceContext(workspaceId));
        assert.equal(daemon.schemes.has("local", workspaceId), true);
        const durable = await daemon.readWorkspaceModuleState(workspaceId, OWNER);
        broken = true;
        await handle.refresh({ workspaceId });
        assert.equal(daemon.schemes.has("local", workspaceId), false, "an invalid family has no operational runtimes");
        assert.equal(daemon.schemes.has("plurnk", workspaceId), true, "the manager remains available");
        assert.deepEqual(await daemon.readWorkspaceModuleState(workspaceId, OWNER), durable, "withdrawal does not erase operator state");
        assert.ok(log.includes("teardown:local,svc"), "the previous snapshot is released");
        const problem = await rejectedProblem(() => daemon.invokeModuleAction("workspace.fx.list", {}, workspaceContext(workspaceId)));
        assert.equal(problem.type, "https://problems.plurnk.xyz/functionality/configuration-invalid");
        assert.equal(problem.detail, error.message, "a prepare failure cannot masquerade as an empty or dormant catalog");
        broken = false;
        const beforeInspection = [...log];
        if (boundary === "available") {
            const fresh = await daemon.invokeModuleAction("workspace.fx.list", {}, workspaceContext(workspaceId)) as FunctionalityListResult;
            assert.deepEqual(fresh.definitions.map(({ alias, state }) => [alias, state]), [["local", "dormant"], ["svc", "dormant"]],
                "successful source resolution supersedes the preceding source error, without claiming publication");
        } else {
            const pending = await rejectedProblem(() => daemon.invokeModuleAction("workspace.fx.list", {}, workspaceContext(workspaceId)));
            assert.equal(pending.detail, error.message, "resolving definitions does not prove that failed preparation has recovered");
        }
        assert.deepEqual(log, beforeInspection, "inspection cannot prepare, publish, or tear down a family");
        await handle.refresh({ workspaceId });
        const recovered = await daemon.invokeModuleAction("workspace.fx.list", {}, workspaceContext(workspaceId)) as FunctionalityListResult;
        assert.deepEqual(recovered.definitions.map(({ alias, state }) => [alias, state]), [["local", "active"], ["svc", "active"]]);
        assert.equal(daemon.schemes.has("local", workspaceId), true);
        assert.deepEqual(await daemon.readWorkspaceModuleState(workspaceId, OWNER), durable);
    });
}

test("{§configuration-repair-path} invalid model mutations preserve the previous publication and internal failures remain exceptions", async (t) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "repair-atomic");
    const adapter = fixtureAdapter([]);
    const daemon = new Daemon({ db, provider: null });
    let handle!: FunctionalityFamilyHandle;
    let defect: Error | null = null;
    daemon.registerModule({ setup: (seam) => { handle = seam.registerFunctionalityAdapter({
        ...adapter,
        prepare: async (input) => {
            if (defect !== null) throw defect;
            return adapter.prepare(input);
        },
    }); } }, "test-module");
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    await daemon.invokeModuleAction("workspace.fx.enable", { alias: "svc" }, workspaceContext(workspaceId));
    const durable = await daemon.readWorkspaceModuleState(workspaceId, OWNER);
    defect = new ConfigurationError("PLURNK_FX_bad", "PLURNK_FX_bad must contain a complete definition.");
    const problem = await rejectedProblem(() => handle.invoke("add", { alias: "candidate", definition: { kind: "ok" } }, workspaceContext(workspaceId)));
    assert.equal(problem.type, "https://problems.plurnk.xyz/functionality/configuration-invalid");
    assert.deepEqual(await daemon.readWorkspaceModuleState(workspaceId, OWNER), durable);
    assert.equal(daemon.schemes.has("svc", workspaceId), true);
    assert.equal(daemon.schemes.has("candidate", workspaceId), false);
    defect = new Error("fixture internal invariant violated");
    await assert.rejects(handle.refresh({ workspaceId }), (cause) => cause === defect);
    assert.equal(daemon.schemes.has("svc", workspaceId), true);
});

test("{§functionality-inspection} cold and preparing workspaces remain inspectable without activating or joining preparation", { timeout: 10_000 }, async (t) => {
    const db = await openMigrated();
    const log: string[] = [];
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const adapter = fixtureAdapter(log);
    let hold = false;
    const daemon = new Daemon({ db, provider: null });
    daemon.registerModule({ setup: (seam: HostSetupSeam) => {
        seam.registerFunctionalityAdapter({
            ...adapter,
            prepare: async (preparation) => {
                if (hold) {
                    preparation.progress(["svc"]);
                    entered.resolve();
                    await resume.promise;
                }
                return adapter.prepare(preparation);
            },
        });
    } }, "test-module");
    await daemon.start();
    let demand: Promise<unknown> | undefined;
    t.after(async () => { resume.resolve(); await demand; await daemon.stop(); await db.close(); });
    const workspaceId = await insertWorkspace(db, `passive-${crypto.randomUUID()}`);
    const invoke = (verb: string, params = {}) => daemon.invokeModuleAction(`workspace.fx.${verb}`, params, workspaceContext(workspaceId));
    const listing = async () => (await invoke("list") as { definitions: Array<{ state: string }> }).definitions;
    assert.deepEqual((await listing()).map(({ state }) => state), ["dormant"]);
    assert.deepEqual(log, [], "inspection must not prepare capabilities");
    assert.deepEqual(daemon.workspacePreparationStatus(workspaceId), []);
    const updates: unknown[] = [];
    daemon.subscribeToEvents((id, method, params) => {
        if (id === workspaceId && method === "workspace/preparation") updates.push(params);
    });
    hold = true;
    demand = invoke("enable", { alias: "svc" });
    await entered.promise;
    const during = await listing();
    assert.equal(during[0].state, "dormant", "a candidate is not yet a published capability");
    const active = daemon.workspacePreparationStatus(workspaceId);
    assert.equal(active.length, 1);
    assert.equal(active[0].family, "fx");
    assert.equal(active[0].alias, "svc");
    assert.equal(active[0].phase, "preparing");
    assert.ok(Number.isFinite(Date.parse(active[0].since)));
    assert.deepEqual(updates.at(-1), { workspaceId, preparation: active }, "snapshot and events expose the same current state");
    resume.resolve();
    await demand;
    assert.deepEqual((await listing()).map(({ state }) => state), ["active"]);
    assert.deepEqual(daemon.workspacePreparationStatus(workspaceId), []);
    assert.deepEqual(updates.at(-1), { workspaceId, preparation: [] });
});

test("{§methods-workspace-create} activation without a turn publishes a workspace's capabilities once, however many demand it", async (t) => {
    const db = await openMigrated();
    const log: string[] = [];
    const daemon = new Daemon({ db, provider: null });
    daemon.registerModule({ setup: (seam: HostSetupSeam) => { seam.registerFunctionalityAdapter(fixtureAdapter(log)); } }, "test-module");
    await daemon.start();
    t.after(async () => { await daemon.stop(); await db.close(); });
    const workspaceId = await insertWorkspace(db, `activate-${crypto.randomUUID()}`);
    assert.equal(daemon.schemes.has("svc", workspaceId), false, "a workspace stays passive until demanded");
    assert.equal(log.length, 0);
    await Promise.all([daemon.activateWorkspace({ workspaceId }), daemon.activateWorkspace({ workspaceId })]);
    assert.equal(daemon.schemes.has("svc", workspaceId), true, "its capabilities are published without a turn");
    assert.equal(log.filter((line) => line.startsWith("prepare:")).length, 1, "concurrent demands share one activation");
    await daemon.activateWorkspace({ workspaceId });
    assert.equal(log.filter((line) => line.startsWith("prepare:")).length, 1, "a warm workspace is not prepared again");
    await assert.rejects(daemon.activateWorkspace({ workspaceId: 999_999 }), /does not exist/u);
});

test("{§functionality-inspection} aliases prepared at once are each listed from the time it began, and each leaves when a report omits it", { timeout: 10_000 }, async (t) => {
    const db = await openMigrated();
    const log: string[] = [];
    const adapter = fixtureAdapter(log);
    const both = Promise.withResolvers<void>();
    const narrowed = Promise.withResolvers<void>();
    const step = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const daemon = new Daemon({ db, provider: null });
    daemon.registerModule({ setup: (seam: HostSetupSeam) => {
        seam.registerFunctionalityAdapter({
            ...adapter,
            available: async () => [{ alias: "svc", definition: { kind: "ok" }, enabled: true }, { alias: "web", definition: { kind: "ok" }, enabled: true }],
            prepare: async (preparation) => {
                preparation.progress(["svc", "web"]);
                both.resolve();
                await step.promise;
                preparation.progress(["web"]);
                narrowed.resolve();
                await resume.promise;
                return adapter.prepare(preparation);
            },
        });
    } }, "test-module");
    await daemon.start();
    let demand: Promise<unknown> | undefined;
    t.after(async () => { step.resolve(); resume.resolve(); await demand; await daemon.stop(); await db.close(); });
    const workspaceId = await insertWorkspace(db, `concurrent-${crypto.randomUUID()}`);
    demand = daemon.invokeModuleAction("workspace.fx.enable", { alias: "svc" }, workspaceContext(workspaceId));
    await both.promise;
    const first = daemon.workspacePreparationStatus(workspaceId);
    assert.deepEqual(first.map(({ family, alias, phase }) => [family, alias, phase]), [["fx", "svc", "preparing"], ["fx", "web", "preparing"]],
        "every alias being prepared is listed");
    await new Promise((res) => setTimeout(res, 5));
    step.resolve();
    await narrowed.promise;
    const second = daemon.workspacePreparationStatus(workspaceId);
    assert.deepEqual(second.map(({ alias }) => alias), ["web"], "an alias that settled leaves");
    assert.equal(second[0].since, first[1].since, "the alias still preparing keeps the time it began");
    resume.resolve();
    await demand;
    assert.deepEqual(daemon.workspacePreparationStatus(workspaceId), []);
});

test("{§functionality-inspection} a changed inherited definition never borrows the previous definition's preparation outcome", async (t) => {
    const db = await openMigrated();
    const log: string[] = [];
    const adapter = fixtureAdapter(log);
    let definition = { kind: "ok" };
    let handle: FunctionalityFamilyHandle;
    const daemon = new Daemon({ db, provider: null });
    daemon.registerModule({ setup: (seam) => {
        handle = seam.registerFunctionalityAdapter({ ...adapter, available: async () => [{ alias: "svc", definition, enabled: true }] });
    } }, "test-module");
    await daemon.start();
    t.after(async () => { await daemon.stop(); await db.close(); });
    const workspaceId = await insertWorkspace(db, `inspection-replacement-${crypto.randomUUID()}`);
    const invoke = (verb: string, params = {}) => daemon.invokeModuleAction(`workspace.fx.${verb}`, params, workspaceContext(workspaceId));
    const listed = async () => (await invoke("list") as FunctionalityListResult).definitions[0];
    await invoke("enable", { alias: "svc" });
    assert.equal((await listed()).state, "active");
    definition = { kind: "doc" };
    const before = [...log];
    assert.deepEqual(await listed(), { alias: "svc", origin: "service", definition, state: "dormant" });
    assert.deepEqual(log, before, "inspection neither prepares the replacement nor tears down the published resource");
    await invoke("enable", { alias: "svc" });
    assert.deepEqual(await listed(), { alias: "svc", origin: "service", definition, state: "active" });
    definition = { kind: "doc" };
    assert.equal((await listed()).state, "active", "equivalent objects retain the published outcome");
    definition = { kind: "fail" };
    await handle!.refresh({ workspaceId });
    assert.equal((await listed()).state, "unavailable");
    definition = { kind: "ok" };
    assert.deepEqual(await listed(), { alias: "svc", origin: "service", definition, state: "dormant" }, "an old failure does not describe its replacement");
});

test("{§functionality-adapter} interpretation context participates in runtime identity and is removed by a complete local replacement", async (t) => {
    const db = await openMigrated();
    const adapter = fixtureAdapter([]);
    let context = { root: "/plugins/one" };
    let prepared: unknown;
    let preparations = 0;
    let handle: FunctionalityFamilyHandle;
    const daemon = new Daemon({ db, provider: null });
    daemon.registerModule({ setup: (seam) => {
        handle = seam.registerFunctionalityAdapter({
            ...adapter,
            available: async () => [{ alias: "svc", definition: { kind: "ok" }, enabled: true, context }],
            prepare: async (input) => {
                preparations++;
                prepared = input.enabled.get("svc");
                return adapter.prepare(input);
            },
        });
    } }, "test-module");
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const workspaceId = await insertWorkspace(db, `interpretation-context-${crypto.randomUUID()}`);
    const invoke = (verb: string, params = {}) => daemon.invokeModuleAction(`workspace.fx.${verb}`, params, workspaceContext(workspaceId));
    const listed = async () => (await invoke("list") as FunctionalityListResult).definitions[0];
    await invoke("enable", { alias: "svc" });
    assert.deepEqual(prepared, { definition: { kind: "ok" }, context });
    assert.equal(Object.hasOwn(await listed(), "context"), false, "adapter preparation context is not another public configuration field");
    const before = preparations;
    await handle!.refresh({ workspaceId }, { ifChanged: true });
    assert.equal(preparations, before);
    context = { root: "/plugins/two" };
    assert.equal((await listed()).state, "dormant", "identical source text at a different interpretation root is not the old runtime");
    await handle!.refresh({ workspaceId }, { ifChanged: true });
    assert.equal(preparations, before + 1);
    assert.deepEqual(prepared, { definition: { kind: "ok" }, context });
    await invoke("add", { alias: "svc", definition: { kind: "ok" } });
    assert.deepEqual(prepared, { definition: { kind: "ok" } }, "a local replacement cannot inherit plugin interpretation");
    await invoke("remove", { alias: "svc" });
    assert.deepEqual(prepared, { definition: { kind: "ok" }, context }, "remove restores the current complete binding");
    context.root = "/plugins/three";
    assert.equal((await listed()).state, "dormant", "the publication retains an owned snapshot, not a mutable source object");
    await handle!.refresh({ workspaceId }, { ifChanged: true });
    assert.deepEqual(prepared, { definition: { kind: "ok" }, context });
});

test("{§configuration-repair-path} inspection reports the winning source without persisting it or preparing it", async (t) => {
    const db = await openMigrated();
    const log: string[] = [];
    let provenance: FunctionalityProvenance = { kind: "environment", source: "PLURNK_FX_svc" };
    const adapter = { ...fixtureAdapter(log), available: async () => [{ alias: "svc", definition: { kind: "ok" }, enabled: true, provenance }] };
    const start = async () => {
        const daemon = new Daemon({ db, provider: null });
        daemon.registerModule({ setup: (seam) => { seam.registerFunctionalityAdapter(adapter); } }, "test-module");
        await daemon.start();
        return daemon;
    };
    let daemon = await start();
    t.after(async () => { await daemon.stop(); await db.close(); });
    const workspaceId = await insertWorkspace(db, `inspection-source-${crypto.randomUUID()}`);
    const invoke = (verb: string, params = {}) => daemon.invokeModuleAction(`workspace.fx.${verb}`, params, workspaceContext(workspaceId));
    const listed = async () => (await invoke("list") as FunctionalityListResult).definitions[0];
    assert.deepEqual(await listed(), { alias: "svc", origin: "service", definition: { kind: "ok" }, provenance, state: "dormant" });
    assert.deepEqual(log, [], "source inspection does not activate anything");
    await invoke("enable", { alias: "svc" });
    provenance = { kind: "file", source: "/project/.agents/skills/svc/SKILL.md" };
    assert.deepEqual(await listed(), { alias: "svc", origin: "service", definition: { kind: "ok" }, provenance, state: "active" }, "source location does not change prepared identity");
    await invoke("disable", { alias: "svc" });
    assert.equal((await listed()).state, "disabled");
    assert.deepEqual((await listed()).provenance, provenance);
    await invoke("add", { alias: "svc", definition: { kind: "doc" } });
    assert.deepEqual(await listed(), { alias: "svc", origin: "workspace", definition: { kind: "doc" }, state: "active" });
    await daemon.stop();
    daemon = await start();
    assert.equal((await listed()).provenance, undefined, "restart does not attach the shadowed source to a local definition");
    await invoke("remove", { alias: "svc" });
    assert.deepEqual(await listed(), { alias: "svc", origin: "service", definition: { kind: "ok" }, provenance, state: "active" });
    await daemon.stop();
    provenance = { kind: "environment", source: "PLURNK_FX_svc" };
    daemon = await start();
    assert.deepEqual(await listed(), { alias: "svc", origin: "service", definition: { kind: "ok" }, provenance, state: "dormant" }, "the source is re-resolved, never a stale persisted label");
});

for (const defect of ["outcome", "namespace"] as const) {
    test(`{§functionality-coordinator} invalid ${defect} preparation aborts its candidate and preserves the workspace`, async (t) => {
        const db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `bad-preparation-${defect}`);
        const log: string[] = [];
        const adapter = fixtureAdapter(log);
        const daemon = new Daemon({ db, provider: null });
        daemon.registerModule({ setup: (seam) => { seam.registerFunctionalityAdapter({
            ...adapter,
            prepare: async (input) => {
                const prepared = await adapter.prepare(input);
                if (!input.enabled.has("candidate")) return prepared;
                return defect === "outcome"
                    ? { ...prepared, outcomes: new Map([...prepared.outcomes].filter(([alias]) => alias !== "candidate")) }
                    : { ...prepared, runtimes: (prepared.runtimes ?? []).map((registered) => ({ ...registered, namespaceOwner: "wrong owner" })) };
            },
        }); } }, "test-module");
        t.after(async () => { await daemon.stop(); await db.close(); });
        await daemon.start();
        const action = (verb: string, params = {}) => daemon.invokeModuleAction(`workspace.fx.${verb}`, params, workspaceContext(workspaceId));
        await action("enable", { alias: "svc" });
        log.length = 0;
        await assert.rejects(() => action("add", { alias: "candidate", definition: { kind: "ok" } }),
            defect === "outcome" ? /reported no outcome for enabled alias 'candidate'/u : /prepared a runtime owned by 'wrong owner'/u);
        assert.deepEqual(log.filter((entry) => entry.startsWith("abort:")), ["abort:candidate,svc"]);
        assert.equal(log.some((entry) => entry.startsWith("commit:")), false);
        assert.deepEqual(daemon.workspacePreparationStatus(workspaceId), [], "rejected publication clears its preparation activity");
        const result = await action("list") as { definitions: Array<{ alias: string }> };
        assert.deepEqual(result.definitions.map(({ alias }) => alias), ["svc"]);
        for (const [tag, expected] of [["svc", 200], ["candidate", 400]] as const) {
            const outcome = await clientOperation(daemon, workspaceId, parseOne(PlurnkParser.frame(tag, "fixture")));
            assert.equal(outcome.status, expected, `${tag}: ${JSON.stringify(outcome)}`);
        }
    });
}

const rejectedProblem = async (run: () => Promise<unknown>): Promise<ProblemDetails> => {
    try { await run(); } catch (error) {
        assert.ok(error instanceof OperationFailureError, `expected an operation failure, got ${String(error)}`);
        return error.result.problem;
    }
    assert.fail("Expected operation failure.");
};

test("{§configuration-repair-path} a workspace definition replaces the whole baseline; enabledness never copies it", async (t) => {
    const db = await openMigrated();
    const adapter = fixtureAdapter([]);
    let baseline: object = { kind: "ok", args: ["service-argument"], env: { SERVICE: "first" } };
    let prepared: object | undefined;
    const daemon = new Daemon({ db, provider: null });
    daemon.registerModule({ setup: (seam) => { seam.registerFunctionalityAdapter({
        ...adapter,
        definitionSchema: {
            ...adapter.definitionSchema,
            properties: {
                kind: { enum: ["ok", "fail", "doc"] },
                args: { type: "array", items: { type: "string" } },
                env: { type: "object", additionalProperties: { type: "string" } },
            },
        },
        available: async () => [{ alias: "svc", definition: baseline, enabled: true }],
        prepare: async (input) => {
            prepared = input.enabled.get("svc")?.definition;
            return adapter.prepare(input);
        },
    }); } }, "test-module");
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const workspaceId = await insertWorkspace(db, "whole-definitions");
    const invoke = (verb: string, params = {}) => daemon.invokeModuleAction(`workspace.fx.${verb}`, params, workspaceContext(workspaceId));
    const listed = async () => (await invoke("list") as FunctionalityListResult).definitions;

    await invoke("disable", { alias: "svc" });
    baseline = { kind: "ok", args: ["changed-service-argument"], env: { SERVICE: "second" } };
    assert.deepEqual(await listed(), [{ alias: "svc", origin: "service", state: "disabled", definition: baseline }],
        "a local enabledness override still reads the current complete baseline");
    await invoke("enable", { alias: "svc" });
    assert.deepEqual(prepared, baseline, "preparation receives that same current definition");

    const previous = await listed();
    const invalid = await rejectedProblem(() => invoke("add", { alias: "svc", definition: { env: { LOCAL: "workspace" } } }));
    assert.equal(invalid.status, 400, "the required kind cannot be inherited to make an incomplete override valid");
    assert.equal(invalid.type, "https://problems.plurnk.xyz/functionality/arguments-invalid");
    assert.equal(invalid.detail, "fx add arguments do not match their schema.");
    assert.deepEqual(await listed(), previous, "invalid input leaves the previously published definition unchanged");

    const replacement = { kind: "doc", env: { LOCAL: "workspace" } };
    await invoke("add", { alias: "svc", definition: replacement });
    assert.deepEqual(prepared, replacement, "preparation inherits neither the omitted args nor nested SERVICE field");
    assert.deepEqual(await listed(), [{ alias: "svc", origin: "workspace", state: "active", definition: replacement }]);
    await invoke("disable", { alias: "svc" });
    baseline = { kind: "ok", args: ["another-service-argument"], env: { SERVICE: "third" } };
    await invoke("enable", { alias: "svc" });
    assert.deepEqual(prepared, replacement, "behavior changes cannot merge the later baseline into the local definition");

    const reassigned = { kind: "ok", args: ["local-argument"] };
    await invoke("replace", { alias: "svc", definition: reassigned });
    assert.deepEqual(prepared, reassigned, "replacement drops the old local env instead of patching the definition");
    assert.deepEqual(await listed(), [{ alias: "svc", origin: "workspace", state: "active", definition: reassigned }]);
});

for (const [label, inheritedEnabled] of [["enabled", true], ["disabled", false], ["absent", undefined]] as const) {
    test(`{§configuration-repair-path} removing an override restores the ${label} baseline without persisting a mask`, async (t) => {
        const db = await openMigrated();
        const adapter = fixtureAdapter([]);
        let baseline = inheritedEnabled === undefined ? [] : [{ alias: "svc", definition: { kind: "ok" }, enabled: inheritedEnabled }];
        const start = async () => {
            const instance = new Daemon({ db, provider: null });
            instance.registerModule({ setup: (seam) => { seam.registerFunctionalityAdapter({ ...adapter, available: async () => baseline }); } }, "test-module");
            await instance.start();
            return instance;
        };
        let daemon = await start();
        t.after(async () => { await daemon.stop(); await db.close(); });
        const workspaceId = await insertWorkspace(db, `inheritance-${String(inheritedEnabled)}`);
        const invoke = (verb: string, params = {}) => daemon.invokeModuleAction(`workspace.fx.${verb}`, params, workspaceContext(workspaceId));
        await invoke("add", { alias: "svc", definition: { kind: "doc" } });
        const removed = await invoke("remove", { alias: "svc" });
        assert.deepEqual(removed, {
            status: 200, family: "fx", alias: "svc", removed: true,
            ...(inheritedEnabled === undefined ? {} : {
                definition: { alias: "svc", origin: "service", state: inheritedEnabled ? "active" : "disabled", definition: { kind: "ok" } },
            }),
        }, "removal restores the complete inherited definition and its enabledness, or leaves no entry");

        await daemon.stop();
        baseline = [{ alias: "svc", definition: { kind: "doc" }, enabled: !inheritedEnabled }];
        daemon = await start();
        assert.deepEqual((await invoke("list") as FunctionalityListResult).definitions, [{
            alias: "svc", origin: "service", state: !inheritedEnabled ? "dormant" : "disabled", definition: { kind: "doc" },
        }], "restart follows later baseline changes instead of retaining a synthetic local overlay");
    });
}

test("{§configuration-repair-path} failed inherited preparation preserves the local definition and publication", async (t) => {
    const db = await openMigrated();
    const adapter = fixtureAdapter([]);
    let baseline = { kind: "ok" };
    const start = async () => {
        const instance = new Daemon({ db, provider: null });
        instance.registerModule({ setup: (seam) => { seam.registerFunctionalityAdapter({
            ...adapter, available: async () => [{ alias: "svc", definition: baseline, enabled: true }],
        }); } }, "test-module");
        await instance.start();
        return instance;
    };
    let daemon = await start();
    t.after(async () => { await daemon.stop(); await db.close(); });
    const workspaceId = await insertWorkspace(db, "failed-inheritance");
    const invoke = (verb: string, params = {}) => daemon.invokeModuleAction(`workspace.fx.${verb}`, params, workspaceContext(workspaceId));
    await invoke("add", { alias: "svc", definition: { kind: "doc" } });
    baseline = { kind: "fail" };
    const refused = await rejectedProblem(() => invoke("remove", { alias: "svc" }));
    assert.equal(refused.status, 502);
    assert.equal(refused.type, "https://problems.plurnk.xyz/fx/fixture/refused");
    assert.equal(refused.detail, "svc refused to prepare.");
    assert.deepEqual((await invoke("list") as FunctionalityListResult).definitions, [{
        alias: "svc", origin: "workspace", state: "active", definition: { kind: "doc" },
    }]);
    const result = await clientOperation(daemon, workspaceId, parseOne(PlurnkParser.frame("svc", "fixture")));
    assert.equal(result.status, 200, "the old capability remains callable after rejected restoration");
    await daemon.stop();
    daemon = await start();
    assert.deepEqual((await invoke("list") as FunctionalityListResult).definitions, [{
        alias: "svc", origin: "workspace", state: "dormant", definition: { kind: "doc" },
    }], "the local definition remains durable after rejected restoration");
});

test("{§module-workspace-residency} {§functionality-coordinator} registration, client lifecycle, documents, persistence, and shared visibility through one owner", async () => {
    const db = await openMigrated();
    const log: string[] = [];
    const workspaceId = await insertWorkspace(db, `functionality-${crypto.randomUUID()}`);
    let daemon = await boot(db, log);
    const model = await namedModelSession(daemon, workspaceId, "main");
    const invoke = <T>(verb: string, params: Readonly<Record<string, unknown>>): Promise<T> =>
        daemon.invokeModuleAction(`workspace.fx.${verb}`, params, workspaceContext(workspaceId)) as Promise<T>;
    const invocation = (tag: string) => parseOne(`\`\`\`\`${tag}
fixture
\`\`\`\``);
    // A person's operation ({§connection-lifecycle}), or one of the named session's own.
    const exec = (tag: string, sessionId?: number) => sessionId === undefined
        ? clientOperation(daemon, workspaceId, invocation(tag))
        : modelOperation(daemon, db, { workspaceId, sessionId, statement: invocation(tag) });
    const states = async () =>
        (await invoke<{ definitions: Array<{ alias: string; origin: string; state: string }> }>("list", {})).definitions
            .map(({ alias, origin, state }) => `${alias}:${origin}:${state}`);
    try {
        // Registration projects the shared workspace-scoped actions.
        assert.deepEqual(
            daemon.listModuleActions().map(({ name }) => name).filter((name) => name.startsWith("workspace.fx.")),
            ["workspace.fx.add", "workspace.fx.disable", "workspace.fx.discover", "workspace.fx.enable", "workspace.fx.list", "workspace.fx.remove", "workspace.fx.replace"],
        );
        assert.deepEqual(await states(), ["svc:service:dormant"]);
        assert.equal((await exec("svc")).status, 200, "the service definition's capability is published");
        assert.deepEqual(await states(), ["svc:service:active"], "execution activates the service default and manager");
        assert.equal((await exec("plurnk")).status, 400, "the manager runtime is published; a missing tool target is refused, not unknown");

        // add → active and hot.
        const added = await invoke<{ status: number; definition: { state: string } }>("add", { alias: "alpha", definition: { kind: "ok" } });
        assert.equal(added.status, 201);
        assert.equal(added.definition.state, "active");
        assert.deepEqual(await states(), ["alpha:workspace:active", "svc:service:active"]);
        assert.equal((await exec("alpha")).status, 200, "add hotloads the capability before the next operation");
        // discover is inert.
        const discovered = await invoke<{ candidates: Array<{ alias: string }> }>("discover", { query: "term" });
        assert.deepEqual(discovered.candidates.map(({ alias }) => alias), ["found-term"]);
        assert.deepEqual(await states(), ["alpha:workspace:active", "svc:service:active"], "discovery persisted nothing");
        // disable withdraws; enable restores.
        assert.equal((await invoke<{ definition: { state: string } }>("disable", { alias: "alpha" })).definition.state, "disabled");
        assert.equal((await exec("alpha")).status, 400, "a disabled definition is model-invisible: its name is just an unresolvable shell target");
        assert.deepEqual(await states(), ["alpha:workspace:disabled", "svc:service:active"]);
        assert.equal((await invoke<{ definition: { state: string } }>("enable", { alias: "alpha" })).definition.state, "active");
        assert.equal((await exec("alpha")).status, 200);
        // A failed client preparation rejects and persists nothing.
        const refused = await rejectedProblem(() => invoke("add", { alias: "broken", definition: { kind: "fail" } }));
        assert.equal(refused.status, 502);
        assert.deepEqual(await states(), ["alpha:workspace:active", "svc:service:active"]);
        // Collisions and unknown aliases are exact.
        assert.equal((await invoke<{ status: number }>("add", { alias: "alpha", definition: { kind: "ok" } })).status, 200,
            "the same workspace configuration may be reapplied by another client");
        assert.equal((await rejectedProblem(() => invoke("add", { alias: "alpha", definition: { kind: "doc" } }))).type, "https://problems.plurnk.xyz/functionality/alias-exists");
        assert.equal((await rejectedProblem(() => invoke("enable", { alias: "ghost" }))).type, "https://problems.plurnk.xyz/functionality/alias-unknown");
        // {§configuration-repair-path}
        assert.equal((await rejectedProblem(() => invoke("remove", { alias: "svc" }))).type, "https://problems.plurnk.xyz/functionality/alias-service-owned");
        assert.equal((await invoke<{ definition: { state: string } }>("disable", { alias: "svc" })).definition.state, "disabled");
        assert.equal((await exec("svc")).status, 400);
        assert.equal((await invoke<{ definition: { origin: string; state: string } }>("add", { alias: "svc", definition: { kind: "ok" } })).definition.origin, "workspace", "a workspace definition shadows the service baseline");
        assert.equal((await exec("svc")).status, 200);
        assert.equal((await invoke<{ removed: boolean }>("remove", { alias: "svc" })).removed, true);
        assert.deepEqual((await states()).filter((s) => s.startsWith("svc:")), ["svc:service:active"], "removal restores inherited enabledness");
        await invoke("disable", { alias: "svc" });
        // remove withdraws and forgets.
        const removed = await invoke<{ status: number; removed: boolean }>("remove", { alias: "alpha" });
        assert.equal(removed.status, 200);
        assert.equal(removed.removed, true);
        assert.deepEqual(await states(), ["svc:service:disabled"]);
        assert.equal((await exec("alpha")).status, 400);

        // Rollback: a publication the host refuses (a runtime name the base
        // registry already owns) aborts the preparation and changes nothing.
        log.length = 0;
        await assert.rejects(() => invoke("add", { alias: "sh", definition: { kind: "ok" } }), /sh|owner|collid|claim/i);
        assert.ok(log.some((entry) => entry.startsWith("abort:")), "the adapter aborted its prepared snapshot");
        assert.ok(!log.some((entry) => entry.startsWith("commit:")), "nothing was committed");
        assert.deepEqual(await states(), ["svc:service:disabled"], "durable state is unchanged after a failed publication");
        assert.equal((await exec("svc")).status, 400, "the previous snapshot remains authoritative");

        // A family's published documents reconcile with the snapshot under the generated subtree.
        await invoke("add", { alias: "docy", definition: { kind: "doc" } });
        await clientOperation(daemon, workspaceId, parseOne("````READ (workspace:///_plurnk/fx/docy.md)````"), model);
        const document = await db.test_entries_by_coordinate_workspaces.all<{ workspace_id: number; content: string }>({ scheme: "workspace", authority: "", pathname: "/_plurnk/fx/docy.md" });
        assert.deepEqual(document.map(({ workspace_id }) => workspace_id), [workspaceId], "both active readers use one shared published document");
        for (const { content } of document) assert.match(content, /fixture document/);
        await invoke("remove", { alias: "docy" });
        assert.deepEqual(await db.test_entries_by_coordinate_workspaces.all({ scheme: "workspace", authority: "", pathname: "/_plurnk/fx/docy.md" }), [], "removal withdraws the document");

        // Persistence: a workspace-origin definition and a service enabledness survive restart.
        await invoke("add", { alias: "keep", definition: { kind: "ok" } });
        await daemon.stop();
        log.length = 0;
        daemon = await boot(db, log);
        assert.deepEqual(await states(), ["keep:workspace:dormant", "svc:service:disabled"], "inspection preserves dormant definitions after restart");
        assert.equal((await exec("keep")).status, 200);
        assert.deepEqual(await states(), ["keep:workspace:active", "svc:service:disabled"], "execution reconstructs the workspace's Functionality");
        assert.ok(log.includes("prepare:keep"), "activation prepared exactly the enabled set");

        // Delegates use the same workspace environment, including subsequent changes.
        const child = await insertSession(db, workspaceId, model, "child", "model");
        assert.equal((await exec("keep", child)).status, 200);
        await invoke("add", { alias: "later", definition: { kind: "ok" } });
        assert.deepEqual(await states(), ["keep:workspace:active", "later:workspace:active", "svc:service:disabled"]);
        assert.equal((await exec("later", child)).status, 200, "an existing child sees the workspace change");
        await invoke("disable", { alias: "keep" });
        assert.equal((await exec("keep", child)).status, 400, "withdrawal applies to an existing child");
        assert.deepEqual(await states(), ["keep:workspace:disabled", "later:workspace:active", "svc:service:disabled"]);
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§functionality-coordinator} a failed publication restores state, runtime selection, and every generated document", async (t) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `publication-rollback-${crypto.randomUUID()}`);
    const log: string[] = [];
    const daemon = await boot(db, log);
    t.after(async () => { await daemon.stop(); await db.close(); });
    await clientOperation(daemon, workspaceId, parseOne("````READ (workspace:///_plurnk/tools/plurnk/fx.json) <1,-1>````"));
    const materialize = LoopDocs.materialize;
    const cause = new Error("fixture document publication failed");
    let failed = false;
    t.mock.method(LoopDocs, "materialize", async (...args: Parameters<typeof LoopDocs.materialize>) => {
        if (!failed) { failed = true; throw cause; }
        await materialize(...args);
    });
    const mark = log.length;
    await assert.rejects(() => daemon.invokeModuleAction("workspace.fx.add", {
        alias: "docy", definition: { kind: "doc" },
    }, workspaceContext(workspaceId)), (error) => error === cause);
    const events = log.slice(mark).filter((event) => /^(publish|undo|commit|abort):/u.test(event));
    assert.deepEqual(events.map((event) => event.split(":")[0]), ["publish", "undo", "abort"],
        "the candidate went live at publish, its undo ran with the registry rollback, and it was aborted unpublished; nothing committed");
    const list = await daemon.invokeModuleAction("workspace.fx.list", {}, workspaceContext(workspaceId)) as {
        definitions: Array<{ alias: string }>;
    };
    assert.deepEqual(list.definitions.map(({ alias }) => alias), ["svc"]);
    assert.equal(daemon.schemes.has("docy", workspaceId), false);
    assert.deepEqual(await db.test_entries_by_coordinate_workspaces.all({
        scheme: "workspace", authority: "", pathname: "/_plurnk/fx/docy.md",
    }), [], "rollback cannot leave a document from the rejected workspace snapshot");
});

test("{§functionality-coordinator} a candidate goes live at publish, inside the registry commit, and commits after it", async (t) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `publication-order-${crypto.randomUUID()}`);
    const log: string[] = [];
    const daemon = await boot(db, log);
    t.after(async () => { await daemon.stop(); await db.close(); });
    await clientOperation(daemon, workspaceId, parseOne("````READ (workspace:///_plurnk/tools/plurnk/fx.json) <1,-1>````"));
    const mark = log.length;
    await daemon.invokeModuleAction("workspace.fx.add", { alias: "late", definition: { kind: "ok" } }, workspaceContext(workspaceId));
    const events = log.slice(mark).filter((event) => /^(publish|undo|commit|abort):/u.test(event));
    assert.deepEqual(events.map((event) => event.split(":")[0]), ["publish", "commit"], "publish precedes commit; no undo, no abort");
    assert.equal(events[0].split(":")[1], events[1].split(":")[1], "both phases belong to the same candidate");
});

test("{§functionality-coordinator} a management stream reports publication refusal instead of premature success", { timeout: 30_000 }, async (t) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `publication-result-${crypto.randomUUID()}`);
    const log: string[] = [];
    const daemon = await boot(db, log);
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.invokeModuleAction("workspace.fx.enable", { alias: "svc" }, workspaceContext(workspaceId));
    const refused = Results.failure("fx:fixture", "publication-refused", 409, "Fixture publication refused.", {}, { retryable: true });
    t.mock.method(daemon, "replaceWorkspaceCapabilities", async () => {
        throw new OperationFailureError(structuredClone(refused));
    }, { times: 1 });
    const result = await clientOperation(daemon, workspaceId, parseOne("````plurnk (fx)\n{\"verb\":\"add\",\"alias\":\"candidate\",\"definition\":{\"kind\":\"ok\"}}\n````"));
    assert.equal(result.status, 409, "the operation itself reports publication failure");
    assert.deepEqual(await awaitExecOutcome(db, { workspaceId, scheme: "plurnk" }), refused,
        "the invoking stream carries the exact refused publication, not an active definition");
    assert.equal(log.filter((line) => line === "abort:candidate,svc").length, 1);
    const listing = await daemon.invokeModuleAction("workspace.fx.list", {}, workspaceContext(workspaceId)) as {
        definitions: Array<{ alias: string }>;
    };
    assert.deepEqual(listing.definitions.map(({ alias }) => alias), ["svc"]);
    assert.equal(daemon.schemes.has("candidate", workspaceId), false);
});

for (const verb of ["add", "replace"]) for (const hold of ["", "plurnk:host"]) {
    test(`{§functionality-model-projection} a model uses its ${verb} tool with execution hold ${hold || "disabled"}`, { timeout: 30_000 }, async (approvalContext) => {
        serverProposals(approvalContext, "accept");
        const priorHold = process.env.PLURNK_SERVICE_EXEC_HOLD;
        process.env.PLURNK_SERVICE_EXEC_HOLD = hold;
        const alias = verb === "add" ? "candidate" : "svc";
        const step = (op = "NOTE") => PlurnkParser.frame(op, op === "NOTE" ? "Inspect the result." : "Tool result inspected.");
        const provider = new Mock({ contextWindow: 1_000_000, responses: [
            makeMockResponse(`${PlurnkParser.frame("plurnk (fx)", JSON.stringify({ verb, alias, definition: { kind: "doc" } }))}\n${step("NOTE")}`),
            makeMockResponse(`${PlurnkParser.frame(alias, "fixture")}\n${step("NOTE")}`),
            makeMockResponse(step("SEND [200]")),
        ] });
        const db = await openMigrated();
        const log: string[] = [];
        const daemon = new Daemon({ db, provider });
        daemon.registerModule({ setup: (seam) => { seam.registerFunctionalityAdapter(fixtureAdapter(log)); } }, "test-module");
        const ws = await connect({ daemon });
        try {
            await daemon.start();
            await rpcCall(ws, 1, "workspace.create", { name: `model-publication-${crypto.randomUUID()}` });
            const result = await runLoopToTerminal(ws, 2, { prompt: `${verb} and use the ${alias} fixture tool.` });
            assert.equal(result.finalStatus, 200, JSON.stringify(result.result));
            assert.equal(log.filter((line) => line === `run:${alias}`).length, 1,
                "the next model turn executes the newly published tool, including under hold-until-concluded");
        } finally {
            ws.close();
            await daemon.stop();
            await db.close();
            if (priorHold === undefined) delete process.env.PLURNK_SERVICE_EXEC_HOLD;
            else process.env.PLURNK_SERVICE_EXEC_HOLD = priorHold;
        }
    });
}

test("{§functionality-model-projection} authorization-required holds the model mutation at the workspace boundary until resolved", { timeout: 15_000 }, async (t) => {
    serverProposals(t, "accept");
    const priorHold = process.env.PLURNK_SERVICE_EXEC_HOLD;
    process.env.PLURNK_SERVICE_EXEC_HOLD = "plurnk:host";
    t.after(() => { if (priorHold === undefined) delete process.env.PLURNK_SERVICE_EXEC_HOLD; else process.env.PLURNK_SERVICE_EXEC_HOLD = priorHold; });
    const log: string[] = [];
    const provider = new Mock({ contextWindow: 1_000_000, responses: [
        makeMockResponse(PlurnkParser.frame("plurnk (fx)", JSON.stringify({ verb: "add", alias: "candidate", definition: { kind: "auth" } }))),
        makeMockResponse(PlurnkParser.frame("candidate", "fixture")),
        makeMockResponse(PlurnkParser.frame("SEND [200]", "The candidate ran after sign-in.")),
    ] });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider });
    daemon.registerModule({ setup: (seam) => { seam.registerFunctionalityAdapter(fixtureAdapter(log)); } }, "test-module");
    const ws = await connect({ daemon });
    try {
        await daemon.start();
        const created = await rpcCall(ws, 1, "workspace.create", { name: `authorization-result-${crypto.randomUUID()}` });
        const workspaceId = (created.result as { id: number }).id;
        const notices: Array<{ kind?: string; message?: string }> = [];
        const unsubscribe = daemon.subscribeToEvents((eventWorkspaceId, method, params) => {
            if (eventWorkspaceId !== workspaceId || method !== "notice/event") return;
            const notice = (params as { notice?: { kind?: string; message?: string } }).notice;
            if (notice?.kind === "authorization_required") {
                notices.push(notice);
                void daemon.invokeModuleAction("workspace.fx.replace", { alias: "candidate", definition: { kind: "ok" } }, workspaceContext(workspaceId));
            }
        });
        t.after(unsubscribe);
        const result = await runLoopToTerminal(ws, 2, { prompt: "Add and run the candidate fixture." }, { timeoutMs: 8_000 });
        assert.equal(result.finalStatus, 200, JSON.stringify(result.result));
        assert.equal(notices.length, 1, "the sign-in requirement is announced while the mutation holds");
        assert.equal(log.filter((line) => line === "run:candidate").length, 1, "the next model turn runs the newly authorized tool");
        assert.ok(result.modelSessionId !== undefined, "the loop identifies its model session");
        const rows = await daemon.readLog({ workspaceId, sessionId: result.modelSessionId, limit: Number.MAX_SAFE_INTEGER });
        const observed = rows.find((row) => row.op === "READ" && row.scheme === "plurnk" && JSON.stringify(row.rx).includes("active"));
        assert.ok(observed, "the terminal observation carries the settled active resource outcome");
        assert.equal(observed.status_rx, 201, "the observation carries the settled creation status");
        const body = await awaitExecOutcome(db, { workspaceId, scheme: "plurnk" });
        assert.equal(body.status, 201, "creation status survives inside the settled result body");
    } finally { ws.close(); await daemon.stop(); await db.close(); }
});

test("{§functionality-model-projection} {§proposal-disposition} management verbs retain ordinary approval and report their settled result", async (t) => {
    const db = await openMigrated();
    const log: string[] = [];
    const workspaceId = await insertWorkspace(db, `functionality-exec-${crypto.randomUUID()}`);
    const daemon = await boot(db, log);
    const states = async () =>
        (await daemon.invokeModuleAction("workspace.fx.list", {}, workspaceContext(workspaceId)) as { definitions: Array<{ alias: string; state: string; problem?: ProblemDetails }> }).definitions;
    const operate = (program: string) => clientOperation(daemon, workspaceId, parseOne(program));
    // A family verb streams its JSON outcome into the Session's plurnk:// output
    // entry; dispatch awaits the management result ({§functionality-model-projection}).
    const verbResult = () => awaitExecOutcome(db, { workspaceId, scheme: "plurnk" });
    const proposals: Array<{ logEntryId: number; disposition: unknown }> = [];
    const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => {
        if (method === "loop/proposal") proposals.push(params as { logEntryId: number; disposition: unknown });
    });
    // A host verb proposes, and under server review the person's operation settles at once: nobody resolves it.
    const proposed = async (program: string) => {
        const seen = proposals.length;
        const result = await operate(program);
        assert.equal(proposals.length, seen + 1, "the host verb proposed");
        assert.deepEqual(proposals[seen].disposition, { decision: "accept", outcome: "client_operation" });
        return result;
    };
    try {
        // read verbs run ungated.
        const listed = await operate("````plurnk (fx)````");
        assert.equal(listed.status, 200, "list is a read effect and starts ungated");
        assert.equal(proposals.length, 0, "no proposal was raised for a read verb");
        const listing = await verbResult();
        assert.equal((listing as { family?: string }).family, "fx", "the verb's JSON result streams into the family's output entry");

        // An accepted host verb runs the same coordinator method and the capability is live
        // before the next operation.
        const added = await proposed("````plurnk (fx)\n{\"verb\":\"add\",\"alias\":\"viaexec\",\"definition\":{\"kind\":\"ok\"}}\n````");
        assert.equal(added.status, 201, "the accepted add reports its completed creation");
        assert.equal((await operate("```viaexec\nfixture\n```")).status, 200, "publication settled before the next operation");
        assert.deepEqual((await states()).map(({ alias, state }) => `${alias}:${state}`), ["svc:active", "viaexec:active"]);

        // An operation's failed preparation publishes enabled-but-unavailable with its Problem.
        const down = await proposed("````plurnk (fx)\n{\"verb\":\"add\",\"alias\":\"down\",\"definition\":{\"kind\":\"fail\"}}\n````");
        assert.equal(down.status, 201, "the definition is created; its body reports unavailability");
        await operate("````plurnk (fx)````");
        const downState = (await states()).find(({ alias }) => alias === "down");
        assert.equal(downState?.state, "unavailable");
        assert.equal(downState?.problem?.status, 502, "the enabled definition keeps its exact Problem");

        // Rejection performs nothing: no preparation, no state. The server's reject applies to a person's operation too.
        serverProposals(t, "reject");
        log.length = 0;
        const rejected = await operate("````plurnk (fx)\n{\"verb\":\"add\",\"alias\":\"nope\",\"definition\":{\"kind\":\"ok\"}}\n````");
        assert.equal(rejected.status, 400);
        assert.equal(log.some((entry) => entry.startsWith("prepare:") && entry.includes("nope")), false, "a rejected proposal never prepares");
        assert.equal((await states()).some(({ alias }) => alias === "nope"), false);

        // An unregistered tool is refused by the plurnk runtime; an unregistered verb is refused by the family schema.
        assert.equal((await operate("```plurnk (destroy)```")).status, 404, "an unregistered tool is refused with the tool list");
        assert.equal((await operate("````plurnk (fx)\n{\"verb\":\"destroy\"}\n````")).status, 400, "an unregistered verb is refused by the family schema");

    } finally {
        unsubscribe();
        await daemon.stop();
        await db.close();
    }
});

// {§tools-resource-materialization} — a family the effective policy denies is a door the model is never shown:
// no tool schema, no generated document, and its tool refuses at admission (#842).
test("{§tools-resource-materialization} {§capability-admission}: a denied family has no schema, no generated document and no runnable tool", async () => {
    const db = await openMigrated();
    const log: string[] = [];
    const workspaceId = await insertWorkspace(db, `fx-denied-${crypto.randomUUID()}`);
    const daemon = await boot(db, log);
    const operate = (program: string) => clientOperation(daemon, workspaceId, parseOne(program));
    try {
        await daemon.invokeModuleAction("workspace.fx.add", { alias: "paper", definition: { kind: "doc" } }, workspaceContext(workspaceId));
        const shown = await daemon.engine.referenceEntries(workspaceId);
        assert.ok(shown.some(({ pathname }) => pathname === "/_plurnk/tools/plurnk/fx.json"), "the family tool schema is surveyed while the family is admitted");
        assert.ok(shown.some(({ pathname }) => pathname === "/_plurnk/fx/paper.md"), "the family's generated document is surveyed while the family is admitted");
        await db.test_set_workspace_settings.run({ id: workspaceId, settings: JSON.stringify({ capabilities: { deny: [{ operation: "plurnk", tool: "fx" }] } }) });
        const hidden = await daemon.engine.referenceEntries(workspaceId);
        assert.equal(hidden.some(({ pathname }) => pathname === "/_plurnk/tools/plurnk/fx.json"), false, "a denied family has no tool schema");
        assert.equal(hidden.some(({ pathname }) => pathname === "/_plurnk/fx/paper.md"), false, "a denied family projects no generated document");
        assert.equal(hidden.some(({ pathname }) => pathname === "/_plurnk/plurnk/session.md"), true, "other references are untouched");
        assert.equal((await operate("```plurnk (fx)```")).status, 403, "the family's tool refuses at admission");
    } finally {
        await daemon.stop();
        await db.close();
    }
});
});
