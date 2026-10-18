import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { FunctionalityAdmission, JsonSchema, WorkspaceCapabilityGate } from "@plurnk/plurnk-contracts";
import type { ModuleActionRegistration } from "@plurnk/plurnk-modules";
import Functionality from "./Functionality.ts";
import { OperationFailureError } from "../core/results.ts";
import WorkspaceGate from "../core/WorkspaceGate.ts";
import type { HostFunctionalityAdapter, WorkspaceCapabilityProvider } from "./ModuleHost.ts";

test("{§module-workspace-quiescence} a queued catalog refresh cannot block the current turn's admission refresh", { timeout: 5000 }, async () => {
    const gate = new WorkspaceGate(async () => false);
    const queued = Promise.withResolvers<void>();
    const publications: string[] = [];
    let provider!: WorkspaceCapabilityProvider;
    let state: unknown = null;
    const exclusively = async <T>(mode: WorkspaceCapabilityGate, run: () => Promise<T>): Promise<T> => {
        const hold = mode === "none" ? undefined
            : mode === "wait" ? gate.requestExclusive(1) : gate.tryExclusive(1);
        assert.notEqual(hold, null, "the fixture never requests a busy immediate mutation");
        if (mode === "wait") queued.resolve();
        try {
            await hold?.acquired;
            return await run();
        } finally { hold?.release(); }
    };
    const coordinator = new Functionality({
        signal: new AbortController().signal,
        registerModuleAction: () => {},
        registerWorkspaceCapabilityProvider: (_owner, value) => { provider = value; },
        readWorkspaceModuleState: async () => state,
        replaceWorkspaceCapabilities: async (replacement, options) => exclusively(options?.gate ?? "try", async () => {
            state = replacement.state;
            options?.publish?.();
            publications.push("published");
        }),
        readWorkerModuleState: async () => null,
        replaceWorkerModuleState: async () => {},
        withWorkspaceGate: (_workspaceId, _owner, mode, run) => exclusively(mode, run),
        atWorkspaceBoundary: (workspaceId, run) => gate.atBoundary(workspaceId, run),
        retainWorkspace: () => () => {},
        preparationChanged: () => {},
    });
    const handle = coordinator.register({
        family: "fixture",
        namespaceOwner: "fixture",
        summary: "Fixture capability",
        definitionSchema: { type: "object" },
        available: async () => [],
        admit: async () => ({ alias: "fixture", definition: {} }),
        prepare: async () => ({
            documents: [], outcomes: new Map(), snapshot: {},
            publish: () => undefined, commit: async () => {}, abort: async () => {},
        }),
        teardown: async () => {},
    });
    await provider.activate({ workspaceId: 1, retain: () => () => {} });
    assert.deepEqual(publications, ["published"]);
    const releaseTurn = await gate.acquireTurn(1, 1);
    const catalog = handle.refresh({ workspaceId: 1 });
    await queued.promise;
    let settled = false;
    const settling = coordinator.settle(1).then(() => { settled = true; });
    const admission = handle.refresh({ workspaceId: 1 }, { gate: "none", ifChanged: true });
    let finished = false;
    let settledWhileHeld = false;
    try {
        finished = await Promise.race([admission.then(() => true), delay(300).then(() => false)]);
        settledWhileHeld = settled;
        assert.deepEqual(publications, ["published"], "the queued refresh does not replace the current turn's snapshot");
    } finally {
        releaseTurn();
        await Promise.all([catalog, admission, settling]);
    }
    assert.equal(finished, true, "turn admission must finish while it owns the turn gate, not wait on a refresh that needs that gate");
    assert.equal(settledWhileHeld, false, "settle includes accepted publications still waiting for workspace admission");
    assert.equal(settled, true);
    assert.deepEqual(publications, ["published", "published"], "the queued refresh publishes after the turn releases");
});

// A coordinator over a host that records the actions it registers and holds no state.
const recording = (): { coordinator: Functionality; actions: Map<string, ModuleActionRegistration> } => {
    const actions = new Map<string, ModuleActionRegistration>();
    const coordinator = new Functionality({
        signal: new AbortController().signal,
        registerModuleAction: (registration) => { actions.set(registration.name, registration); },
        registerWorkspaceCapabilityProvider: () => {},
        readWorkspaceModuleState: async () => null,
        replaceWorkspaceCapabilities: async () => {},
        readWorkerModuleState: async () => null,
        replaceWorkerModuleState: async () => {},
        withWorkspaceGate: (_workspaceId, _owner, _mode, run) => run(),
        atWorkspaceBoundary: (_workspaceId, run) => run(),
        retainWorkspace: () => () => {},
        preparationChanged: () => {},
    });
    return { coordinator, actions };
};

const family = (name: string, overrides: Partial<HostFunctionalityAdapter> = {}): HostFunctionalityAdapter => ({
    family: name,
    namespaceOwner: name,
    summary: "Fixture capability",
    definitionSchema: { type: "object" },
    available: async () => [],
    admit: async () => ({ alias: "fixture", definition: {} }),
    prepare: async () => ({ documents: [], outcomes: new Map(), snapshot: {}, publish: () => undefined, commit: async () => {}, abort: async () => {} }),
    teardown: async () => {},
    ...overrides,
});

for (const phase of ["resolution", "preparation", "publication"] as const) {
    for (const cleanupFails of phase === "preparation" ? [false, true] : [false]) {
        test(`{§functionality-preparation-cancellation} stop during ${phase}, cleanup fails=${cleanupFails}`, async () => {
            const lifetime = new AbortController();
            const entered = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            const aborted = Promise.withResolvers<void>();
            const cleanup = Promise.withResolvers<void>();
            const reason = new DOMException("fixture stopping", "AbortError");
            const cleanupError = new Error("fixture candidate cleanup failed");
            const events: string[] = [];
            let provider!: WorkspaceCapabilityProvider;
            const hold = async (at: typeof phase) => {
                if (phase === at) { entered.resolve(); await release.promise; }
            };
            const coordinator = new Functionality({
                signal: lifetime.signal,
                registerModuleAction: () => {},
                registerWorkspaceCapabilityProvider: (_owner, value) => { provider = value; },
                readWorkspaceModuleState: async () => null,
                replaceWorkspaceCapabilities: async (_replacement, options) => {
                    events.push("publication");
                    await hold("publication");
                    options?.publish?.();
                },
                readWorkerModuleState: async () => null,
                replaceWorkerModuleState: async () => {},
                withWorkspaceGate: (_workspaceId, _owner, _mode, run) => run(),
                atWorkspaceBoundary: (_workspaceId, run) => run(),
                retainWorkspace: () => () => {},
                preparationChanged: () => {},
            });
            coordinator.register(family("fixture", {
                available: async () => { await hold("resolution"); return []; },
                prepare: async ({ signal }) => {
                    events.push("preparation");
                    assert.equal(signal, lifetime.signal, "the adapter receives the owning lifetime");
                    await hold("preparation");
                    return {
                        documents: [], outcomes: new Map(), snapshot: {},
                        publish: () => { events.push("publish"); return undefined; },
                        commit: async () => { events.push("commit"); },
                        abort: async () => {
                            events.push("abort");
                            aborted.resolve();
                            await cleanup.promise;
                            if (cleanupFails) throw cleanupError;
                        },
                    };
                },
            }));
            let settled = false;
            const pending = Promise.resolve(provider.activate({ workspaceId: 1, retain: () => () => {} }));
            const work = (phase === "publication" ? pending : assert.rejects(pending, (cause) => {
                if (!cleanupFails) return cause === reason;
                assert.ok(cause instanceof AggregateError);
                assert.deepEqual(cause.errors, [reason, cleanupError]);
                return true;
            })).then(() => { settled = true; });
            try {
                await entered.promise;
                lifetime.abort(reason);
                release.resolve();
                if (phase === "preparation") {
                    await aborted.promise;
                    assert.equal(settled, false, "cancellation joins candidate cleanup");
                }
            } finally { release.resolve(); cleanup.resolve(); }
            await work;
            assert.deepEqual(events, phase === "resolution" ? []
                : phase === "preparation" ? ["preparation", "abort"] : ["preparation", "publication", "publish", "commit"]);
        });
    }
}

for (const scope of ["workspace", "worker"] as const) {
    test(`{§functionality-admission-preparation} ${scope} admission data reaches only its candidate preparation`, async () => {
        let provider!: WorkspaceCapabilityProvider;
        let state: unknown = null;
        let refuse = false;
        let aborts = 0;
        const seen: Array<FunctionalityAdmission | undefined> = [];
        const payload = { readAt: 42 };
        const publish = (next: unknown): void => {
            if (refuse) throw new Error("fixture publication refused");
            state = structuredClone(next);
        };
        const coordinator = new Functionality({
            signal: new AbortController().signal,
            registerModuleAction: () => {},
            registerWorkspaceCapabilityProvider: (_owner, value) => { provider = value; },
            readWorkspaceModuleState: async () => state,
            replaceWorkspaceCapabilities: async (replacement, options) => {
                publish(replacement.state);
                options?.publish?.();
            },
            readWorkerModuleState: async () => state,
            replaceWorkerModuleState: async (_worker, _owner, next) => { publish(next); },
            withWorkspaceGate: (_workspaceId, _owner, _mode, run) => run(),
            atWorkspaceBoundary: (_workspaceId, run) => run(),
            retainWorkspace: () => () => {},
            preparationChanged: () => {},
        });
        const handle = coordinator.register(family("fixture", {
            scopes: [scope],
            admit: async (input) => ({ ...input as { alias: string; definition: object }, preparation: payload }),
            prepare: async ({ enabled, admissions }) => {
                seen.push(admissions[0]);
                return {
                    documents: [],
                    outcomes: new Map([...enabled.keys()].map((alias) => [alias, { state: "active" as const }])),
                    snapshot: null,
                    publish: () => undefined,
                    commit: async () => {},
                    abort: async () => { aborts += 1; },
                };
            },
        }));
        if (scope === "workspace") await provider.activate({ workspaceId: 1, retain: () => () => {} });
        const identity = { workspaceId: 1, workerId: 2, scope };
        const input = { alias: "entry", definition: { value: "original" } };
        const added = await handle.invoke("replace", input, identity);
        assert.deepEqual(seen.at(-1), { ...input, preparation: payload });
        assert.equal(seen.at(-1)?.preparation, payload, "opaque admission data is passed through, not cloned into the definition");
        assert.deepEqual(state, { version: 1, definitions: { entry: { origin: scope, definition: input.definition, enabled: true } } });
        assert.equal(JSON.stringify(added.body).includes("readAt"), false, "admission data is not configuration output");

        const changed = { alias: "entry", definition: { value: "changed" } };
        const count = seen.length;
        await assert.rejects(handle.invoke("add", changed, identity), (cause: unknown) => {
            assert.ok(cause instanceof OperationFailureError);
            assert.equal(cause.result.problem?.type, "https://problems.plurnk.xyz/functionality/alias-exists");
            return true;
        });
        assert.equal(seen.length, count, "a refused admission never reaches preparation");
        const before = structuredClone(state);
        refuse = true;
        await assert.rejects(handle.invoke("replace", changed, identity), /fixture publication refused/u);
        assert.deepEqual(state, before, "publication refusal preserves durable state");
        assert.equal(aborts, 1);
        refuse = false;
        if (scope === "workspace") await handle.refresh(identity);
        else await handle.invoke("list", {}, identity);
        assert.equal(seen.at(-1), undefined, "a subsequent preparation has no stale admission data");
        assert.deepEqual(state, before);
        await handle.invoke("replace", changed, identity);
        assert.deepEqual(state, { version: 1, definitions: { entry: { origin: scope, definition: changed.definition, enabled: true } } });
    });
}

const QUERY = { type: "string", minLength: 1 };
const CONFIGURATION = {
    description: "Caller-supplied configuration material the family interprets as candidates (a client's own PLURNK_A2A_* environment, a local directory list). It contributes candidates with client-configuration provenance; it never becomes durable authority.",
    type: "object",
};

test("{§functionality-discover-advertisement} discover's input schema carries exactly the declared inputs, at least one unless an empty request lists everything", () => {
    const { coordinator, actions } = recording();
    const discover = async () => [];
    coordinator.register(family("one", { discovery: { inputs: ["source"] }, discover }));
    coordinator.register(family("two", { discovery: { inputs: ["source", "configuration"] }, discover }));
    coordinator.register(family("all", { discovery: { inputs: ["query", "source"], emptyListsAll: true }, discover }));
    coordinator.register(family("scoped", { scopes: ["worker", "workspace"], discovery: { inputs: ["query"] }, discover }));
    coordinator.register(family("none"));
    const schema = (name: string): JsonSchema | undefined => actions.get(name)?.inputSchema;
    assert.deepEqual(schema("workspace.one.discover"), {
        type: "object", additionalProperties: false, properties: { source: QUERY }, required: ["source"],
    });
    assert.deepEqual(schema("workspace.two.discover"), {
        type: "object", additionalProperties: false, properties: { source: QUERY, configuration: CONFIGURATION },
        anyOf: [{ required: ["source"] }, { required: ["configuration"] }],
    });
    assert.deepEqual(schema("workspace.all.discover"), {
        type: "object", additionalProperties: false, properties: { query: QUERY, source: QUERY },
    }, "an empty request lists everything, so it names no input");
    for (const scope of ["worker", "workspace"]) {
        assert.deepEqual(schema(`${scope}.scoped.discover`), {
            type: "object", additionalProperties: false, required: ["query"],
            properties: { query: QUERY, scope: { enum: ["worker", "workspace"], description: "Definition scope; model calls default to worker." } },
        }, "a multi-scope family's discover adds scope beside its inputs");
    }
    assert.deepEqual([...actions.keys()].filter((name) => name.startsWith("workspace.none.")).toSorted(),
        ["add", "disable", "enable", "list", "remove", "replace"].map((verb) => `workspace.none.${verb}`),
        "a family without discovery registers no discover action");
});

test("{§functionality-discover-advertisement} the shared schema check refuses an input the family does not serve, naming it", async () => {
    const { coordinator } = recording();
    const received: unknown[] = [];
    coordinator.register(family("fixture", { discovery: { inputs: ["source"] }, discover: async (query) => { received.push(query); return []; } }));
    const refusal = async (params: object) => {
        const cause = await coordinator.invoke("fixture", "discover", params, { workspaceId: 1 }, "operation").then(() => undefined, (error: unknown) => error);
        assert.ok(cause instanceof OperationFailureError, `a refusal is an operation result, not ${String(cause)}`);
        return cause.result.problem;
    };
    for (const [params, field] of [[{ source: "here", query: "term" }, '"query"'], [{ configuration: {} }, '"configuration"'], [{}, '"source"']] as const) {
        const problem = await refusal(params);
        assert.equal(problem.type, "https://problems.plurnk.xyz/functionality/arguments-invalid");
        assert.equal(problem.status, 400);
        assert.equal(problem.detail, "fixture discover arguments do not match their schema.");
        assert.ok((problem.errors as Array<{ error: string }>).some(({ error }) => error.includes(field)), `the errors name ${field}: ${JSON.stringify(problem.errors)}`);
    }
    assert.deepEqual(received, [], "no refused request reaches the adapter");
    await coordinator.invoke("fixture", "discover", { source: "here" }, { workspaceId: 1 }, "operation");
    assert.deepEqual(received, [{ source: "here" }]);
});

test("{§functionality-discovery-inputs} registration refuses an empty, repeated or unknown input, and discovery without discover or the reverse", () => {
    const discover = async () => [];
    const refused: Array<[string, Partial<HostFunctionalityAdapter>]> = [
        ["empty", { discovery: { inputs: [] }, discover }],
        ["repeated", { discovery: { inputs: ["query", "query"] }, discover }],
        ["unknown", { discovery: { inputs: ["registry" as "query"] }, discover }],
    ];
    for (const [name, overrides] of refused) {
        assert.throws(() => recording().coordinator.register(family(name, overrides)), new RegExp(`Functionality family '${name}' declares invalid discovery inputs\\.`, "u"));
    }
    assert.throws(() => recording().coordinator.register(family("undeclared", { discover })), /'undeclared' must declare discovery exactly when it implements discover\./u);
    assert.throws(() => recording().coordinator.register(family("unimplemented", { discovery: { inputs: ["query"] } })), /'unimplemented' must declare discovery exactly when it implements discover\./u);
});
