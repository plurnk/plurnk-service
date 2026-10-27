import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Daemon from "../../src/server/Daemon.ts";
import Results, { OperationFailureError } from "../../src/core/results.ts";
import LoopDocs from "../../src/server/loopDocs.ts";
import WorkspaceGate from "../../src/core/WorkspaceGate.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import HostPaths from "../../src/core/HostPaths.ts";
import { TEST_OWNER, serverProposals, ownSession } from "./_approval.ts";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PlurnkParser, parsePath } from "@plurnk/plurnk-parser";
import { Problems, type FunctionalityFamilyHandle, type FunctionalityListResult, type FunctionalityOutcome, type FunctionalityProvenance, type PlurnkStatement, type ProblemDetails, type FunctionalityDiscoverResult, type FunctionalityMutationResult, Validator } from "@plurnk/plurnk-contracts";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import { type RuntimeRegistration, type Executor } from "@plurnk/plurnk-execs";
import { type HostFunctionalityAdapter, type HostSetupSeam } from "../../src/server/ModuleHost.ts";
import { awaitExecOutcome } from "./_execs.ts";
import { fixtureExecutors, makeMockResponse, makeRawMockResponse } from "./_mock.ts";
import { insertWorkspace, insertSession, openMigrated } from "./_db.ts";
import { type Db } from "../../src/core/Db.ts";
import { connect, rpcCall, runLoopToTerminal, waitForDb, waitFor } from "./_rpc.ts";
import { modelOperation, namedModelSession } from "./_sessions.ts";
import { Digest } from "@plurnk/plurnk-digest";
import { copyStmt, editStmt, findStmt, killStmt, readStmt, regex } from "./_dsl.ts";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { type AddressInfo } from "node:net";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { viableWindow } from "./_provider.ts";
import { parseLogRecords } from "../LogRecords.ts";
import { mcpEnvironment, stdioEntry, MCP_CONTROLS, httpEntry, mcpFixture } from "./_mcp-config.ts";
import { McpServer, createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";

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

test("{§functionality-preparation-cancellation} cancelling an operation joins preparation and leaves no later publication", { timeout: 15_000 }, async (t) => {
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

describe("env-functionality", () => {
// {§functionality-coordinator} {§env-functionality} — the environment family beneath the shared
// coordinator, registered by Core. Session-scoped client actions, one durable value per session, and
// the model's manager bound to the invoking session: the shared verbs, acting for one session.



















const VERBS = ["add", "disable", "discover", "enable", "list", "remove", "replace"];

for (const scope of ["session", "workspace"] as const) {
    test(`{§functionality-model-projection} ${scope} env admission precedes the next shell invocation`, { timeout: 15_000 }, async (t) => {
        serverProposals(t, "accept");
        const db = await openMigrated();
        const provider = new Mock({ contextWindow: 1_000_000, responses: [
            makeRawMockResponse([
                PlurnkParser.frame("plurnk (env)", JSON.stringify({ verb: "add", scope, alias: "SETTLEMENT_WITNESS", definition: { value: "settled" } })),
                PlurnkParser.frame("sh", 'printf "%s" "$SETTLEMENT_WITNESS"'),
                PlurnkParser.frame("NOTE", "Review the shell output."),
            ].join("\n\n")),
            makeRawMockResponse(PlurnkParser.frame("SEND [200]", "Finished.")),
        ] });
        const daemon = new Daemon({ db, provider });
        t.after(async () => { await daemon.stop(); await db.close(); });
        await daemon.start();
        const { workspaceId } = await daemon.createWorkspace({ name: `env-ordered-${scope}` });
        const sessionId = await insertSession(db, workspaceId, null, "reader", "model");
        const loop = await daemon.runLoop({ workspaceId, sessionId, prompt: "Configure the witness and print it.", maxTurns: 2 });
        const lifecycle = new LoopLifecycle(db);
        await waitForDb(() => lifecycle.status(loop.loopId), (status) => status !== null && status >= 200);
        const rows = await daemon.readLog({ workspaceId, sessionId, limit: Number.MAX_SAFE_INTEGER });
        assert.equal(rows.find((row) => row.origin === "model" && row.op === "plurnk")?.status_rx, 201);
        assert.ok(rows.some((row) => row.op === "READ" && row.scheme === "sh" && row.status_rx === 200 && JSON.stringify(row.rx).includes("settled")), "the command receives the just-published environment value");
    });
}

const parseOne = (input: string): PlurnkStatement => {
    const parsed = PlurnkParser.parseStatements(input, { executors: fixtureExecutors(input) });
    const item = parsed.items.find((x) => x.kind === "statement");
    if (item?.kind !== "statement") throw new Error(`no statement parsed from ${input}`);
    return item.statement;
};

const valueOf = (definition: object | undefined): string => {
    assert.ok(definition !== undefined && "value" in definition && typeof definition.value === "string", "an env definition carries a string value");
    return definition.value;
};

// A refusal is the verb's own operation result — the one shape the client action layer and the
// model's manager both convert — never a thrown fault.
const refusal = async (run: () => Promise<unknown>): Promise<string> => {
    try {
        await run();
    } catch (cause) {
        assert.ok(cause instanceof OperationFailureError, `a refusal is an operation result, not ${String(cause)}`);
        return cause.result.problem.type;
    }
    throw new Error("expected a refusal");
};

// The root node_modules holds the workspace packages, so `discover` can read a sibling's declarations.
const boot = async (db: Db): Promise<Daemon> => {
    const daemon = new Daemon({ db, provider: null, nodeModulesPath: resolve("..", "node_modules") });
    await daemon.start();
    return daemon;
};

test("{§functionality-coordinator} env projects session-scoped actions; its state belongs to one session and its manager acts for the invoking session", async () => {
    const previousInherit = process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT;
    process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = "PATH,HOME,ENV_WITNESS";
    process.env.ENV_WITNESS = "ambient";
    const scratch = await mkdtemp(join(tmpdir(), "plurnk-env-family-"));
    const dbPath = join(scratch, "plurnk.db");
    const db = await openMigrated(dbPath);
    let daemon = await boot(db);
    let quiescent = false;
    try {
        const workspaceId = await insertWorkspace(db, `env-family-${crypto.randomUUID()}`);
        const alice = await insertSession(db, workspaceId, null, "alice", "model");
        await ownSession(db, workspaceId, alice);
        const bob = await insertSession(db, workspaceId, null, "bob", "model");
        await ownSession(db, workspaceId, bob);
        const invoke = <T>(sessionId: number, verb: string, params: Readonly<Record<string, unknown>> = {}): Promise<T> =>
            daemon.invokeModuleAction(`session.env.${verb}`, params, { scope: "session", workspaceId, sessionId }) as Promise<T>;
        const listed = async (sessionId: number) => (await invoke<FunctionalityListResult>(sessionId, "list")).definitions;
        const stateOf = async (sessionId: number, alias: string): Promise<string | undefined> => {
            const definition = (await listed(sessionId)).find((entry) => entry.alias === alias);
            return definition === undefined ? undefined : `${definition.origin}:${definition.state}`;
        };

        // Both scopes use the same verbs; the action context binds their owner.
        assert.deepEqual(
            daemon.listModuleActions().filter(({ name }) => name.includes(".env.")).map(({ name, scope }) => `${name}:${scope}`),
            ["session", "workspace"].flatMap((scope) => VERBS.map((verb) => `${scope}.env.${verb}:${scope}`)),
        );

        // The service baseline is what the ceiling admits, with its value, under the shell's alias grammar.
        assert.equal(await stateOf(alice, "PATH"), "service:active", "an uppercase name is an alias for this family");
        assert.equal(await stateOf(alice, "ENV_WITNESS"), "service:active");
        assert.equal(valueOf((await listed(alice)).find((entry) => entry.alias === "ENV_WITNESS")?.definition), "ambient");
        assert.deepEqual((await listed(alice)).find((entry) => entry.alias === "ENV_WITNESS")?.provenance,
            { kind: "environment", source: "ENV_WITNESS" });

        // add → session origin, active, for alice alone.
        const added = await invoke<FunctionalityMutationResult>(alice, "add", { alias: "CARGO_TARGET_DIR", definition: { value: "/tmp/shared" } });
        assert.equal(added.status, 201);
        assert.equal(added.definition?.origin, "session", "origin names ownership: alice set it, not the workspace");
        assert.equal(added.definition?.state, "active");
        assert.equal(await stateOf(bob, "CARGO_TARGET_DIR"), undefined, "a sibling sees nothing of it");

        // disable masks an ambient name for alice alone; enable restores it.
        assert.equal((await invoke<FunctionalityMutationResult>(alice, "disable", { alias: "ENV_WITNESS" })).definition?.state, "disabled");
        assert.equal(await stateOf(bob, "ENV_WITNESS"), "service:active", "the sibling's ambient name is untouched");
        assert.equal((await invoke<FunctionalityMutationResult>(alice, "enable", { alias: "ENV_WITNESS" })).definition?.state, "active");
        assert.equal((await invoke<FunctionalityMutationResult>(alice, "disable", { alias: "ENV_WITNESS" })).definition?.state, "disabled");

        // Admission refusals are the verb's own outcome: a name a shell cannot export, and plurnk's own.
        assert.equal(await refusal(() => invoke(alice, "add", { alias: "9NOPE", definition: { value: "x" } })), "https://problems.plurnk.xyz/env/functionality/name-invalid");
        assert.equal(await refusal(() => invoke(alice, "add", { alias: "PLURNK_SERVICE_DB_PATH", definition: { value: "/tmp/steal.db" } })), "https://problems.plurnk.xyz/env/functionality/name-reserved");
        assert.equal(await refusal(() => invoke(alice, "enable", { alias: "GHOST" })), "https://problems.plurnk.xyz/functionality/alias-unknown");

        // {§configuration-repair-path}
        assert.equal(await refusal(() => invoke(alice, "remove", { alias: "ENV_WITNESS" })), "https://problems.plurnk.xyz/functionality/alias-service-owned");
        const shadow = await invoke<FunctionalityMutationResult>(alice, "add", { alias: "ENV_WITNESS", definition: { value: "mine" } });
        assert.equal(shadow.definition?.origin, "session");
        assert.equal(shadow.definition?.provenance, undefined, "a session's override is not the ambient configuration");
        assert.equal(valueOf(shadow.definition?.definition), "mine");
        assert.equal((await invoke<FunctionalityMutationResult>(alice, "remove", { alias: "ENV_WITNESS" })).removed, true);
        assert.equal(await stateOf(alice, "ENV_WITNESS"), "service:active", "removal restores inherited enabledness");
        assert.deepEqual((await listed(alice)).find((entry) => entry.alias === "ENV_WITNESS")?.provenance,
            { kind: "environment", source: "ENV_WITNESS" });
        assert.equal(valueOf((await listed(alice)).find((entry) => entry.alias === "ENV_WITNESS")?.definition), "ambient");
        await invoke(alice, "disable", { alias: "ENV_WITNESS" });

        // remove forgets a session entry; discover is inert and reads a sibling package's declaration.
        assert.equal((await invoke<FunctionalityMutationResult>(alice, "remove", { alias: "CARGO_TARGET_DIR" })).removed, true);
        assert.equal(await stateOf(alice, "CARGO_TARGET_DIR"), undefined);
        const discovered = await invoke<FunctionalityDiscoverResult>(alice, "discover", { query: "PAGER" });
        assert.equal(discovered.candidates.find(({ alias }) => alias === "PAGER")?.provenance.source, "@plurnk/plurnk-execs");
        assert.equal(await stateOf(alice, "PAGER"), undefined, "discovery persisted nothing");
        // {§functionality-replacement} A request naming no input is the whole catalog; a client's
        // own configuration is no input, refused by the shared schema check.
        const catalog = (await invoke<FunctionalityDiscoverResult>(alice, "discover", {})).candidates;
        assert.ok(catalog.some(({ alias }) => alias === "PAGER"), "the empty request lists the catalog");
        assert.ok(catalog.length > discovered.candidates.length, "the whole catalog, not a query's matches");
        assert.equal(await refusal(() => invoke(alice, "discover", { configuration: {} })), "https://problems.plurnk.xyz/functionality/arguments-invalid");
        assert.equal(await refusal(() => invoke(alice, "discover", { source: ".env" })), "https://problems.plurnk.xyz/env/functionality/source-unknown");
        assert.deepEqual((await invoke<FunctionalityDiscoverResult>(alice, "discover", {
            source: "@plurnk/plurnk-execs", query: "no-such-catalog-name",
        })).candidates, []);

        // Persistence: alice's shaping survives a restart; bob's is untouched.
        await invoke(alice, "add", { alias: "CARGO_TARGET_DIR", definition: { value: "/tmp/shared" } });
        await daemon.stop();
        daemon = await boot(db);
        assert.equal(await stateOf(alice, "CARGO_TARGET_DIR"), "session:active");
        assert.equal(await stateOf(alice, "ENV_WITNESS"), "service:disabled");
        assert.equal(await stateOf(bob, "ENV_WITNESS"), "service:active");
        assert.equal(await stateOf(bob, "CARGO_TARGET_DIR"), undefined);

        // Inheritance: a child of alice starts with her entries, each named for her; the child's own
        // entries carry no such name, and touching an inherited entry makes it the child's own.
        const carol = await insertSession(db, workspaceId, alice, "carol", "model");
        const inheritedOf = async (sessionId: number, alias: string) => (await listed(sessionId)).find((entry) => entry.alias === alias)?.inherited;
        assert.equal(await stateOf(carol, "CARGO_TARGET_DIR"), "session:active");
        assert.equal(await inheritedOf(carol, "CARGO_TARGET_DIR"), "alice", "list names the Session that set an inherited value");
        assert.equal(await stateOf(carol, "ENV_WITNESS"), "service:disabled", "a parent's masking of an ambient name travels too");
        assert.equal(await inheritedOf(carol, "ENV_WITNESS"), "alice");
        await invoke(carol, "add", { alias: "CAROL_ONLY", definition: { value: "c" } });
        assert.equal(await inheritedOf(carol, "CAROL_ONLY"), undefined, "an entry the child set itself names no source");
        await invoke(carol, "enable", { alias: "ENV_WITNESS" });
        assert.equal(await inheritedOf(carol, "ENV_WITNESS"), undefined, "a changed entry is the child's own");
        assert.equal(await stateOf(alice, "ENV_WITNESS"), "service:disabled", "the child's change never reaches the parent");
        assert.equal(await stateOf(alice, "CAROL_ONLY"), undefined);

        // The model's projection: `plurnk (env)` is published on the `plurnk` manager, and Core binds it to the invoking
        // session at the operation, so alice's `list` is alice's and bob's is bob's.
        const outputs = async (): Promise<number> =>
            (await db.test_entries_by_scheme_prefix.all<{ pathname: string }>({ workspace_id: workspaceId, scheme: "plurnk", prefix: "/%" })).length;
        const exec = async (sessionId: number, program: string) => {
            const after = await outputs();
            const { status } = await modelOperation(daemon, db, { workspaceId, sessionId, statement: parseOne(program) });
            return { status, result: () => awaitExecOutcome(db, { workspaceId, scheme: "plurnk", after, timeoutMs: 10_000 }) };
        };
        const aliceList = await exec(alice, "````plurnk (env)````");
        assert.equal(aliceList.status, 200);
        const aliceView = await aliceList.result() as unknown as FunctionalityListResult;
        assert.equal(aliceView.definitions.find(({ alias }) => alias === "CARGO_TARGET_DIR")?.origin, "session");
        assert.equal(aliceView.definitions.find(({ alias }) => alias === "ENV_WITNESS")?.state, "disabled");
        const bobView = await (await exec(bob, "````plurnk (env)````")).result() as unknown as FunctionalityListResult;
        assert.equal(bobView.definitions.some(({ alias }) => alias === "CARGO_TARGET_DIR"), false, "the binding is per operation: bob's list is bob's");
        assert.equal(bobView.definitions.find(({ alias }) => alias === "ENV_WITNESS")?.state, "active");

        // A host verb proposes; acceptance persists for the invoking session and no other. Then the
        // spawn ({§execution-output-identity}): what alice set reaches alice's next command, bob's command sees
        // his own entry and the untouched ceiling — a registry, not a prefix.
        const proposals: number[] = [];
        const unsubscribe = daemon.subscribeToEvents((_workspace, method, params) => {
            if (method === "loop/proposal") proposals.push((params as { logEntryId: number }).logEntryId);
        });
        const accepted = async (sessionId: number, program: string): Promise<{ status: number; logEntryId: number }> => {
            const seen = proposals.length;
            const pending = modelOperation(daemon, db, { workspaceId, sessionId, statement: parseOne(program) });
            await waitFor(() => proposals, (list) => list.length > seen, { timeoutMs: 10_000 });
            const logEntryId = proposals[seen];
            await daemon.resolveProposal(logEntryId, { decision: "accept" }, { workspaceId, address: TEST_OWNER });
            return { status: (await pending).status, logEntryId };
        };
        const stdoutOf = async (logEntryId: number): Promise<string> => {
            const content = await waitForDb<string | null>(async () => {
                const log = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
                const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname?: string };
                if (pathname === undefined) return null;
                const entry = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "sh", pathname });
                if (entry === undefined) return null;
                const channel = await db.test_get_channel.get<{ content: string; state: string }>({ entry_id: entry.id, name: "stdout" });
                return channel?.state === "closed" ? channel.content : null;
            }, (value) => value !== null, { timeoutMs: 10_000 });
            return content!;
        };
        try {
            const before = await outputs();
            const bobAdded = await accepted(bob, `\`\`\`\`plurnk (env)\n${JSON.stringify({ verb: "add", alias: "BOB_ONLY", definition: { value: "1" } })}\n\`\`\`\``);
            assert.equal(bobAdded.status, 201, "the accepted add settled inside the operation");
            const outcome = await awaitExecOutcome(db, { workspaceId, scheme: "plurnk", after: before, timeoutMs: 10_000 }) as unknown as FunctionalityMutationResult;
            assert.equal(outcome.definition?.origin, "session");
            assert.equal(await stateOf(bob, "BOB_ONLY"), "session:active", "an accepted model add persisted for the invoking session");
            assert.equal(await stateOf(alice, "BOB_ONLY"), undefined);

            const command = "````sh\necho \"target=[$CARGO_TARGET_DIR] witness=[$ENV_WITNESS] bob=[$BOB_ONLY]\"\n````";
            // The record lives on the spawn's output entry ({§execution-output-identity}), never on the
            // model's own log row.
            const recorded = async (logEntryId: number) => {
                const log = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
                const { pathname } = JSON.parse(log!.attrs) as { pathname: string };
                const output = await db.crud_find_workspace_entry.get<{ attributes: string }>({ workspace_id: workspaceId, scheme: "sh", authority: "", pathname });
                return (JSON.parse(output!.attributes) as { env: Record<string, { source: string; from?: string; value?: string }> }).env;
            };
            const aliceRun = await accepted(alice, command);
            assert.match(await stdoutOf(aliceRun.logEntryId), /target=\[\/tmp\/shared\] witness=\[\] bob=\[\]/,
                "alice's command receives what she set and not the ambient name she disabled");
            const bobRun = await accepted(bob, command);
            assert.match(await stdoutOf(bobRun.logEntryId), /target=\[\] witness=\[ambient\] bob=\[1\]/,
                "bob's command receives his own entry and the untouched ceiling");

            // The spawn records what it received, name by name with provenance, on its own log row.
            const aliceEnv = await recorded(aliceRun.logEntryId);
            assert.deepEqual(aliceEnv.CARGO_TARGET_DIR, { source: "session", value: "/tmp/shared" });
            assert.deepEqual(aliceEnv.ENV_WITNESS, { source: "masked" }, "a name alice withheld is recorded as masked, by her");
            assert.equal(aliceEnv.PATH?.source, "host");
            assert.deepEqual((await recorded(bobRun.logEntryId)).ENV_WITNESS, { source: "host", value: "ambient" });
            const carolRun = await accepted(carol, command);
            assert.match(await stdoutOf(carolRun.logEntryId), /target=\[\/tmp\/shared\] witness=\[ambient\] bob=\[\]/,
                "carol's command receives the value she inherited and the name she re-enabled");
            assert.deepEqual((await recorded(carolRun.logEntryId)).CARGO_TARGET_DIR, { source: "session", from: "alice", value: "/tmp/shared" },
                "the record names the Session that set an inherited value");
            await daemon.invokeModuleAction("workspace.env.add", { alias: "ENV_WITNESS", definition: { value: "workspace" } }, { scope: "workspace", workspaceId });
            const sharedRun = await accepted(bob, command);
            assert.match(await stdoutOf(sharedRun.logEntryId), /witness=\[workspace\]/u);
            assert.deepEqual((await recorded(sharedRun.logEntryId)).ENV_WITNESS, { source: "workspace", value: "workspace" });
            assert.equal(await stateOf(alice, "ENV_WITNESS"), "workspace:disabled", "the session's mask follows the name when its lower origin changes");
            const maskedRun = await accepted(alice, command);
            assert.match(await stdoutOf(maskedRun.logEntryId), /witness=\[\]/u);
            await invoke(bob, "add", { alias: "ENV_WITNESS", definition: { value: "session" } });
            const localRun = await accepted(bob, command);
            assert.match(await stdoutOf(localRun.logEntryId), /witness=\[session\]/u);
        } finally {
            unsubscribe();
        }

        // The digest renders what each spawn recorded, beside its operation ({§execution-output-identity}):
        // alice's own value and her masked name, carol's inherited value by its source.
        await daemon.stop();
        await db.close();
        quiescent = true;
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir: join(scratch, "digest") });
        const waterfall = await readFile(join(scratch, "digest", "digest.md"), "utf8");
        assert.match(waterfall, /env: host [A-Z_,]+ · CARGO_TARGET_DIR=\/tmp\/shared \(session\) · ENV_WITNESS \(masked\)/u,
            "the waterfall names alice's spawn environment with each value's provenance");
        assert.match(waterfall, /CARGO_TARGET_DIR=\/tmp\/shared \(from alice\)/u, "and carol's inherited value by the Session that set it");
        assert.match(waterfall, /ENV_WITNESS=workspace \(workspace\)/u);
    } finally {
        if (!quiescent) {
            await daemon.stop();
            await db.close();
        }
        await rm(scratch, { recursive: true, force: true });
        delete process.env.ENV_WITNESS;
        if (previousInherit === undefined) delete process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT;
        else process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = previousInherit;
    }
});

// {§execution-output-identity} — a module reading the environment on a Session's behalf sees that Session's own
// overrides above the workspace layer, exactly what its commands run under; the workspace read
// never includes them.
test("{§functionality-coordinator} readSessionEnvironment layers the Session's overrides over the workspace's defaults", async () => {
    const db = await openMigrated();
    const daemon = await boot(db);
    try {
        const workspaceId = await insertWorkspace(db, `env-seam-${crypto.randomUUID()}`);
        const alice = await insertSession(db, workspaceId, null, "alice", "model");
        await ownSession(db, workspaceId, alice);
        const bob = await insertSession(db, workspaceId, null, "bob", "model");
        await ownSession(db, workspaceId, bob);
        await daemon.invokeModuleAction("workspace.env.add", { alias: "TZ", definition: { value: "Europe/Paris" } }, { scope: "workspace", workspaceId });
        await daemon.invokeModuleAction("session.env.add", { alias: "TZ", definition: { value: "Asia/Tokyo" } }, { scope: "session", workspaceId, sessionId: alice });
        const ambient = { TZ: "UTC", PATH: process.env.PATH ?? "" };
        assert.equal((await daemon.readWorkspaceEnvironment(workspaceId))(ambient).TZ, "Europe/Paris", "the workspace layer over the ambient value");
        assert.equal((await daemon.readSessionEnvironment(workspaceId, alice))(ambient).TZ, "Asia/Tokyo", "alice's own override wins for alice");
        assert.equal((await daemon.readSessionEnvironment(workspaceId, bob))(ambient).TZ, "Europe/Paris", "bob inherits the workspace layer");
        const sessionContext = { scope: "session" as const, workspaceId, sessionId: alice };
        const removed = await daemon.invokeModuleAction("session.env.remove", { alias: "TZ" }, sessionContext) as FunctionalityMutationResult;
        assert.deepEqual(removed.definition, { alias: "TZ", origin: "workspace", state: "active", definition: { value: "Europe/Paris" } });
        assert.equal((await daemon.readSessionEnvironment(workspaceId, alice))(ambient).TZ, "Europe/Paris", "removal restores the shared value for subsequent commands");
        await daemon.invokeModuleAction("session.env.add", { alias: "TZ", definition: { value: "Asia/Tokyo" } }, sessionContext);
        await daemon.invokeModuleAction("workspace.env.disable", { alias: "TZ" }, { scope: "workspace", workspaceId });
        const disabled = await daemon.invokeModuleAction("session.env.remove", { alias: "TZ" }, sessionContext) as FunctionalityMutationResult;
        assert.deepEqual(disabled.definition, { alias: "TZ", origin: "workspace", state: "disabled", definition: { value: "Europe/Paris" } });
        assert.equal((await daemon.readSessionEnvironment(workspaceId, alice))(ambient).TZ, undefined, "removal also inherits a workspace mask");
        await daemon.invokeModuleAction("workspace.env.enable", { alias: "TZ" }, { scope: "workspace", workspaceId });
        assert.equal((await daemon.readSessionEnvironment(workspaceId, alice))(ambient).TZ, "Europe/Paris", "no session mask is left behind when the workspace changes");
    } finally {
        await daemon.stop();
        await db.close();
    }
});
});

describe("env-scheme", () => {
// {§env-functionality} — the environment registry as an address space: what `list` projects is what
// env:///NAME reads, writes land on the dispatching Session's own layer, and a value has no lines.










const PROBLEMS = "https://problems.plurnk.xyz";
const env = (name: string) => parsePath(`env:///${name}`)!;

test("{§env-functionality} every effective name reads at env:///NAME; EDIT and KILL act on the Session's own layer", async (t) => {
    const previousInherit = process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT;
    const previousWitness = process.env.ENV_WITNESS;
    process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = "PATH,HOME,ENV_WITNESS";
    process.env.ENV_WITNESS = "ambient";
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null, nodeModulesPath: resolve("..", "node_modules") });
    t.after(async () => {
        await daemon.stop();
        await db.close();
        if (previousInherit === undefined) delete process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT; else process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = previousInherit;
        if (previousWitness === undefined) delete process.env.ENV_WITNESS; else process.env.ENV_WITNESS = previousWitness;
    });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: `env-scheme-${crypto.randomUUID()}` });
    const alice = await insertSession(db, workspaceId, null, "alice", "model");
    await ownSession(db, workspaceId, alice);
    const bob = await insertSession(db, workspaceId, null, "bob", "model");
    await ownSession(db, workspaceId, bob);
    await daemon.invokeModuleAction("workspace.env.add", { alias: "TEAM_DEFAULT", definition: { value: "shared" } }, { scope: "workspace", workspaceId });

    // Each session's own operation: an env:/// address is the dispatching Session's registry ({§env-functionality}).
    const as = (sessionId: number) => (statement: PlurnkStatement) => modelOperation(daemon, db, { workspaceId, sessionId, statement });
    const dispatch = as(alice);
    const content = async (sessionId: number, name: string): Promise<string | number> => {
        const result = await as(sessionId)(readStmt(env(name)));
        return result.status === 200 ? String(result.content) : result.status;
    };
    const state = async (sessionId: number, alias: string): Promise<string | undefined> => {
        const listed = await daemon.invokeModuleAction("session.env.list", {}, { scope: "session", workspaceId, sessionId }) as FunctionalityListResult;
        const definition = listed.definitions.find((entry) => entry.alias === alias);
        return definition === undefined ? undefined : `${definition.origin}:${definition.state}`;
    };
    const find = async (path: string, matcher: ReturnType<typeof regex> | null = null): Promise<string[]> => {
        const result = await dispatch({ ...findStmt(parsePath(path), matcher), lineMarker: { marks: [1, -1] } });
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.ok(Array.isArray(result.results));
        return (result.results.flat() as Array<{ path: string }>).map((item) => item.path);
    };

    // READ: the ceiling's ambient names, workspace defaults; a name outside the ceiling is no resource.
    assert.equal(await content(alice, "ENV_WITNESS"), "ambient");
    assert.equal(await content(alice, "TEAM_DEFAULT"), "shared");
    assert.equal(await content(alice, "PLURNK_SERVICE_DB_PATH"), 404, "reserved names are absent from the env resource projection");
    assert.equal(await content(alice, "GHOST"), 404);

    // FIND lists the names in effect and a pattern matches values.
    const listed = await find("env:///*");
    for (const name of ["ENV_WITNESS", "TEAM_DEFAULT", "PATH"]) assert.ok(listed.includes(`env:///${name}`), `${name} in ${listed.join(" ")}`);
    assert.deepEqual(await find("env:///**", regex("^ambient$")), ["env:///ENV_WITNESS"]);

    // COPY carries a value into a file.
    const copied = await dispatch(copyStmt(env("TEAM_DEFAULT"), parsePath("workspace:///value.txt")!));
    assert.equal(copied.status, 201, JSON.stringify(copied));
    assert.equal(String((await dispatch(readStmt(parsePath("workspace:///value.txt")))).content).trimEnd(), "shared");

    // EDIT sets a Session's own value: a new name, and an override of an inherited one, for alice alone.
    assert.equal((await dispatch(editStmt(env("CARGO_TARGET_DIR"), "/tmp/target"))).status, 200);
    assert.equal(await content(alice, "CARGO_TARGET_DIR"), "/tmp/target");
    assert.equal(await state(alice, "CARGO_TARGET_DIR"), "session:active");
    assert.equal((await dispatch(editStmt(env("CARGO_TARGET_DIR"), "/tmp/replaced"))).status, 200);
    assert.equal(await content(alice, "CARGO_TARGET_DIR"), "/tmp/replaced", "EDIT replaces an already-local value");
    assert.equal((await dispatch(editStmt(env("CARGO_TARGET_DIR"), ""))).status, 200);
    assert.equal(await content(alice, "CARGO_TARGET_DIR"), 204, "an empty value reads as an empty resource");
    const emptyValue = await daemon.invokeModuleAction("session.env.list", {}, { scope: "session", workspaceId, sessionId: alice }) as FunctionalityListResult;
    assert.deepEqual(emptyValue.definitions.find(({ alias }) => alias === "CARGO_TARGET_DIR")?.definition, { value: "" });
    await daemon.invokeModuleAction("session.env.disable", { alias: "CARGO_TARGET_DIR" }, { scope: "session", workspaceId, sessionId: alice });
    assert.equal((await dispatch(editStmt(env("CARGO_TARGET_DIR"), "/tmp/offline"))).status, 200);
    assert.equal(await state(alice, "CARGO_TARGET_DIR"), "session:disabled", "replacement does not enable a disabled definition");
    assert.equal(await content(alice, "CARGO_TARGET_DIR"), 404);
    await daemon.invokeModuleAction("session.env.enable", { alias: "CARGO_TARGET_DIR" }, { scope: "session", workspaceId, sessionId: alice });
    assert.equal(await content(alice, "CARGO_TARGET_DIR"), "/tmp/offline");
    assert.equal(await content(bob, "CARGO_TARGET_DIR"), 404, "a sibling sees nothing of alice's layer");
    assert.equal((await dispatch(editStmt(env("ENV_WITNESS"), "mine"))).status, 200);
    assert.equal(await content(alice, "ENV_WITNESS"), "mine");
    assert.equal(await state(alice, "ENV_WITNESS"), "session:active");
    assert.equal(await content(bob, "ENV_WITNESS"), "ambient");

    // A value has no lines: a line scope is the facet's refusal, a pattern the dispatcher's for any
    // scheme without text scopes; admission is the family's, and its refusal is the operation's result.
    const problem = async (statement: PlurnkStatement): Promise<string> => {
        const result = await dispatch(statement) as { status: number; problem?: { type?: string } };
        return `${result.status} ${String(result.problem?.type).replace(`${PROBLEMS}/`, "")}`;
    };
    assert.equal(await problem(editStmt(env("ENV_WITNESS"), "x", { marks: [1, 1] })), "400 scheme/env/value-whole");
    assert.equal(await problem(editStmt(env("ENV_WITNESS"), "x", null, regex("mine"))), "400 engine/dispatcher/pattern-unsupported");
    assert.equal(await problem(editStmt(env("9NOPE"), "x")), "400 scheme/env/name-invalid");
    assert.equal(await problem(editStmt(parsePath("env://host/NAME"), "x")), "400 scheme/env/name-invalid");
    assert.equal(await problem(editStmt(env("PLURNK_SERVICE_DB_PATH"), "/tmp/steal.db")), "400 env/functionality/name-reserved");
    assert.equal(await problem(killStmt(env("ENV_WITNESS"), { marks: [1, 1] })), "400 scheme/env/value-whole");
    assert.equal(await problem(killStmt(env("GHOST"))), "404 scheme/env/entry-not-found");

    // KILL retires the name from alice's commands: remove for her own entry (restoring what it
    // shadowed), disable for an inherited one (its definition kept), never the workspace's layer.
    assert.equal((await dispatch(killStmt(env("CARGO_TARGET_DIR")))).status, 200);
    assert.equal(await content(alice, "CARGO_TARGET_DIR"), 404);
    assert.equal(await state(alice, "CARGO_TARGET_DIR"), undefined);
    assert.equal((await dispatch(killStmt(env("ENV_WITNESS")))).status, 200);
    assert.equal(await content(alice, "ENV_WITNESS"), "ambient", "removing the override restores the inherited value");
    assert.equal((await dispatch(killStmt(env("ENV_WITNESS")))).status, 200);
    assert.equal(await content(alice, "ENV_WITNESS"), 404);
    assert.equal(await state(alice, "ENV_WITNESS"), "service:disabled", "an inherited name is withheld, not forgotten");
    assert.equal((await dispatch(killStmt(env("TEAM_DEFAULT")))).status, 200);
    assert.equal(await content(alice, "TEAM_DEFAULT"), 404);
    assert.equal(await content(bob, "TEAM_DEFAULT"), "shared", "the workspace default is untouched");
    assert.equal(await problem(killStmt(env("TEAM_DEFAULT"))), "404 scheme/env/entry-not-found");
});
});

describe("functionality-parity", () => {
// {§functionality-coordinator} — lifecycle parity across the real
// families. One family-neutral matrix runs against Agent Skills and MCP
// with their representative standards peers beneath: the
// same client verbs, the same model verbs through the real proposal boundary,
// the same hotload/withdrawal at the next packet, the same persistence,
// shared visibility, workspace isolation, concurrency, and rollback. No step encodes a family's
// management grammar; only the definition payloads and the liveness probe differ.

























type Definition = { readonly alias: string; readonly definition: object; readonly probe: (context: Context) => Promise<number> };

interface Context {
    readonly daemon: Daemon;
    readonly db: Db;
    readonly workspaceId: number;
    readonly modelSessionId: number;
    // The person whose client operations probe the workspace ({§connection-lifecycle}).
    readonly actor: string;
}

interface Family {
    readonly family: string;
    readonly documentOf: (alias: string) => string;
    readonly service: Definition;              // enabled by default from configuration
    readonly addable: Definition;              // a second live definition
    readonly conflicting: Definition;          // same alias as addable, different definition
    readonly unreachable: Definition;          // admits, fails preparation
    readonly replacementUnavailable: object;
    readonly attachmentIdentity?: (context: Context) => Promise<number>;
    readonly discover: Readonly<Record<string, unknown>>;
    readonly collidingAlias?: string;          // a publication the host refuses
    readonly projectRoot?: string;             // the workspace's project root, when the family needs one
    readonly teaching: RegExp;                 // a phrase only the family's authored docs/<family>.md body carries
    boot(db: Db, provider: Mock): Promise<{ daemon: Daemon }>;
    close(): Promise<void>;
}

class PacketCapturingMock extends Mock {
    readonly requests: string[] = [];

    override generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
        this.requests.push(args[0].messages.map(chatMessageText).join("\n\n"));
        return super.generate(...args);
    }
}

const parseOne = (input: string): PlurnkStatement => {
    const parsed = PlurnkParser.parseStatements(input, { executors: fixtureExecutors(input) });
    const item = parsed.items.find((x) => x.kind === "statement");
    if (item?.kind !== "statement") throw new Error(`no statement parsed from ${input}`);
    return item.statement;
};

const LIVE = new Set([102, 200]);
// Absent: unknown or disabled (404/501) or unavailable with its exact Problem (5xx).
const isAbsent = (status: number): boolean => status >= 400;

// A person's operation, acting for the context's model session ({§connection-lifecycle}).
const dispatch = async (context: Context, statement: PlurnkStatement) => (await context.daemon.dispatchClientAction({
    workspaceId: context.workspaceId, actor: context.actor, contextSessionId: context.modelSessionId, statements: [statement],
}))[0];

// Generated documents are workspace resources ({§session-scheme}): the client reads them,
// leaving the model session's packets to the loops under test.
const documentPresent = async (context: Context, pathname: string): Promise<number> => {
    const target = pathname.includes("://") ? pathname : `workspace://${pathname}`;
    return (await dispatch(context, parseOne(`\`\`\`\`READ (${target})\`\`\`\``))).status;
};

const problemOf = async (run: () => Promise<unknown>): Promise<ProblemDetails> => {
    try { await run(); } catch (error) {
        const problem = (error as { problem?: ProblemDetails }).problem ?? (error as OperationFailureError).result?.problem;
        assert.ok(problem !== undefined, `expected a Problem, got ${String(error)}`);
        return problem;
    }
    assert.fail("Expected the action to reject.");
};

const mockProvider = (): PacketCapturingMock => new PacketCapturingMock({
    contextWindow: viableWindow() * 2,
    responses: Array.from({ length: 12 }, () => makeMockResponse("````SEND [200]\ndone\n````", 20)),
});

const packetLogRecords = (source: string): Array<Record<string, unknown>> => {
    const content = /(?:^|\n)## Log\n\n(?=### log:\/\/\/)([\s\S]*?)(?=\n\n## [^\n]+(?:\n|$)|$)/u.exec(source)?.[1];
    assert.notEqual(content, undefined, "the generated model request includes its Log section");
    return parseLogRecords(content!);
};

// ───────────────────────── families ─────────────────────────

const skillsFamily = async (): Promise<Family> => {
    const base = await mkdtemp(join(tmpdir(), "plurnk-parity-skills-"));
    const home = join(base, "home");
    const project = join(base, "project");
    const sourceA = join(base, "source-a");
    const sourceB = join(base, "source-b");
    const hostPaths = new HostPaths({ home, env: {} });
    const skill = async (root: string, name: string, description: string) => {
        await mkdir(join(root, name), { recursive: true });
        await writeFile(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nUse ${name}.\n`);
    };
    await mkdir(project, { recursive: true });
    await mkdir(home, { recursive: true });
    const emptySource = join(base, "empty-source");
    await mkdir(emptySource);
    await skill(hostPaths.projectSkillsDir(project), "grep", "Find text");
    await skill(sourceA, "extra", "Extra from source A");
    await skill(sourceB, "extra", "Extra from source B");
    const doc = (alias: string) => `skill://${alias}/SKILL.md`;
    const probe = (alias: string) => (context: Context) => documentPresent(context, doc(alias));
    return {
        family: "skills",
        documentOf: doc,
        teaching: /## Adding/u,
        service: { alias: "grep", definition: { name: "grep", source: join(hostPaths.projectSkillsDir(project), "grep") }, probe: probe("grep") },
        addable: { alias: "extra", definition: { name: "extra", source: sourceA }, probe: probe("extra") },
        conflicting: { alias: "extra", definition: { name: "extra", source: sourceB }, probe: probe("extra") },
        unreachable: { alias: "ghost", definition: { name: "ghost", source: sourceA }, probe: probe("ghost") },
        replacementUnavailable: { name: "extra", source: emptySource },
        discover: { source: sourceA },
        boot: async (db, provider) => {
            const daemon = new Daemon({ db, provider, hostPaths });
            return { daemon };
        },
        close: () => rm(base, { recursive: true, force: true }),
        projectRoot: project,
    };
};

const mcpFamily = async (): Promise<Family> => {
    const echo = fileURLToPath(new URL("../../../plurnk-mcp/src/fixtures/echo-server.mjs", import.meta.url));
    const legacy = fileURLToPath(new URL("../../../plurnk-mcp/src/fixtures/legacy-server.mjs", import.meta.url));
    // {§mcp-configuration}
    const home = await mkdtemp(join(tmpdir(), "plurnk-parity-mcp-"));
    const hostPaths = new HostPaths({ home, env: {} });
    // {§mcp-module} — a registry answering exactly as the MCP Registry does.
    const registry = createServer((_request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ servers: [{ server: {
            name: "io.github.example/example-server", version: "1.0.0", description: "An example server.",
            packages: [{ registryType: "npm", identifier: "@example/server", version: "1.0.0", transport: { type: "stdio" } }],
        } }] }));
    });
    await new Promise<void>((res) => registry.listen(0, "127.0.0.1", res));
    const registryUrl = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
    // A started stream is an active request; the probe waits for its results
    // channel to close so a following mutation meets a quiescent server.
    const exec = (alias: string, tool: string) => async (context: Context) => {
        const before = (await context.db.test_entries_by_scheme_prefix.all<{ pathname: string }>({ workspace_id: context.workspaceId, scheme: alias, prefix: "/%" })).length;
        const { status } = await dispatch(context, parseOne(`\`\`\`\`${alias} (${tool})
{"message":"parity"}
\`\`\`\``));
        if (status !== 200) return status;
        await waitForDb(async () => {
            const outputs = await context.db.test_entries_by_scheme_prefix.all<{ pathname: string }>({ workspace_id: context.workspaceId, scheme: alias, prefix: "/%" });
            if (outputs.length <= before) return false;
            for (const { pathname } of outputs) {
                const channel = await context.db.test_get_channel_by_pathname_scheme.get<{ state: string }>({ pathname, scheme: alias, name: "body" });
                if (channel !== undefined && channel.state !== "closed" && channel.state !== "errored") return false;
            }
            return true;
        }, (closed) => closed, { timeoutMs: 20_000 });
        return status;
    };
    // The echo tool declares readOnlyHint, so a client execution of it runs ungated; the legacy one proposes.
    const server = (name: string, file: string) => ({ name, type: "stdio", command: "node", args: [file], env: { PLURNK_MCP_TEST_LAUNCH: "1" } });
    return {
        family: "mcp",
        teaching: /## discover, then add/u,
        documentOf: (alias) => `/_plurnk/tools/${alias}.md`,
        service: { alias: "fixture", definition: server("fixture", echo), probe: exec("fixture", "echo") },
        addable: { alias: "extra", definition: server("extra", echo), probe: exec("extra", "echo") },
        conflicting: { alias: "extra", definition: server("extra", legacy), probe: exec("extra", "legacy_echo") },
        unreachable: { alias: "ghost", definition: server("ghost", join(tmpdir(), "no-such-mcp-server.mjs")), probe: exec("ghost", "echo") },
        replacementUnavailable: server("extra", join(tmpdir(), "no-such-mcp-server.mjs")),
        attachmentIdentity: async (context) => {
            const after = (await context.db.test_entries_by_scheme_prefix.all({ workspace_id: context.workspaceId, scheme: "extra", prefix: "/%" })).length;
            assert.equal((await dispatch(context, parseOne(PlurnkParser.frame("extra (launch)", "{}")))).status, 200);
            const result = await awaitExecOutcome(context.db, { workspaceId: context.workspaceId, scheme: "extra", channel: "body", after });
            assert.equal(typeof result.pid, "number");
            return result.pid as number;
        },
        discover: { query: "example" },
        collidingAlias: "sh",
        boot: async (db, provider) => {
            const daemon = new Daemon({ db, provider, hostPaths });
            daemon.registerModule(McpModule.init({ env: { ...mcpEnvironment({ fixture: stdioEntry("echo-server.mjs") }), PLURNK_MCP_REGISTRY_URL: registryUrl, PLURNK_MCP_REGISTRY_LIMIT: "5" } }), "@plurnk/plurnk-mcp");
            return { daemon };
        },
        close: async () => {
            await new Promise<void>((res) => registry.close(() => res()));
            await rm(home, { recursive: true, force: true });
        },
    };
};

// ───────────────────────── the matrix ─────────────────────────

const matrix = async (family: Family): Promise<void> => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `parity-${family.family}-${crypto.randomUUID()}`);
    if (family.projectRoot !== undefined) await db.test_set_workspace_root.run({ id: workspaceId, project_root: family.projectRoot });
    const model = await insertSession(db, workspaceId, null, "model", "model");
    const peer = await insertSession(db, workspaceId, null, "peer", "model");
    for (const sessionId of [model, peer]) await ownSession(db, workspaceId, sessionId);
    const personA = TEST_OWNER;
    const personB = "test://secondary";
    let provider = mockProvider();
    let { daemon } = await family.boot(db, provider);
    await daemon.start();
    const context = (modelSessionId = model, actor = personA): Context => ({ daemon, db, workspaceId, modelSessionId, actor });
    // A client retries the one retryable refusal: 409 workspace-busy while a
    // just-settled stream still holds the workspace ({§module-workspace-residency}).
    const invoke = async <T>(verb: string, params: Readonly<Record<string, unknown>>): Promise<T> => {
        for (let attempt = 0; ; attempt++) {
            try {
                return await daemon.invokeModuleAction(`workspace.${family.family}.${verb}`, params, { scope: "workspace", workspaceId }) as T;
            } catch (error) {
                const problem = (error as { problem?: ProblemDetails }).problem ?? (error as OperationFailureError).result?.problem;
                if (problem?.type.endsWith("/workspace-busy") && attempt < 100) {
                    await new Promise((r) => setTimeout(r, 20));
                    continue;
                }
                throw error;
            }
        }
    };
    type Listed = { alias: string; origin: string; state: string; definition: object; problem?: ProblemDetails };
    const listed = async (): Promise<Listed[]> => (await invoke<{ definitions: Listed[] }>("list", {})).definitions;
    const stateOf = async (alias: string): Promise<string | undefined> => (await listed()).find((entry) => entry.alias === alias)?.state;
    const live = async (definition: Definition, sessionId = model, actor = personA): Promise<boolean> => {
        const status = await definition.probe(context(sessionId, actor));
        assert.ok(LIVE.has(status) || isAbsent(status), `${family.family}: probe of ${definition.alias} answered ${status}`);
        return LIVE.has(status);
    };
    const document = (alias: string) => documentPresent(context(), family.documentOf(alias));
    // Model verbs: the model's own operations through the plurnk execution manager, which streams JSON
    // into its output entry; its owner reviews what they propose.
    const exec = (program: string) => modelOperation(daemon, db, { workspaceId, sessionId: model, statement: parseOne(program) });
    const verbResult = () => awaitExecOutcome(db, { workspaceId, scheme: "plurnk", timeoutMs: 10_000 });
    const proposals: number[] = [];
    const events: Array<{ method: string; params: unknown }> = [];
    let unsubscribe = daemon.subscribeToEvents((_w, method, params) => {
        events.push({ method, params });
        if (method === "loop/proposal") proposals.push((params as { logEntryId: number }).logEntryId);
    });
    // An execution verb starts a stream: the dispatch reports `started`, the verb's
    // JSON outcome closes the family's results channel, and an accepted
    // mutation's publication settles at the turn boundary.
    const proposed = async (program: string, decision: "accept" | "reject") => {
        const seen = proposals.length;
        const outputsBefore = (await db.test_entries_by_scheme_prefix.all<{ pathname: string }>({ workspace_id: workspaceId, scheme: "plurnk", prefix: "/%" })).length;
        const pending = exec(program);
        await waitFor(() => proposals, (list) => list.length > seen, { timeoutMs: 10_000 });
        await daemon.resolveProposal(proposals[seen], { decision }, { workspaceId, address: TEST_OWNER });
        const result = await pending;
        if (decision === "accept") {
            await waitForDb(async () => (await db.test_entries_by_scheme_prefix.all<{ pathname: string }>({ workspace_id: workspaceId, scheme: "plurnk", prefix: "/%" })).length, (count) => count > outputsBefore, { timeoutMs: 10_000 });
            await verbResult();
            await daemon.settleFunctionality(workspaceId);
        }
        return result;
    };
    // A model loop: the next packet is what the model actually sees.
    const nextPacket = async (): Promise<string> => {
        const before = provider.requests.length;
        const started = await daemon.runLoop({ workspaceId, sessionId: model, prompt: `parity ${provider.requests.length}` });
        await waitFor(() => events.filter((e) => e.method === "loop/terminated" && (e.params as { loopId?: number }).loopId === started.loopId), (t) => t.length > 0, { timeoutMs: 20_000 });
        const packet = provider.requests[before];
        assert.ok(packet !== undefined, `${family.family}: the loop produced no packet`);
        return packet;
    };
    const add = (definition: Definition) => invoke<{ status: number; definition: { state: string } }>("add", { alias: definition.alias, definition: definition.definition });

    try {
        // 1. Registration: the common actions, nothing family-specific in the grammar.
        assert.deepEqual(
            daemon.listModuleActions().map(({ name }) => name).filter((name) => name.startsWith(`workspace.${family.family}.`) && !name.includes(".oauth.") && !name.endsWith(".complete")).toSorted(),
            ["add", "disable", "discover", "enable", "list", "remove", "replace"].map((verb) => `workspace.${family.family}.${verb}`),
        );
        // 2. Inspection is passive; real use activates the service definition.
        assert.equal(await stateOf(family.service.alias), "dormant");
        assert.equal((await listed()).find((entry) => entry.alias === family.service.alias)?.origin, "service");
        assert.equal(await live(family.service), true, "the configured definition is live");
        assert.equal(await stateOf(family.service.alias), "active");
        assert.equal(await document(family.service.alias), 200, "the active definition has its generated document");
        // {§functionality-model-projection} — real installed managers use the same schema documents as attached tools.
        const references = await daemon.engine.referenceEntries(workspaceId);
        const managerDoc = references.find(({ pathname }) => pathname === "/_plurnk/tools/plurnk.md")!;
        const toolSchemaPath = `/_plurnk/tools/plurnk/${family.family}.json`;
        const toolDoc = references.find(({ pathname }) => pathname === toolSchemaPath)!;
        assert.ok(managerDoc && toolDoc, "the manager catalog links to a materialized input schema");
        assert.ok(managerDoc.content.includes(`Schema: workspace://${toolSchemaPath}`));
        const toolSchema = JSON.parse(toolDoc.content);
        assert.ok(toolSchema.properties.verb.enum.includes("add") && toolSchema.properties.verb.enum.includes("replace"));
        assert.ok(toolSchema.properties.definition !== undefined, "the tool schema includes the definition schema");
        // {§functionality-model-projection} — the adapter package's docs/<family>.md rides inside the tool schema description.
        assert.match(String(toolSchema.description ?? ""), family.teaching, `${family.family}.json carries its authored teaching body`);
        assert.equal(await documentPresent(context(), toolSchemaPath), 200,
            "the full schema is materialized in the workspace's generated subtree");
        if (family.family === "mcp") {
            type Property = { readonly description?: string; readonly $ref?: string };
            type McpDefinition = { readonly description?: string; readonly properties?: Readonly<Record<string, Property>> };
            const schema = Validator.schemaByRef("https://schemas.plurnk.xyz/v0/McpServerDefinition.json") as { readonly $defs: Readonly<Record<string, McpDefinition>> } | undefined;
            assert.ok(schema);
            assert.deepEqual(toolSchema.$defs["https://schemas.plurnk.xyz/v0/McpServerDefinition.json"], schema, "both transport branches reach the model unchanged");
            const described = (property: Property): boolean => typeof property.description === "string"
                || (property.$ref !== undefined && typeof schema.$defs[property.$ref.split("/").at(-1)!]?.description === "string");
            for (const branch of ["stdio", "streamableHttp"]) {
                assert.ok(Object.values(schema.$defs[branch]?.properties ?? {}).every(described), `every ${branch} input field is described, directly or through its definition`);
            }
        }
        // 3. Discovery from the representative source is inert.
        const discovered = await invoke<{ candidates: Array<{ alias?: string; provenance: { kind: string; source: string } }> }>("discover", family.discover);
        assert.ok(discovered.candidates.length > 0, "the representative source yields candidates");
        assert.ok(discovered.candidates.every(({ provenance }) => typeof provenance.kind === "string" && typeof provenance.source === "string"), "every candidate carries exact provenance");
        assert.equal((await listed()).some((entry) => discovered.candidates.some((candidate) => candidate.alias === entry.alias && entry.origin === "workspace")), false, "discovery added nothing");
        // 4. Client add → live and documented before the next operation.
        assert.equal(await live(family.addable), false, "the alias is absent before add");
        const added = await add(family.addable);
        assert.equal(added.status, 201);
        assert.equal(added.definition.state, "active");
        assert.equal(await live(family.addable), true, "add hotloads the definition before the next operation");
        assert.equal(await document(family.addable.alias), 200);
        if (family.family === "mcp") assert.equal(await documentPresent(context(), "/_plurnk/tools/extra/echo.json"), 200);
        // 5. Publication evidence is the verb outcome plus the document itself;
        // maintenance receipts never ride the packet (#338 — a receipt answers
        // an asker, and reconciliation turns have none).
        const afterAdd = await nextPacket();
        assert.equal(packetLogRecords(afterAdd).some(({ logPath: path, path: target }) =>
            typeof path === "string" && path.endsWith("/EDIT") && target === family.documentOf(family.addable.alias)), false, "no reconciliation EDIT receipt rides the packet");
        assert.equal((await invoke<{ definition: { state: string } }>("disable", { alias: family.addable.alias })).definition.state, "disabled");
        assert.equal(await live(family.addable), false, "disable withdraws the definition before the next operation");
        assert.equal(await document(family.addable.alias), 404, "disable withdraws the generated document");
        if (family.family === "mcp") assert.equal(await documentPresent(context(), "/_plurnk/tools/extra/echo.json"), 404,
            "disable withdraws the child schema as well as its family catalog");
        const afterDisable = await nextPacket();
        assert.equal(packetLogRecords(afterDisable).some(({ logPath: path, path: target }) =>
            typeof path === "string" && path.endsWith("/KILL") && target === family.documentOf(family.addable.alias)), false, "no reconciliation KILL receipt rides the packet (#338)");
        assert.equal((await invoke<{ definition: { state: string } }>("enable", { alias: family.addable.alias })).definition.state, "active");
        if (family.family === "mcp") assert.equal(await documentPresent(context(), "/_plurnk/tools/extra/echo.json"), 200);
        assert.equal(await live(family.addable), true);
        // 6. Enabled-unavailable: an accepted model add of an unreachable peer publishes unavailable with its exact Problem;
        //    the explicit client retry rejects with the same Problem; remove recovers.
        const viaModel = await proposed(`\`\`\`\`plurnk (${family.family})
${JSON.stringify({ verb: "add", alias: family.unreachable.alias, definition: family.unreachable.definition })}
\`\`\`\``, "accept");
        assert.equal(viaModel.status, 201, "the accepted add reports creation, with resource readiness in its body");
        await exec(`\`\`\`\`plurnk (${family.family})\`\`\`\``);
        const downListed = (await listed()).find((entry) => entry.alias === family.unreachable.alias);
        assert.equal(downListed?.state, "unavailable");
        assert.ok((downListed?.problem?.status ?? 0) >= 400, "the enabled definition keeps its exact Problem");
        assert.equal(await live(family.unreachable), false);
        assert.equal(await document(family.unreachable.alias), 404, "an unavailable definition publishes no document");
        const retried = await problemOf(() => invoke("enable", { alias: family.unreachable.alias }));
        assert.equal(retried.type, downListed?.problem?.type, "an explicit retry reports the same exact Problem");
        assert.equal((await invoke<{ removed: boolean }>("remove", { alias: family.unreachable.alias })).removed, true);
        assert.equal(await stateOf(family.unreachable.alias), undefined);
        // 7. Model verbs through the generated manager: read ungated, host verbs propose, rejection performs nothing.
        assert.equal((await exec(`\`\`\`\`plurnk (${family.family})\`\`\`\``)).status, 200);
        assert.equal((await verbResult()).family, family.family);
        const rejected = await proposed(`\`\`\`\`plurnk (${family.family})
${JSON.stringify({ verb: "remove", alias: family.addable.alias })}
\`\`\`\``, "reject");
        assert.equal(rejected.status, 400, "a rejected proposal settles 400");
        assert.equal(await stateOf(family.addable.alias), "active", "rejection changed nothing");
        assert.equal(await live(family.addable), true);
        const viaModelDisable = await proposed(`\`\`\`\`plurnk (${family.family})
${JSON.stringify({ verb: "disable", alias: family.addable.alias })}
\`\`\`\``, "accept");
        assert.equal(viaModelDisable.status, 200);
        assert.equal(await live(family.addable), false, "an accepted model mutation is published before the next operation");
        await invoke("enable", { alias: family.addable.alias });
        // 8. A client add the service refuses rejects and persists nothing (rollback).
        const refused = await problemOf(() => add(family.unreachable));
        assert.ok(refused.status >= 400);
        assert.equal(await stateOf(family.unreachable.alias), undefined, "a rejected client add persists nothing");
        if (family.collidingAlias !== undefined) {
            await assert.rejects(() => add({ ...family.addable, alias: family.collidingAlias!, definition: { ...(family.addable.definition), name: family.collidingAlias } }));
            assert.equal(await stateOf(family.collidingAlias), undefined, "a publication the host refuses rolls back");
            assert.equal(await live(family.service), true, "the previous snapshot stays authoritative");
        }
        // 9. Independent sessions and people see and use the workspace state.
        assert.equal(await live(family.addable, peer, personB), true, "a second person, acting for an independent session, uses the same workspace definition");
        await invoke("disable", { alias: family.addable.alias });
        assert.equal(await live(family.addable, peer, personB), false, "a mutation through one client is observed by the other");
        await invoke("enable", { alias: family.addable.alias });
        // 10. Reapplying identical configuration is idempotent; a conflicting alias cannot silently replace it.
        assert.equal((await add(family.addable)).status, 200);
        const conflict = await problemOf(() => add(family.conflicting));
        assert.equal(conflict.type, "https://problems.plurnk.xyz/functionality/alias-exists");
        assert.equal(await live(family.addable, peer), true, "the rejected replacement did not withdraw the shared definition");
        // {§functionality-replacement} Both projections keep the old attachment on failure and
        // publish a complete replacement only on success. Disabled replacements stay offline.
        const beforeReplacement = (await listed()).find(({ alias }) => alias === family.addable.alias);
        const attachment = await family.attachmentIdentity?.(context());
        for (const caller of ["action", "operation"] as const) {
            const params = { alias: family.addable.alias, definition: family.replacementUnavailable };
            let problem: ProblemDetails;
            if (caller === "action") problem = await problemOf(() => invoke("replace", params));
            else {
                await proposed(PlurnkParser.frame(`plurnk (${family.family})`, JSON.stringify({ verb: "replace", ...params })), "accept");
                problem = (await verbResult()).problem as ProblemDetails;
            }
            assert.equal(problem.type, refused.type, "the failed replacement reports its preparation problem");
            assert.deepEqual((await listed()).find(({ alias }) => alias === family.addable.alias), beforeReplacement);
            assert.equal(await live(family.addable, peer), true, `${caller} failure leaves the old capability usable`);
            if (attachment !== undefined) assert.equal(await family.attachmentIdentity!(context()), attachment,
                "a failed replacement preserves the actual server process, not just a re-created configuration");
        }
        const replacement = { verb: "replace", alias: family.addable.alias, definition: family.conflicting.definition };
        await proposed(PlurnkParser.frame(`plurnk (${family.family})`, JSON.stringify(replacement)), "accept");
        assert.equal((await verbResult()).status, 200);
        assert.deepEqual((await listed()).find(({ alias }) => alias === family.addable.alias)?.definition, family.conflicting.definition);
        if (family.family === "mcp") {
            assert.equal(await documentPresent(context(), "/_plurnk/tools/extra/echo.json"), 404, "the old tool schema is withdrawn");
            assert.equal(await documentPresent(context(), "/_plurnk/tools/extra/legacy_echo.json"), 200, "the new server's tool schema is published");
            const seen = proposals.length;
            const execution = exec(PlurnkParser.frame("extra (legacy_echo)", JSON.stringify({ text: "replacement works" })));
            await waitFor(() => proposals, (list) => list.length > seen, { timeoutMs: 10_000 });
            await daemon.resolveProposal(proposals[seen], { decision: "accept" }, { workspaceId, address: TEST_OWNER });
            assert.equal((await execution).status, 200);
            const output = await waitForDb(async () => {
                const entries = await db.test_entries_by_scheme_prefix.all<{ pathname: string; id: number }>({ workspace_id: workspaceId, scheme: "extra", prefix: "/%" });
                const latest = entries.toSorted((left, right) => right.id - left.id)[0];
                return db.test_get_channel_by_pathname_scheme.get<{ content: string; state: string }>({ pathname: latest.pathname, scheme: "extra", name: "body" });
            }, (channel) => channel?.state === "closed", { timeoutMs: 10_000 });
            assert.equal(output?.content, "legacy echo: replacement works", "the replacement's actual tool is callable");
        } else assert.equal(await live(family.conflicting, peer), true);
        await invoke("disable", { alias: family.addable.alias });
        const offline = await invoke<{ status: number; definition: Listed }>("replace", {
            alias: family.addable.alias, definition: family.replacementUnavailable,
        });
        assert.equal(offline.status, 200);
        assert.equal(offline.definition.state, "disabled");
        assert.deepEqual(offline.definition.definition, family.replacementUnavailable);
        await invoke("replace", { alias: family.addable.alias, definition: family.addable.definition });
        assert.equal(await stateOf(family.addable.alias), "disabled");
        await invoke("enable", { alias: family.addable.alias });
        const restoredAttachment = await family.attachmentIdentity?.(context());
        await invoke("replace", { alias: family.addable.alias, definition: family.addable.definition });
        if (restoredAttachment !== undefined) assert.equal(await family.attachmentIdentity!(context()), restoredAttachment,
            "an identical replacement keeps its current attachment");
        // 11. A child's environment remains the same shared workspace, not a copied snapshot.
        const child = await insertSession(db, workspaceId, model, "child", "model");
        assert.equal(await live(family.addable, child), true);
        await invoke("disable", { alias: family.addable.alias });
        assert.equal(await live(family.addable, child), false, "an existing child sees workspace withdrawal");
        await invoke("enable", { alias: family.addable.alias });
        assert.equal(await live(family.addable, child), true, "the same child sees re-enablement without re-instantiation");
        assert.equal(await stateOf(family.addable.alias), "active");
        // 12. Concurrent mutations serialize to one consistent outcome.
        const completedMutations: string[] = [];
        await Promise.all(["disable", "enable", "disable", "enable"].map(async (verb) => {
            const expected = verb === "enable" ? "active" : "disabled";
            const result = await invoke<{ definition: { state: string } }>(verb, { alias: family.addable.alias });
            assert.equal(result.definition.state, expected, "each successful mutation reports its published state");
            completedMutations.push(expected);
        }));
        assert.equal(completedMutations.length, 4);
        const settled = await stateOf(family.addable.alias);
        assert.equal(settled, completedMutations.at(-1), "the last completed mutation wins, including client retries");
        assert.equal(await live(family.addable), settled === "active", "liveness agrees with the listed state");
        // 13. Restart reconstructs one shared workspace environment.
        assert.equal((await invoke<{ definition: { state: string } }>("enable", { alias: family.addable.alias })).definition.state, "active");
        unsubscribe();
        await daemon.stop();
        provider = mockProvider();
        ({ daemon } = await family.boot(db, provider));
        await daemon.start();
        unsubscribe = daemon.subscribeToEvents(() => {});
        assert.equal(await stateOf(family.service.alias), "dormant");
        assert.equal(await stateOf(family.addable.alias), "dormant", "the workspace definition survives without activation");
        assert.equal(await live(family.addable), true);
        assert.equal(await stateOf(family.service.alias), "active");
        assert.equal(await stateOf(family.addable.alias), "active");
        assert.equal(await document(family.addable.alias), 200);
        assert.equal(await live(family.addable, child), true, "the child sees the restored workspace definition");
        assert.equal(await live(family.addable, peer), true, "the independent session sees the same definition");
        // 14. Remove forgets the workspace definition and withdraws its capability.
        assert.equal((await invoke<{ removed: boolean }>("remove", { alias: family.addable.alias })).removed, true);
        assert.equal(await live(family.addable), false);
        assert.equal(await document(family.addable.alias), 404);
    } finally {
        unsubscribe();
        await daemon.stop();
        await db.close();
    }
};

for (const make of [skillsFamily, mcpFamily]) {
    test(`{§functionality-coordinator} lifecycle parity: ${make.name.replace("Family", "")}`, async () => {
        const family = await make();
        try {
            await matrix(family);
        } finally {
            await family.close();
        }
    });
}
});

describe("session-module-state", () => {
// SPEC {§module-lifecycle} — a family declares whether its definitions belong to the
// workspace or to a session, and the coordinator keys state by that scope. `env` is the first
// session-scoped family: an environment is context (how this session works) rather than capability
// (what exists in this workspace).
//
// A sibling table rather than a nullable column, so the foreign key is real. These witnesses
// cover the two properties that choice buys: isolation between sessions, and a cascade that takes
// a session's definitions with it.




const OWNER = "@plurnk/plurnk-service";

test("{§module-lifecycle} session state is per session, not shared across siblings", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `session-state-${crypto.randomUUID()}`);
        const one = await insertSession(db, workspaceId);
        const two = await insertSession(db, workspaceId);

        await db.session_module_state_put.run({
            session_id: one, namespace_owner: OWNER,
            state: JSON.stringify({ version: 1, definitions: { CARGO_TARGET_DIR: { origin: "session", enabled: true } } }),
        });

        const mine = await db.session_module_state_get.get<{ state: string }>({ session_id: one, namespace_owner: OWNER });
        const sibling = await db.session_module_state_get.get<{ state: string }>({ session_id: two, namespace_owner: OWNER });
        assert.match(mine!.state, /CARGO_TARGET_DIR/u);
        assert.equal(sibling, undefined, "a sibling session sees nothing of it — this is the whole reason for the scope");
    } finally { await db.close(); }
});

test("{§module-lifecycle} a session's definitions die with the session", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `session-state-cascade-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        await db.session_module_state_put.run({
            session_id: sessionId, namespace_owner: OWNER, state: JSON.stringify({ version: 1, definitions: {} }),
        });

        await db.test_delete_session.run({ id: sessionId });

        const orphan = await db.session_module_state_get.get<{ state: string }>({ session_id: sessionId, namespace_owner: OWNER });
        assert.equal(orphan, undefined, "the real foreign key cascades; a nullable column on the workspace table would have orphaned it");
    } finally { await db.close(); }
});

test("{§module-lifecycle} put replaces in place, keyed by (session, owner)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `session-state-replace-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const key = { session_id: sessionId, namespace_owner: OWNER };
        await db.session_module_state_put.run({ ...key, state: JSON.stringify({ version: 1, definitions: { A: {} } }) });
        await db.session_module_state_put.run({ ...key, state: JSON.stringify({ version: 1, definitions: { B: {} } }) });

        const row = await db.session_module_state_get.get<{ state: string }>(key);
        assert.match(row!.state, /"B"/u);
        assert.doesNotMatch(row!.state, /"A"/u, "one snapshot per (session, owner), replaced whole");
    } finally { await db.close(); }
});

// {§functionality-coordinator} — inheritance is a row copy at the child's creation, marked with its source.
const definitionsOf = async (db: Awaited<ReturnType<typeof openMigrated>>, sessionId: number): Promise<Record<string, Record<string, unknown>>> => {
    const row = await db.session_module_state_get.get<{ state: string }>({ session_id: sessionId, namespace_owner: OWNER });
    return row === undefined ? {} : (JSON.parse(row.state) as { definitions: Record<string, Record<string, unknown>> }).definitions;
};

test("{§functionality-coordinator} a child starts with a copy of its parent's state, every entry named for its source", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `session-state-inherit-${crypto.randomUUID()}`);
        const alice = await insertSession(db, workspaceId, null, "alice");
        await db.session_module_state_put.run({
            session_id: alice, namespace_owner: OWNER,
            state: JSON.stringify({ version: 1, definitions: {
                CARGO_TARGET_DIR: { origin: "session", enabled: true, definition: { value: "/tmp/shared" } },
                CI: { origin: "service", enabled: false },
            } }),
        });
        const bob = await insertSession(db, workspaceId, alice, "bob");
        assert.deepEqual(await definitionsOf(db, bob), {
            CARGO_TARGET_DIR: { origin: "session", enabled: true, definition: { value: "/tmp/shared" }, inherited: "alice" },
            CI: { origin: "service", enabled: false, inherited: "alice" },
        }, "copied faithfully, disabled entries included, each named for the Session that set it");

        // A snapshot, not a link: alice's later edit never reaches bob.
        await db.session_module_state_put.run({
            session_id: alice, namespace_owner: OWNER,
            state: JSON.stringify({ version: 1, definitions: { LATER: { origin: "session", enabled: true, definition: { value: "x" } } } }),
        });
        assert.deepEqual(Object.keys(await definitionsOf(db, bob)), ["CARGO_TARGET_DIR", "CI"]);

        // Depth is transitive and provenance names the origin, not the intermediate.
        const carol = await insertSession(db, workspaceId, bob, "carol");
        assert.equal((await definitionsOf(db, carol)).CARGO_TARGET_DIR.inherited, "alice", "a grandchild still names the Session that set the entry");

        // A parentless Session inherits nothing.
        const loner = await insertSession(db, workspaceId, null, "loner");
        assert.deepEqual(await definitionsOf(db, loner), {});
    } finally { await db.close(); }
});
});

describe("workspace-functionality", () => {
test("{§module-workspace-residency}: MCP definitions belong to the workspace, not to any session", async (t) => {
    const server = await serveMcpHttp(t, createMcpHandler(() => {
        const mcp = new McpServer({ name: "shared-fixture", version: "1.0.0" });
        mcp.registerTool("echo", {
            inputSchema: fromJsonSchema({ type: "object", additionalProperties: false }),
            annotations: { readOnlyHint: true },
        }, async () => ({ content: [{ type: "text", text: "workspace tool" }] }));
        mcp.registerResource("shared-item", "fixture://shared/item", { mimeType: "text/plain" }, async () => ({
            contents: [{ uri: "fixture://shared/item", mimeType: "text/plain", text: "shared resource" }],
        }));
        return mcp;
    }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 }));
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, { shared: httpEntry(server.url) });
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 1_000_000, responses: [] });
    const daemon = new Daemon({ db, provider, nodeModulesPath: resolve("node_modules"), hostPaths });
    daemon.registerModule(McpModule.init({ env: { ...mcpEnv, ...MCP_CONTROLS } }), "@plurnk/plurnk-mcp");
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "shared-functionality" });
    const other = await daemon.createWorkspace({ name: "other-functionality" });
    const action = (id: number, verb: string, params: Record<string, unknown> = {}) => daemon.invokeModuleAction(
        `workspace.mcp.${verb}`, params, { scope: "workspace", workspaceId: id },
    );
    const enabled = await action(workspaceId, "enable", { alias: "shared" }) as { definition: { state: string } };
    assert.equal(enabled.definition.state, "active", "the workspace connects its installed server with no session");
    const listed = await action(workspaceId, "list") as FunctionalityListResult;
    assert.equal(listed.definitions.find(({ alias }) => alias === "shared")?.state, "active");
    assert.deepEqual((await action(other.workspaceId, "list") as FunctionalityListResult).definitions.map(({ alias, state }) => ({ alias, state })),
        [{ alias: "shared", state: "dormant" }], "the workspace boundary remains real: another workspace holds no connection of this one's");
    const alice = await insertSession(db, workspaceId, null, "alice", "model");
    const bob = await insertSession(db, workspaceId, null, "bob", "model");
    assert.deepEqual((await action(workspaceId, "list") as FunctionalityListResult).definitions, listed.definitions,
        "creating sessions neither copies nor redefines the shared environment");
    const read = PlurnkParser.parseStatements(PlurnkParser.frame("READ (shared:///resources) <1,-1>", null), { executors: fixtureExecutors(PlurnkParser.frame("READ (shared:///resources) <1,-1>", null)) }).items[0];
    assert.equal(read?.kind, "statement");
    if (read?.kind !== "statement") throw new Error("Expected one READ");
    for (const sessionId of [alice, bob]) {
        const docs = await daemon.engine.referenceEntries(workspaceId);
        assert.ok(docs.some(({ content }) => content.includes("shared (echo)")), "every session discovers the same enabled tool");
        // The session's own READ.
        const catalog = await modelOperation(daemon, db, { workspaceId, sessionId, statement: read.statement });
        assert.equal(catalog.status, 200, JSON.stringify(catalog));
        assert.match(String(catalog.content), /fixture:\/\/shared\/item/u);
    }
    await action(workspaceId, "disable", { alias: "shared" });
    assert.equal((await action(workspaceId, "list") as FunctionalityListResult).definitions[0]?.state, "disabled");
    const docs = await daemon.engine.referenceEntries(workspaceId);
    assert.equal(docs.some(({ content }) => content.includes("shared (echo)")), false, "disable changes the one shared discovery surface");
    assert.equal((await action(other.workspaceId, "list") as FunctionalityListResult).definitions[0]?.state, "dormant",
        "disabling a server in one workspace leaves it enabled in another");
    assert.equal(provider.received.length, 0, "environment management never invokes a model");
});
});
