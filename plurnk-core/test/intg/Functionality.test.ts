// {§functionality-coordinator} — the shared Worker Functionality lifecycle proven
// through a fixture adapter: one client projection, one generated model family,
// one durable Worker-owned state, one atomic publication.
import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser, Problems } from "@plurnk/plurnk-contracts";
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
import { insertWorkspace, insertWorker, openMigrated } from "./_helpers.ts";
import type { Db } from "../../src/core/Db.ts";

const OWNER = "fx fixture adapter";

const parseOne = (input: string): PlurnkStatement => {
    const parsed = PlurnkParser.parse(`# PLAN0\n${input}`);
    const item = parsed.items.find((x) => x.kind === "statement" && x.statement.op !== "PLAN");
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
                entryOwner: "resolved", inherit: "none", writableBy: ["plugin"], volatile: true, modelVisible: true,
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

const boot = async (db: Db, log: string[]): Promise<Daemon> => {
    const daemon = new Daemon({ db, provider: null });
    daemon.registerModule({ setup: (seam: ModuleSetupSeam) => { seam.registerFunctionalityAdapter(fixtureAdapter(log)); } });
    await daemon.start();
    return daemon;
};

const workerContext = (workspaceId: number, workerId: number) => ({ scope: "worker" as const, workspaceId, workerId });

const rejectedProblem = async (run: () => Promise<unknown>): Promise<ProblemDetails> => {
    try { await run(); } catch (error) {
        assert.ok(error instanceof OperationFailureError, `expected an operation failure, got ${String(error)}`);
        return error.result.problem;
    }
    assert.fail("Expected operation failure.");
};

test("{§functionality-coordinator} registration, client lifecycle, documents, persistence, and inheritance through one owner", async () => {
    const db = await openMigrated();
    const log: string[] = [];
    const workspaceId = await insertWorkspace(db, `functionality-${crypto.randomUUID()}`);
    const model = await insertWorker(db, workspaceId, null, "conversation", "model");
    const client = await insertWorker(db, workspaceId, null, "client-1", "client");
    let daemon = await boot(db, log);
    const invoke = <T>(verb: string, params: Readonly<Record<string, unknown>>, workerId = model): Promise<T> =>
        daemon.invokeModuleAction(`worker.fx.${verb}`, params, workerContext(workspaceId, workerId)) as Promise<T>;
    const exec = (tag: string, workerId = client, functionalityWorkerId = model) =>
        daemon.dispatchAsClient({ workspaceId, workerId, functionalityWorkerId, statement: parseOne(`## EXEC0 [${tag}]\nfixture`) });
    const states = async (workerId = model) =>
        (await invoke<{ definitions: Array<{ alias: string; origin: string; state: string }> }>("list", {}, workerId)).definitions
            .map(({ alias, origin, state }) => `${alias}:${origin}:${state}`);
    try {
        // Registration projects six worker-scoped actions.
        assert.deepEqual(
            daemon.listModuleActions().map(({ name }) => name).filter((name) => name.startsWith("worker.fx.")),
            ["worker.fx.add", "worker.fx.disable", "worker.fx.discover", "worker.fx.enable", "worker.fx.list", "worker.fx.remove"],
        );
        // Activation publishes the service default and the manager family.
        assert.deepEqual(await states(), ["svc:service:active"]);
        assert.equal((await exec("svc")).status, 200, "the service definition's capability is published");
        assert.equal((await exec("fx")).status, 400, "the manager family is published; a missing verb is refused, not unknown");

        // add → active and hot.
        const added = await invoke<{ status: number; definition: { state: string } }>("add", { alias: "alpha", definition: { kind: "ok" } });
        assert.equal(added.status, 201);
        assert.equal(added.definition.state, "active");
        assert.deepEqual(await states(), ["alpha:worker:active", "svc:service:active"]);
        assert.equal((await exec("alpha")).status, 200, "add hotloads the capability before the next operation");
        // discover is inert.
        const discovered = await invoke<{ candidates: Array<{ alias: string }> }>("discover", { query: "term" });
        assert.deepEqual(discovered.candidates.map(({ alias }) => alias), ["found-term"]);
        assert.deepEqual(await states(), ["alpha:worker:active", "svc:service:active"], "discovery persisted nothing");
        // disable withdraws; enable restores.
        assert.equal((await invoke<{ definition: { state: string } }>("disable", { alias: "alpha" })).definition.state, "disabled");
        assert.equal((await exec("alpha")).status, 501, "a disabled definition is model-invisible");
        assert.deepEqual(await states(), ["alpha:worker:disabled", "svc:service:active"]);
        assert.equal((await invoke<{ definition: { state: string } }>("enable", { alias: "alpha" })).definition.state, "active");
        assert.equal((await exec("alpha")).status, 200);
        // A failed client preparation rejects and persists nothing.
        const refused = await rejectedProblem(() => invoke("add", { alias: "broken", definition: { kind: "fail" } }));
        assert.equal(refused.status, 502);
        assert.deepEqual(await states(), ["alpha:worker:active", "svc:service:active"]);
        // Collisions and unknown aliases are exact.
        assert.equal((await rejectedProblem(() => invoke("add", { alias: "alpha", definition: { kind: "ok" } }))).type, "https://problems.plurnk.dev/functionality/alias-exists");
        assert.equal((await rejectedProblem(() => invoke("enable", { alias: "ghost" }))).type, "https://problems.plurnk.dev/functionality/alias-unknown");
        // Service definitions are disable-only; a worker definition may shadow one and removal reveals it, disabled.
        assert.equal((await rejectedProblem(() => invoke("remove", { alias: "svc" }))).type, "https://problems.plurnk.dev/functionality/alias-service-owned");
        assert.equal((await invoke<{ definition: { state: string } }>("disable", { alias: "svc" })).definition.state, "disabled");
        assert.equal((await exec("svc")).status, 501);
        assert.equal((await invoke<{ definition: { origin: string; state: string } }>("add", { alias: "svc", definition: { kind: "ok" } })).definition.origin, "worker", "a worker definition shadows the service baseline");
        assert.equal((await exec("svc")).status, 200);
        assert.equal((await invoke<{ removed: boolean }>("remove", { alias: "svc" })).removed, true);
        assert.deepEqual((await states()).filter((s) => s.startsWith("svc:")), ["svc:service:disabled"], "removal reveals the service baseline, disabled");
        // remove withdraws and forgets.
        const removed = await invoke<{ status: number; removed: boolean }>("remove", { alias: "alpha" });
        assert.equal(removed.status, 200);
        assert.equal(removed.removed, true);
        assert.deepEqual(await states(), ["svc:service:disabled"]);
        assert.equal((await exec("alpha")).status, 501);

        // Rollback: a publication the host refuses (a runtime name the base
        // registry already owns) aborts the preparation and changes nothing.
        log.length = 0;
        await assert.rejects(() => invoke("add", { alias: "sh", definition: { kind: "ok" } }), /sh|owner|collid|claim/i);
        assert.ok(log.some((entry) => entry.startsWith("abort:")), "the adapter aborted its prepared snapshot");
        assert.ok(!log.some((entry) => entry.startsWith("commit:")), "nothing was committed");
        assert.deepEqual(await states(), ["svc:service:disabled"], "durable state is unchanged after a failed publication");
        assert.equal((await exec("svc")).status, 501, "the previous snapshot remains authoritative");

        // Family documents reconcile with the snapshot under the generated subtree.
        await invoke("add", { alias: "docy", definition: { kind: "doc" } });
        const document = await db.test_entries_by_coordinate_owners.all<{ owner_id: number; content: string }>({ scheme: "worker", authority: "", pathname: "/_plurnk/fx/docy.md" });
        assert.deepEqual(document.map(({ owner_id }) => owner_id), [model], "the family document is materialized in the Worker's generated subtree");
        assert.match(document[0]!.content, /fixture document/);
        await invoke("remove", { alias: "docy" });
        assert.deepEqual(await db.test_entries_by_coordinate_owners.all({ scheme: "worker", authority: "", pathname: "/_plurnk/fx/docy.md" }), [], "removal withdraws the document");

        // Persistence: a worker-origin definition and a service enabledness survive restart.
        await invoke("add", { alias: "keep", definition: { kind: "ok" } });
        await daemon.stop();
        log.length = 0;
        daemon = await boot(db, log);
        assert.deepEqual(await states(), ["keep:worker:active", "svc:service:disabled"], "durable state reconstructs the Worker's Functionality");
        assert.equal((await exec("keep")).status, 200);
        assert.ok(log.includes("prepare:keep"), "activation prepared exactly the enabled set");

        // Inheritance by value: a child snapshots at birth and diverges.
        const child = await insertWorker(db, workspaceId, model, "child", "model");
        assert.deepEqual(await states(child), ["keep:worker:active", "svc:service:disabled"]);
        await invoke("add", { alias: "later", definition: { kind: "ok" } });
        assert.deepEqual(await states(), ["keep:worker:active", "later:worker:active", "svc:service:disabled"]);
        assert.deepEqual(await states(child), ["keep:worker:active", "svc:service:disabled"], "a later parent mutation does not reach an existing child");
        await invoke("disable", { alias: "keep" }, child);
        assert.deepEqual(await states(), ["keep:worker:active", "later:worker:active", "svc:service:disabled"], "a child mutation does not reach its parent");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§functionality-model-mutation} EXEC verbs are the same owner: read verbs run ungated, host verbs propose, acceptance publishes at the turn boundary", async () => {
    const db = await openMigrated();
    const log: string[] = [];
    const workspaceId = await insertWorkspace(db, `functionality-exec-${crypto.randomUUID()}`);
    const model = await insertWorker(db, workspaceId, null, "conversation", "model");
    const client = await insertWorker(db, workspaceId, null, "client-1", "client");
    const daemon = await boot(db, log);
    const states = async () =>
        (await daemon.invokeModuleAction("worker.fx.list", {}, workerContext(workspaceId, model)) as { definitions: Array<{ alias: string; state: string; problem?: ProblemDetails }> }).definitions;
    const operate = (program: string) => daemon.dispatchAsClient({ workspaceId, workerId: client, functionalityWorkerId: model, statement: parseOne(program) });
    // A family verb streams its JSON outcome into the Worker's fx:// output entry;
    // the dispatch itself reports the started stream. Read the newest settled result.
    const verbResult = async (): Promise<{ status?: number; [key: string]: unknown }> => {
        for (let attempt = 0; attempt < 200; attempt++) {
            const outputs = await db.test_entries_by_scheme_prefix.all<{ pathname: string }>({ workspace_id: workspaceId, scheme: "fx", prefix: "/%" });
            const newest = outputs.at(-1);
            if (newest !== undefined) {
                const channel = await db.test_get_channel_by_pathname_scheme.get<{ content: string; state: string }>({ pathname: newest.pathname, scheme: "fx", name: "results" });
                if (channel?.state === "closed" && channel.content.length > 0) return JSON.parse(channel.content) as { status?: number };
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("the family verb never settled its results stream");
    };
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
        const listed = await operate("## EXEC0 [fx] (list)");
        assert.equal(listed.status, 200, "list is a read effect and starts ungated");
        assert.equal(proposals.length, 0, "no proposal was raised for a read verb");
        const listing = await verbResult();
        assert.equal((listing as { family?: string }).family, "fx", "the verb's JSON result streams into the family's output entry");

        // A host verb proposes; acceptance runs the same coordinator method and
        // the capability is live before the next operation.
        const added = await accepted('## EXEC0 [fx] (add)\n{"alias":"viaexec","definition":{"kind":"ok"}}', "accept");
        // An accepted settlement replaces the 202 with 200 ({§proposal-accept-applies});
        // the verb's own 201 and outcome ride in the results channel.
        assert.equal(added.status, 200, "the accepted add settled inside the turn");
        assert.equal((await operate("## EXEC0 [viaexec]\nfixture")).status, 200, "publication settled at the turn boundary, before the next operation");
        assert.deepEqual((await states()).map(({ alias, state }) => `${alias}:${state}`), ["svc:active", "viaexec:active"]);

        // An operation's failed preparation publishes enabled-but-unavailable with its Problem.
        const down = await accepted('## EXEC0 [fx] (add)\n{"alias":"down","definition":{"kind":"fail"}}', "accept");
        assert.equal(down.status, 200);
        await operate("## EXEC0 [fx] (list)");
        const downState = (await states()).find(({ alias }) => alias === "down");
        assert.equal(downState?.state, "unavailable");
        assert.equal(downState?.problem?.status, 502, "the enabled definition keeps its exact Problem");

        // Rejection performs nothing: no preparation, no state.
        log.length = 0;
        const rejected = await accepted('## EXEC0 [fx] (add)\n{"alias":"nope","definition":{"kind":"ok"}}', "reject");
        assert.equal(rejected.status, 400);
        assert.equal(log.some((entry) => entry.startsWith("prepare:") && entry.includes("nope")), false, "a rejected proposal never prepares");
        assert.equal((await states()).some(({ alias }) => alias === "nope"), false);

        // An unregistered verb is refused by the family registry (body refusals are the manager's own unit contract).
        assert.equal((await operate("## EXEC0 [fx] (destroy)")).status, 404, "an unregistered verb is refused by the family registry with the verb list");

    } finally {
        unsubscribe();
        await daemon.stop();
        await db.close();
    }
});
