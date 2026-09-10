// {§functionality-coordinator} — the shared workspace Functionality lifecycle proven
// through a fixture adapter: one client projection, one generated model family,
// one durable workspace-owned state, one atomic publication.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlurnkParser, Problems } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import type { PlurnkStatement, ProblemDetails } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import type {
    FunctionalityAdapter,
    FunctionalityPrepared,
    ModuleSetupSeam,
    RuntimeRegistration,
} from "../../src/server/DaemonModule.ts";
import type { Executor } from "../../src/core/ExecutorRegistry.ts";
import Results, { OperationFailureError } from "../../src/core/results.ts";
import { awaitExecOutcome, insertWorkspace, insertWorker, openMigrated } from "./_helpers.ts";
import type { Db } from "../../src/core/Db.ts";
import LoopDocs from "../../src/server/loopDocs.ts";
import { connect, makeMockResponse, rpcCall, runLoopToTerminal } from "./_rpc.ts";

const OWNER = "fx fixture adapter";

const parseOne = (input: string): PlurnkStatement => {
    const parsed = PlurnkParser.parseStatements(input);
    const item = parsed.items.find((x) => x.kind === "statement");
    if (item?.kind !== "statement") throw new Error(`no statement parsed from ${input}`);
    return item.statement;
};

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
                writableBy: ["plugin"], volatile: true, modelVisible: true,
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

// A family whose definitions are {kind: ok | fail | doc}. Service contributes
// `svc`, enabled by default. `fail` refuses preparation; `doc` also publishes a
// family document.
const fixtureAdapter = (log: string[]): FunctionalityAdapter => ({
    family: "fx",
    namespaceOwner: OWNER,
    summary: "Manage fixture capabilities.",
    definitionSchema: {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: { kind: { enum: ["ok", "fail", "doc"] } },
    },
    available: async () => [{ alias: "svc", definition: { kind: "ok" }, enabled: true }],
    discover: async (query) => [{
        alias: `found-${query.query ?? "all"}`,
        definition: { kind: "ok" },
        provenance: { kind: "fixture", source: query.query ?? "catalog" },
    }],
    admit: async (input) => {
        const { alias, definition } = input as { alias?: string; definition: object };
        return { alias: alias ?? "anonymous", definition };
    },
    prepare: async ({ enabled, failure }) => {
        log.push(`prepare:${[...enabled.keys()].join(",")}`);
        const outcomes = new Map<string, FunctionalityPrepared["outcomes"] extends ReadonlyMap<string, infer V> ? V : never>();
        const runtimes: RuntimeRegistration[] = [];
        const documents: Array<{ pathname: string; content: string }> = [];
        for (const [alias, definition] of enabled) {
            const kind = (definition as { kind: string }).kind;
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
            commit: async () => { log.push(`commit:${[...enabled.keys()].join(",")}`); },
            abort: async () => { log.push(`abort:${[...enabled.keys()].join(",")}`); },
        };
    },
    teardown: async (snapshot) => { log.push(`teardown:${(snapshot as { aliases: string[] }).aliases.join(",")}`); },
});

test("{§functionality-document-body} an adapter's docs/<family>.md rides beneath the generated header; a wrong add example fails boot", async () => {
    const docsDir = await mkdtemp(join(tmpdir(), "plurnk-fx-docs-"));
    const db = await openMigrated();
    try {
        await mkdir(join(docsDir, "docs"));
        await writeFile(join(docsDir, "docs", "fx.md"), "# fx\n\n## Choosing a fixture\n\nAuthored fixture teaching.\n");
        const log: string[] = [];
        const daemon = new Daemon({ db, provider: null });
        daemon.registerModule({ setup: (seam: ModuleSetupSeam) => {
            seam.registerFunctionalityAdapter({ ...fixtureAdapter(log), docsDir, example: { alias: "one", definition: { kind: "ok" } } });
        } });
        await daemon.start();
        try {
            const workspaceId = await insertWorkspace(db, `fx-docs-${crypto.randomUUID()}`);
            await insertWorker(db, workspaceId, null, "model", "model");
            await daemon.invokeModuleAction("workspace.fx.list", {}, workspaceContext(workspaceId));
            const doc = (await daemon.engine.referenceEntries(workspaceId)).find(({ pathname }) => pathname === "/_plurnk/plurnk/fx.md");
            assert.ok(doc, "the family document is a reference entry");
            assert.equal(doc.content.startsWith("# fx\n\n## Summary\n\n````fx ("), true, "the generated header owns the H1 and the summary");
            assert.ok(doc.content.includes("## Tools"), "the generated verb table is present");
            assert.ok(doc.content.endsWith("## Choosing a fixture\n\nAuthored fixture teaching."), `the authored body closes the document, its authoring title removed:\n${doc.content}`);
            assert.equal((doc.content.match(/^# /gmu) ?? []).length, 1, "exactly one H1");
        } finally {
            await daemon.stop();
        }

        const wrong = new Daemon({ db, provider: null });
        wrong.registerModule({ setup: (seam: ModuleSetupSeam) => {
            seam.registerFunctionalityAdapter({ ...fixtureAdapter([]), example: { alias: "bogus", definition: { kind: "not-a-kind" } } });
        } });
        await assert.rejects(wrong.start(), /Functionality family 'fx' teaches an add example that violates its own definition schema/u,
            "a taught example that lies about the schema fails boot, never the model");
        await wrong.stop().catch(() => {});
    } finally {
        await db.close();
        await rm(docsDir, { recursive: true, force: true });
    }
});

const boot = async (db: Db, log: string[]): Promise<Daemon> => {
    const daemon = new Daemon({ db, provider: null });
    daemon.registerModule({ setup: (seam: ModuleSetupSeam) => { seam.registerFunctionalityAdapter(fixtureAdapter(log)); } });
    await daemon.start();
    return daemon;
};

const workspaceContext = (workspaceId: number) => ({ scope: "workspace" as const, workspaceId });

for (const defect of ["outcome", "namespace"] as const) {
    test(`{§functionality-publication} invalid ${defect} preparation aborts its candidate and preserves the workspace`, async (t) => {
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
                    : { ...prepared, runtimes: prepared.runtimes.map((runtime) => ({ ...runtime, namespaceOwner: "wrong owner" })) };
            },
        }); } });
        t.after(async () => { await daemon.stop(); await db.close(); });
        await daemon.start();
        const action = (verb: string, params = {}) => daemon.invokeModuleAction(`workspace.fx.${verb}`, params, workspaceContext(workspaceId));
        await action("list");
        log.length = 0;
        await assert.rejects(() => action("add", { alias: "candidate", definition: { kind: "ok" } }),
            defect === "outcome" ? /reported no outcome for enabled alias 'candidate'/u : /prepared a runtime owned by 'wrong owner'/u);
        assert.deepEqual(log.filter((entry) => entry.startsWith("abort:")), ["abort:candidate,svc"]);
        assert.equal(log.some((entry) => entry.startsWith("commit:")), false);
        const result = await action("list") as { definitions: Array<{ alias: string }> };
        assert.deepEqual(result.definitions.map(({ alias }) => alias), ["svc"]);
        const workerId = await insertWorker(db, workspaceId, null, "reader", "client");
        for (const [tag, expected] of [["svc", 200], ["candidate", 400]] as const) {
            const result = await daemon.dispatchAsClient({ workspaceId, workerId, statement: parseOne(PlurnkParser.frame(tag, "fixture")) });
            assert.equal(result.status, expected, `${tag}: ${JSON.stringify(result)}`);
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

test("{§functionality-coordinator} registration, client lifecycle, documents, persistence, and shared visibility through one owner", async () => {
    const db = await openMigrated();
    const log: string[] = [];
    const workspaceId = await insertWorkspace(db, `functionality-${crypto.randomUUID()}`);
    const client = await insertWorker(db, workspaceId, null, "client-1", "client");
    let daemon = await boot(db, log);
    const model = await daemon.ensureModelWorker(workspaceId);
    const invoke = <T>(verb: string, params: Readonly<Record<string, unknown>>): Promise<T> =>
        daemon.invokeModuleAction(`workspace.fx.${verb}`, params, workspaceContext(workspaceId)) as Promise<T>;
    const exec = (tag: string, workerId = client) =>
        daemon.dispatchAsClient({ workspaceId, workerId, statement: parseOne(`\`\`\`${tag}
fixture
\`\`\``) });
    const states = async () =>
        (await invoke<{ definitions: Array<{ alias: string; origin: string; state: string }> }>("list", {})).definitions
            .map(({ alias, origin, state }) => `${alias}:${origin}:${state}`);
    try {
        // Registration projects six workspace-scoped actions.
        assert.deepEqual(
            daemon.listModuleActions().map(({ name }) => name).filter((name) => name.startsWith("workspace.fx.")),
            ["workspace.fx.add", "workspace.fx.disable", "workspace.fx.discover", "workspace.fx.enable", "workspace.fx.list", "workspace.fx.remove"],
        );
        // Activation publishes the service default and the manager family.
        assert.deepEqual(await states(), ["svc:service:active"]);
        assert.equal((await exec("svc")).status, 200, "the service definition's capability is published");
        assert.equal((await exec("fx")).status, 400, "the manager family is published; a missing verb is refused, not unknown");

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
        // Service definitions are disable-only; a workspace definition may shadow one and removal reveals it, disabled.
        assert.equal((await rejectedProblem(() => invoke("remove", { alias: "svc" }))).type, "https://problems.plurnk.xyz/functionality/alias-service-owned");
        assert.equal((await invoke<{ definition: { state: string } }>("disable", { alias: "svc" })).definition.state, "disabled");
        assert.equal((await exec("svc")).status, 400);
        assert.equal((await invoke<{ definition: { origin: string; state: string } }>("add", { alias: "svc", definition: { kind: "ok" } })).definition.origin, "workspace", "a workspace definition shadows the service baseline");
        assert.equal((await exec("svc")).status, 200);
        assert.equal((await invoke<{ removed: boolean }>("remove", { alias: "svc" })).removed, true);
        assert.deepEqual((await states()).filter((s) => s.startsWith("svc:")), ["svc:service:disabled"], "removal reveals the service baseline, disabled");
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

        // Family documents reconcile with the snapshot under the generated subtree.
        await invoke("add", { alias: "docy", definition: { kind: "doc" } });
        await daemon.look({ workspaceId, workerId: model, statement: parseOne("```READ (worker:///_plurnk/fx/docy.md)```") });
        const document = await db.test_entries_by_coordinate_workspaces.all<{ workspace_id: number; content: string }>({ scheme: "worker", authority: "", pathname: "/_plurnk/fx/docy.md" });
        assert.deepEqual(document.map(({ workspace_id }) => workspace_id), [workspaceId], "both active readers use one shared family document");
        for (const { content } of document) assert.match(content, /fixture document/);
        await invoke("remove", { alias: "docy" });
        assert.deepEqual(await db.test_entries_by_coordinate_workspaces.all({ scheme: "worker", authority: "", pathname: "/_plurnk/fx/docy.md" }), [], "removal withdraws the document");

        // Persistence: a workspace-origin definition and a service enabledness survive restart.
        await invoke("add", { alias: "keep", definition: { kind: "ok" } });
        await daemon.stop();
        log.length = 0;
        daemon = await boot(db, log);
        assert.deepEqual(await states(), ["keep:workspace:active", "svc:service:disabled"], "durable state reconstructs the workspace's Functionality");
        assert.equal((await exec("keep")).status, 200);
        assert.ok(log.includes("prepare:keep"), "activation prepared exactly the enabled set");

        // Delegates use the same workspace environment, including subsequent changes.
        const child = await insertWorker(db, workspaceId, model, "child", "model");
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

test("{§functionality-publication} a failed publication restores state, runtime selection, and every generated document", async (t) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `publication-rollback-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId, null, "reader", "client");
    const daemon = await boot(db, []);
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.look({ workspaceId, workerId, statement: parseOne("```READ (worker:///_plurnk/plurnk/fx.md) <1,-1>```") });
    const materialize = LoopDocs.materialize;
    const cause = new Error("fixture document publication failed");
    let failed = false;
    t.mock.method(LoopDocs, "materialize", async (...args: Parameters<typeof LoopDocs.materialize>) => {
        if (!failed) { failed = true; throw cause; }
        await materialize(...args);
    });
    await assert.rejects(() => daemon.invokeModuleAction("workspace.fx.add", {
        alias: "docy", definition: { kind: "doc" },
    }, workspaceContext(workspaceId)), (error) => error === cause);
    const list = await daemon.invokeModuleAction("workspace.fx.list", {}, workspaceContext(workspaceId)) as {
        definitions: Array<{ alias: string }>;
    };
    assert.deepEqual(list.definitions.map(({ alias }) => alias), ["svc"]);
    assert.equal(daemon.schemes.has("docy", workspaceId), false);
    assert.deepEqual(await db.test_entries_by_coordinate_workspaces.all({
        scheme: "worker", authority: "", pathname: "/_plurnk/fx/docy.md",
    }), [], "rollback cannot leave a document from the rejected workspace snapshot");
});

test("{§functionality-publication} a management stream reports publication refusal instead of premature success", { timeout: 30_000 }, async (t) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `publication-result-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId, null, "client", "client");
    const log: string[] = [];
    const daemon = await boot(db, log);
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.invokeModuleAction("workspace.fx.list", {}, workspaceContext(workspaceId));
    const refused = Results.failure("fx:fixture", "publication-refused", 409, "Fixture publication refused.", {}, { retryable: true });
    t.mock.method(daemon, "replaceWorkspaceCapabilities", async () => {
        throw new OperationFailureError(refused);
    }, { times: 1 });
    const proposal = Promise.withResolvers<number>();
    const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => {
        if (method === "loop/proposal") proposal.resolve((params as { logEntryId: number }).logEntryId);
    });
    t.after(unsubscribe);
    const pending = daemon.dispatchAsClient({ workspaceId, workerId, statement: parseOne("```fx (add)\n{\"alias\":\"candidate\",\"definition\":{\"kind\":\"ok\"}}\n```") });
    await daemon.resolveProposal(await proposal.promise, { decision: "accept" });
    await pending;
    assert.deepEqual(await awaitExecOutcome(db, { workspaceId, scheme: "fx" }), refused,
        "the invoking stream carries the exact refused publication, not an active definition");
    assert.equal(log.filter((line) => line === "abort:candidate,svc").length, 1);
    const listing = await daemon.invokeModuleAction("workspace.fx.list", {}, workspaceContext(workspaceId)) as {
        definitions: Array<{ alias: string }>;
    };
    assert.deepEqual(listing.definitions.map(({ alias }) => alias), ["svc"]);
    assert.equal(daemon.schemes.has("candidate", workspaceId), false);
});

for (const hold of ["", "fx:host"]) {
    test(`{§functionality-model-mutation} a model uses its published tool with execution hold ${hold || "disabled"}`, { timeout: 30_000 }, async () => {
        const priorHold = process.env.PLURNK_SERVICE_EXEC_HOLD;
        process.env.PLURNK_SERVICE_EXEC_HOLD = hold;
        const task = (status: string) => PlurnkParser.frame("TASK", JSON.stringify([{ content: "Use the added tool.", status }]));
        const provider = new Mock({ contextWindow: 1_000_000, responses: [
            makeMockResponse(`${PlurnkParser.frame("fx (add)", JSON.stringify({ alias: "candidate", definition: { kind: "ok" } }))}\n${task("in_progress")}`),
            makeMockResponse(`${PlurnkParser.frame("candidate", "fixture")}\n${task("in_progress")}`),
            makeMockResponse(task("completed")),
        ] });
        const db = await openMigrated();
        const log: string[] = [];
        const daemon = new Daemon({ db, provider });
        daemon.registerModule({ setup: (seam) => { seam.registerFunctionalityAdapter(fixtureAdapter(log)); } });
        const ws = await connect({ daemon });
        try {
            await daemon.start();
            await rpcCall(ws, 1, "workspace.create", { name: `model-publication-${crypto.randomUUID()}` });
            const result = await runLoopToTerminal(ws, 2, { prompt: "Add and use the candidate fixture tool.", policy: { proposals: "accept" } });
            assert.equal(result.finalStatus, 200, JSON.stringify(result.result));
            assert.equal(log.filter((line) => line === "run:candidate").length, 1,
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

test("{§functionality-model-mutation} EXEC verbs are the same owner: read verbs run ungated, host verbs propose, acceptance publishes at the turn boundary", async () => {
    const db = await openMigrated();
    const log: string[] = [];
    const workspaceId = await insertWorkspace(db, `functionality-exec-${crypto.randomUUID()}`);
    const client = await insertWorker(db, workspaceId, null, "client-1", "client");
    const daemon = await boot(db, log);
    const states = async () =>
        (await daemon.invokeModuleAction("workspace.fx.list", {}, workspaceContext(workspaceId)) as { definitions: Array<{ alias: string; state: string; problem?: ProblemDetails }> }).definitions;
    const operate = (program: string) => daemon.dispatchAsClient({ workspaceId, workerId: client, statement: parseOne(program) });
    // A family verb streams its JSON outcome into the Worker's fx:// output
    // entry; the dispatch itself reports the started stream ({§exec-stream}).
    const verbResult = () => awaitExecOutcome(db, { workspaceId, scheme: "fx" });
    const proposals: number[] = [];
    const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => {
        if (method === "loop/proposal") proposals.push((params as { logEntryId: number }).logEntryId);
    });
    const accepted = async (program: string, decision: "accept" | "reject") => {
        const seen = proposals.length;
        const pending = operate(program);
        while (proposals.length === seen) await new Promise((resolve) => setTimeout(resolve, 5));
        await daemon.resolveProposal(proposals[seen]!, { decision });
        return pending;
    };
    try {
        // read verbs run ungated.
        const listed = await operate("```fx (list)```");
        assert.equal(listed.status, 200, "list is a read effect and starts ungated");
        assert.equal(proposals.length, 0, "no proposal was raised for a read verb");
        const listing = await verbResult();
        assert.equal((listing as { family?: string }).family, "fx", "the verb's JSON result streams into the family's output entry");

        // A host verb proposes; acceptance runs the same coordinator method and
        // the capability is live before the next operation.
        const added = await accepted("```fx (add)\n{\"alias\":\"viaexec\",\"definition\":{\"kind\":\"ok\"}}\n```", "accept");
        // An accepted settlement replaces the 202 with 200 ({§proposal-accept-applies});
        // the verb's own 201 and outcome ride in the results channel.
        assert.equal(added.status, 200, "the accepted add settled inside the turn");
        assert.equal((await operate("```viaexec\nfixture\n```")).status, 200, "publication settled at the turn boundary, before the next operation");
        assert.deepEqual((await states()).map(({ alias, state }) => `${alias}:${state}`), ["svc:active", "viaexec:active"]);

        // An operation's failed preparation publishes enabled-but-unavailable with its Problem.
        const down = await accepted("```fx (add)\n{\"alias\":\"down\",\"definition\":{\"kind\":\"fail\"}}\n```", "accept");
        assert.equal(down.status, 200);
        await operate("```fx (list)```");
        const downState = (await states()).find(({ alias }) => alias === "down");
        assert.equal(downState?.state, "unavailable");
        assert.equal(downState?.problem?.status, 502, "the enabled definition keeps its exact Problem");

        // Rejection performs nothing: no preparation, no state.
        log.length = 0;
        const rejected = await accepted("```fx (add)\n{\"alias\":\"nope\",\"definition\":{\"kind\":\"ok\"}}\n```", "reject");
        assert.equal(rejected.status, 400);
        assert.equal(log.some((entry) => entry.startsWith("prepare:") && entry.includes("nope")), false, "a rejected proposal never prepares");
        assert.equal((await states()).some(({ alias }) => alias === "nope"), false);

        // An unregistered verb is refused by the family registry (body refusals are the manager's own unit contract).
        assert.equal((await operate("```fx (destroy)```")).status, 404, "an unregistered verb is refused by the family registry with the verb list");

    } finally {
        unsubscribe();
        await daemon.stop();
        await db.close();
    }
});
