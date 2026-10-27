import assert from "node:assert/strict";
import test, { describe } from "node:test";
import Functionality from "./Functionality.ts";
import WorkspaceGate from "../core/WorkspaceGate.ts";
import ConfigurationDiagnostics from "./ConfigurationDiagnostics.ts";
import EnvFunctionality from "./EnvFunctionality.ts";
import FunctionalityManager, { FUNCTIONALITY_VERBS, plurnkRuntimeDecl, type FunctionalityVerb } from "./FunctionalityManager.ts";
import { setTimeout as delay } from "node:timers/promises";
import { type FunctionalityAdmission, type JsonSchema, type WorkspaceCapabilityGate, Problems } from "@plurnk/plurnk-contracts";
import { type ModuleActionRegistration } from "@plurnk/plurnk-modules";
import { OperationFailureError } from "../core/results.ts";
import { type HostFunctionalityAdapter, type WorkspaceCapabilityProvider } from "./ModuleHost.ts";
import { ConfigurationError } from "@plurnk/plurnk-meta";

describe("Functionality", () => {
test("{§module-workspace-residency} a queued catalog refresh cannot block the current turn's admission refresh", { timeout: 5000 }, async () => {
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
        readSessionModuleState: async () => null,
        replaceSessionModuleState: async () => {},
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
        readSessionModuleState: async () => null,
        replaceSessionModuleState: async () => {},
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
        test(`{§functionality-adapter} stop during ${phase}, cleanup fails=${cleanupFails}`, async () => {
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
                readSessionModuleState: async () => null,
                replaceSessionModuleState: async () => {},
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

for (const scope of ["workspace", "session"] as const) {
    test(`{§functionality-adapter} ${scope} admission data reaches only its candidate preparation`, async () => {
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
            readSessionModuleState: async () => state,
            replaceSessionModuleState: async (_session, _owner, next) => { publish(next); },
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
        const identity = { workspaceId: 1, sessionId: 2, scope };
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
    description: "Caller-supplied configuration material the family interprets as candidates (a client's own PLURNK_SCHEDULE_* environment, a local directory list). It contributes candidates with client-configuration provenance; it never becomes durable authority.",
    type: "object",
};

test("{§functionality-replacement} discover's input schema carries exactly the declared inputs, at least one unless an empty request lists everything", () => {
    const { coordinator, actions } = recording();
    const discover = async () => [];
    coordinator.register(family("one", { discovery: { inputs: ["source"] }, discover }));
    coordinator.register(family("two", { discovery: { inputs: ["source", "configuration"] }, discover }));
    coordinator.register(family("all", { discovery: { inputs: ["query", "source"], emptyListsAll: true }, discover }));
    coordinator.register(family("scoped", { scopes: ["session", "workspace"], discovery: { inputs: ["query"] }, discover }));
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
    for (const scope of ["session", "workspace"]) {
        assert.deepEqual(schema(`${scope}.scoped.discover`), {
            type: "object", additionalProperties: false, required: ["query"],
            properties: { query: QUERY, scope: { enum: ["session", "workspace"], description: "Definition scope; model calls default to session." } },
        }, "a multi-scope family's discover adds scope beside its inputs");
    }
    assert.deepEqual([...actions.keys()].filter((name) => name.startsWith("workspace.none.")).toSorted(),
        ["add", "disable", "enable", "list", "remove", "replace"].map((verb) => `workspace.none.${verb}`),
        "a family without discovery registers no discover action");
});

test("{§functionality-replacement} the shared schema check refuses an input the family does not serve, naming it", async () => {
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

test("{§functionality-adapter} registration refuses an empty, repeated or unknown input, and discovery without discover or the reverse", () => {
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
});

describe("ConfigurationDiagnostics", () => {
test("{§configuration-repair-path} configuration containment preserves valid values and exact operator diagnostics", async () => {
    const diagnostics = new ConfigurationDiagnostics();
    const config = { command: "fixture" };
    assert.equal(await diagnostics.capture("hooks", () => config), config);
    const error = new ConfigurationError("PLURNK_HOOKS_ARGS", "PLURNK_HOOKS_ARGS must be a JSON array of strings.");
    assert.equal(await diagnostics.capture("hooks", () => { throw error; }), null);
    assert.deepEqual(diagnostics.notices(), [{
        source: "engine:configuration", kind: "configuration_unavailable", level: "warn",
        owner: "hooks", key: error.key, message: error.message,
    }]);
});

test("{§configuration-repair-path} internal failures cannot be contained as configuration errors", async () => {
    const diagnostics = new ConfigurationDiagnostics();
    const error = new Error("broken internal invariant");
    await assert.rejects(() => diagnostics.capture("hooks", async () => { throw error; }), (cause) => cause === error);
    assert.deepEqual(diagnostics.notices(), []);
});

test("{§configuration-repair-path} repeated discovery diagnostics are deduplicated without turning shadowing into failure", () => {
    const diagnostics = new ConfigurationDiagnostics();
    const error = new ConfigurationError("fixture/plugin.json", "Broken native declaration.");
    diagnostics.record("extensions", error);
    diagnostics.record("extensions", error);
    const reports = [
        { root: "/plugins/shadowed", path: "", section: "client", outcome: "shadowed" as const, message: "A nearer definition wins." },
        { root: "/plugins/invalid", path: "mcp.json", section: "client", outcome: "invalid" as const, message: "Invalid configuration." },
    ];
    diagnostics.pluginReports(reports);
    diagnostics.pluginReports(reports);
    assert.deepEqual(diagnostics.notices().map(({ kind, level }) => ({ kind, level })), [
        { kind: "configuration_unavailable", level: "warn" },
        { kind: "plugin_configuration", level: "info" },
        { kind: "plugin_configuration", level: "warn" },
    ]);
});

test("{§operator-config-precedence} an undeclared key is one warn notice naming the key and the file, recorded once", () => {
    const diagnostics = new ConfigurationDiagnostics();
    diagnostics.undeclared("PLURNK_FIXTURE_TYPO", "/home/operator/.config/plurnk/.env");
    diagnostics.undeclared("PLURNK_FIXTURE_TYPO", "/home/operator/.config/plurnk/.env");
    assert.deepEqual(diagnostics.notices(), [{
        source: "engine:configuration", kind: "configuration_undeclared", level: "info", key: "PLURNK_FIXTURE_TYPO",
        message: "`PLURNK_FIXTURE_TYPO` is set in /home/operator/.config/plurnk/.env and no installed package declares it.",
    }]);
});
});

describe("EnvFunctionality", () => {
// The contract types a definition as `object`, deliberately: the coordinator does not know any
// family's shape. A test that reads through it narrows first rather than asserting on `any`.
const valueOf = (definition: object): string => {
    assert.ok("value" in definition && typeof definition.value === "string", "an env definition carries a string value");
    return definition.value;
};

const FILES = [{
    owner: "@plurnk/plurnk-execs",
    parsed: {},
    text: "# A pager that waits for a keypress hangs a spawn that has no terminal.\nPAGER=cat\n# Service configuration.\nPLURNK_WITNESS_KNOB=1\n# Provider credential.\nGEMINI_API_KEY=",
}];

const adapter = new EnvFunctionality(async () => FILES);
const identity = { workspaceId: 1 };

test("{§functionality-coordinator} env defaults to session scope and supports shared workspace defaults", () => {
    assert.deepEqual(adapter.scopes, ["session", "workspace"]);
    assert.equal(adapter.family, "env");
});

// The coordinator's shared grammar is lowercase-hyphen (skill names, MCP server ids). An
// environment variable is uppercase with underscores, and its case is semantic, so the family
// declares the shell's grammar and the coordinator enforces that one instead.
test("{§functionality-adapter} env declares the shell's alias grammar: PATH is an alias, path-1 is not", () => {
    assert.equal(adapter.aliasPattern.test("PATH"), true);
    assert.equal(adapter.aliasPattern.test("CARGO_TARGET_DIR"), true);
    assert.equal(adapter.aliasPattern.test("_leading_underscore"), true);
    assert.equal(adapter.aliasPattern.test("path-1"), false, "the shared lowercase-hyphen shape is not a shell name");
    assert.equal(adapter.aliasPattern.test("9NOPE"), false);
});

test("{§env-functionality} admit accepts a name a shell can export", async () => {
    const admitted = await adapter.admit({ alias: "CARGO_TARGET_DIR", definition: { value: "/tmp/shared" } }, identity);
    assert.deepEqual(admitted, { alias: "CARGO_TARGET_DIR", definition: { value: "/tmp/shared" } });
});

test("{§env-functionality} admit refuses a name a shell could not export", async () => {
    await assert.rejects(
        () => adapter.admit({ alias: "9NOPE", definition: { value: "x" } }, identity),
        /is not a name a shell can export/u,
    );
});

test("{§execution-output-identity} reserved names are refused at family admission", async (t) => {
    const previous = process.env.PLURNK_PROVIDERS_PROVIDER_ENVFIXTURE_API_KEY_ENV;
    process.env.PLURNK_PROVIDERS_PROVIDER_ENVFIXTURE_API_KEY_ENV = "CUSTOM_PROVIDER_TOKEN";
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_PROVIDERS_PROVIDER_ENVFIXTURE_API_KEY_ENV;
        else process.env.PLURNK_PROVIDERS_PROVIDER_ENVFIXTURE_API_KEY_ENV = previous;
    });
    for (const alias of ["PLURNK_SERVICE_DB_PATH", "GEMINI_API_KEY", "DEEPSEEK_API_KEY", "CUSTOM_PROVIDER_TOKEN"]) {
        const refused = (cause: unknown): boolean => {
            assert.ok(cause instanceof OperationFailureError);
            assert.equal(cause.result.status, 400);
            assert.equal(cause.result.problem.type, "https://problems.plurnk.xyz/env/functionality/name-reserved");
            assert.equal(cause.result.problem.alias, alias);
            assert.equal(cause.result.problem.detail, `'${alias}' is reserved in env entries.`);
            assert.equal(cause.result.problem.recovery, "READ workspace:///_plurnk/tools/plurnk/env.json for supported configuration paths.");
            return true;
        };
        await assert.rejects(() => adapter.admit({ alias, definition: { value: "explicit-value" } }, identity), refused);
    }
});

test("{§env-functionality} admit refuses a non-string value", async () => {
    await assert.rejects(
        () => adapter.admit({ alias: "COUNT", definition: { value: 3 } }, identity),
        /needs a string value/u,
    );
});

test("{§env-functionality} discover projects the configuration catalog as addable candidates", async () => {
    const [candidate] = await adapter.discover({ query: "PAGER" }, identity);
    assert.equal(candidate.alias, "PAGER");
    assert.equal(valueOf(candidate.definition), "cat");
    assert.equal(candidate.provenance.source, "@plurnk/plurnk-execs");
});

test("{§env-functionality} discover distinguishes an unknown source from a known source with no matches", async () => {
    const source = "@plurnk/plurnk-execs";
    assert.deepEqual((await adapter.discover({ source }, identity)).map(({ alias }) => alias), ["PAGER"]);
    assert.deepEqual(await adapter.discover({ source, query: "not-a-declared-name" }, identity), []);
    for (const rejected of [".env", "/tmp/settings.env", "@plurnk/not-installed"]) {
        await assert.rejects(adapter.discover({ source: rejected }, identity), (cause: unknown) => {
            assert.ok(cause instanceof OperationFailureError);
            assert.equal(cause.result.status, 400);
            assert.equal(cause.result.problem.type, "https://problems.plurnk.xyz/env/functionality/source-unknown");
            assert.equal(cause.result.problem.source, rejected);
            assert.match(cause.result.problem.detail, /package in the configuration catalog/u);
            assert.match(String(cause.result.problem.recovery), /READ/u);
            return true;
        });
    }
});

test("{§env-functionality} discover projects only what a Session may set, and matches a declaration's comment", async () => {
    assert.deepEqual((await adapter.discover({}, identity)).map(({ alias }) => alias), ["PAGER"], "plurnk's own names never appear");
    assert.deepEqual((await adapter.discover({ query: "keypress" }, identity)).map(({ alias }) => alias), ["PAGER"], "a Session finds a name by what it is for");
    assert.deepEqual(await adapter.discover({ query: "PLURNK_WITNESS_KNOB" }, identity), [], "not even by exact name");
    assert.deepEqual(await adapter.discover({ query: "GEMINI_API_KEY" }, identity), [], "MCP credential bindings do not make provider names env-family candidates");
});

test("{§env-functionality} available projects what the ceiling admits, enabled, in name order", async () => {
    const previous = process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT;
    process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = "ZED_LAST,ALPHA_FIRST";
    process.env.ALPHA_FIRST = "a";
    process.env.ZED_LAST = "z";
    try {
        const available = await adapter.available(identity);
        assert.deepEqual(available.map(({ alias }) => alias), ["ALPHA_FIRST", "ZED_LAST"], "sorted by name");
        // Values are projected: the ceiling is the security boundary, not this projection, and any
        // admitted name is already readable by every command the session runs.
        assert.equal(valueOf(available[0].definition), "a");
        assert.ok(available.every(({ enabled }) => enabled), "an admitted name is enabled until the session disables it");
    } finally {
        delete process.env.ALPHA_FIRST;
        delete process.env.ZED_LAST;
        if (previous === undefined) delete process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT;
        else process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = previous;
    }
});

// Nothing is launched, so nothing can fail to launch. This is why the family prepares no
// runtimes: the field is the resident family's facet ({§module-workspace-residency}).
test("{§env-functionality} prepare publishes no runtime and marks every enabled definition active", async () => {
    const prepared = await adapter.prepare({
        signal: new AbortController().signal,
        workspaceId: 1,
        enabled: new Map([["PAGER", { definition: { value: "cat" } }], ["CI", { definition: { value: "1" } }]]),
        previous: null,
        failure: "publish-unavailable",
        progress: () => undefined,
    } as never);
    assert.equal("runtimes" in prepared, false, "no processes, so no resident facet");
    assert.deepEqual([...prepared.outcomes.keys()], ["PAGER", "CI"]);
    assert.deepEqual([...prepared.outcomes.values()], [{ state: "active" }, { state: "active" }]);
});

// {§execution-output-identity} — one rule for the spawn and its record: what the command receives and why.
test("{§execution-output-identity} compose applies the Session's state over the ambient ceiling and records each name's provenance", () => {
    const { env, record } = EnvFunctionality.compose({ PATH: "/usr/bin", CI: "1", TERM: "xterm" }, { version: 1, definitions: {
        CARGO_TARGET_DIR: { origin: "session", enabled: true, definition: { value: "/tmp/shared" } },
        TOOLCHAIN: { origin: "session", enabled: true, definition: { value: "stable" }, inherited: "alice" },
        CI: { origin: "service", enabled: false, inherited: "alice" },
        TERM: { origin: "service", enabled: true },
        OFF: { origin: "session", enabled: false, definition: { value: "x" } },
        PLURNK_SERVICE_DB_PATH: { origin: "session", enabled: true, definition: { value: "/tmp/steal.db" } },
    } });
    assert.deepEqual(env, { PATH: "/usr/bin", TERM: "xterm", CARGO_TARGET_DIR: "/tmp/shared", TOOLCHAIN: "stable" });
    assert.deepEqual(record, {
        PATH: { source: "host", value: "/usr/bin" },
        TERM: { source: "host", value: "xterm" },
        CARGO_TARGET_DIR: { source: "session", value: "/tmp/shared" },
        TOOLCHAIN: { source: "session", from: "alice", value: "stable" },
        CI: { source: "masked", from: "alice" },
        OFF: { source: "masked" },
        PLURNK_SERVICE_DB_PATH: { source: "masked" },
    });
    assert.throws(() => EnvFunctionality.compose({}, { version: 2 }), /not a version 1 record/u, "a foreign state shape is a defect, never a fallback");
});
});

describe("FunctionalityManager", () => {
const invocations: Array<{ family: string; verb: string; params: unknown; caller: string }> = [];
const identities: unknown[] = [];
const emptySchema = { type: "object" };
const inputSchemas: Record<FunctionalityVerb, JsonSchema> = {
    list: emptySchema, discover: emptySchema, add: emptySchema, replace: emptySchema,
    enable: emptySchema, disable: emptySchema, remove: emptySchema,
};
const coordinator = {
    invoke: async (family: string, verb: string, params: unknown, identity: unknown, caller: string) => {
        assert.equal((identity as { workspaceId: number }).workspaceId, 1, "every invocation carries the workspace the manager closed over");
        identities.push(identity);
        invocations.push({ family, verb, params, caller });
        return { status: verb === "add" ? 201 : 200, body: { family, verb, params } };
    },
} as unknown as Functionality;

const args = (target: string | null, body: string) => {
    const written: string[] = [];
    const states: string[] = [];
    const emitted: unknown[] = [];
    return {
        args: {
            runtime: "plurnk", body, cwd: null, target, signal: new AbortController().signal,
            write: (_channel: string, chunk: string) => { written.push(chunk); },
            setState: (_channel: string, state: string) => { states.push(state); },
            emit: (notice: unknown) => { emitted.push(notice); },
            interact: async () => ({ status: "cancelled" as const }),
        } as never,
        written,
        states,
        emitted,
    };
};

test("{§functionality-model-projection} each family tool carries its verb union and coordinator properties without a second signature or field-table definition", () => {
    const definitionSchema = {
        type: "object", required: ["kind"],
        properties: {
            kind: { enum: ["ok", "slow"], description: "The fixture kind." },
            options: { type: "object", properties: { retries: { type: "integer", description: "Attempts before giving up." } } },
        },
    };
    const schemas = { ...inputSchemas, add: {
        type: "object", required: ["definition"], properties: { alias: { type: "string" }, definition: definitionSchema },
    } };
    const manager = new FunctionalityManager({
        family: "fx", workspaceId: 1, coordinator,
        inputSchemas: schemas,
        example: { alias: "a", definition: { kind: "ok" } },
        discovery: { inputs: ["source"], details: "`source` is one fixture locator." },
    });
    const tool = manager.toolRegistry().tools.find((candidate) => candidate.target === "fx")!;
    assert.deepEqual(tool.invocation.inputSchema, {
        type: "object",
        additionalProperties: false,
        required: ["verb"],
        properties: {
            verb: {
                type: "string",
                enum: [...FUNCTIONALITY_VERBS],
                description: "The lifecycle verb to run (defaults to list when the body is empty).",
            },
            alias: { type: "string" },
            definition: definitionSchema,
        },
    });
    assert.equal(tool.invocation.signature, undefined);
    assert.match(tool.details ?? "", /\n```plurnk \(fx\)\n\{"verb":"add","alias":"a","definition":\{"kind":"ok"\}\}\n/u, "one exact example rides the family teaching");
    assert.doesNotMatch(tool.details ?? "", /\| Field|options\.retries/u);
    assert.match(tool.details ?? "", /fixture locator/u);
});

test("{§functionality-replacement} an addressing family's tool teaches its own add input, selects by its operand, and offers no replace", () => {
    const { replace: _replace, ...addressed } = {
        ...inputSchemas,
        add: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } } },
        enable: { type: "object", required: ["file"], properties: { file: { type: "string" } } },
        disable: { type: "object", required: ["file"], properties: { file: { type: "string" } } },
        remove: { type: "object", required: ["file"], properties: { file: { type: "string" } } },
    };
    const manager = new FunctionalityManager({ family: "fx", workspaceId: 1, coordinator, inputSchemas: addressed, example: { files: ["docs/**"] } });
    const [tool] = manager.toolRegistry().tools;
    assert.equal(tool.target, "fx");
    const verbProp = (tool.invocation.inputSchema?.properties as Record<string, { enum?: string[] }> | undefined)?.verb;
    assert.deepEqual(verbProp?.enum, FUNCTIONALITY_VERBS.filter((verb) => verb !== "replace"));
    assert.match(tool.details ?? "", /\n```plurnk \(fx\)\n\{"verb":"add","files":\["docs\/\*\*"\]\}\n/u, "the example is the family's add input, verbatim");
});

test("{§functionality-model-projection} the plurnk manager exposes family tools and question with read/host effects", () => {
    const manager = new FunctionalityManager({
        family: "fx", workspaceId: 1, coordinator, inputSchemas,
        documentBody: "# fx\n\nAuthored body.",
        includeQuestion: true,
    });
    assert.deepEqual(manager.toolRegistry().tools.map(({ target }) => target), ["fx", "question"]);
    assert.deepEqual(
        FUNCTIONALITY_VERBS.map((verb) => manager.effectForInvocation("fx", JSON.stringify({ verb }))),
        ["read", "read", "host", "host", "host", "host", "host"],
    );
    assert.equal(manager.effectForInvocation("fx", ""), "read", "an empty body defaults to list (read)");
    assert.equal(manager.effectForInvocation("fx", '{"verb":"destroy"}'), "host", "an unregistered verb can never run ungated");
    assert.equal(manager.effectForInvocation("question", '{"message":"?"}'), "read", "question is always a read");
    assert.equal(manager.manifest.name, "plurnk");
    assert.equal(plurnkRuntimeDecl.invocation.target?.kind, "literal");
    assert.equal(plurnkRuntimeDecl.resourcesPath, "/tools");
    assert.equal(plurnkRuntimeDecl.expandTools, true);
    const fxTool = manager.toolRegistry().tools.find(({ target }) => target === "fx")!;
    assert.match(fxTool.details ?? "", /Authored body\./u, "the family's doc-file body rides the tool's details");
});

test("{§functionality-replacement} a family without discovery has no discover verb, and its manager names the verbs it has", async () => {
    invocations.length = 0;
    const { discover: _discover, ...served } = inputSchemas;
    const manager = new FunctionalityManager({ family: "fx", workspaceId: 1, coordinator, inputSchemas: served });
    const [tool] = manager.toolRegistry().tools;
    const verbProp = (tool.invocation.inputSchema?.properties as Record<string, { enum?: string[] }> | undefined)?.verb;
    assert.deepEqual(verbProp?.enum, ["list", "add", "replace", "enable", "disable", "remove"]);
    const refused = await manager.run(args("fx", '{"verb": "discover", "query": "x"}').args);
    assert.equal(refused.status, 400);
    assert.equal(refused.problem?.type, "https://problems.plurnk.xyz/functionality/verb-unknown");
    assert.equal(refused.problem?.detail, "'discover' is not a fx lifecycle verb.");
    assert.equal(refused.problem?.recovery, "Select one of list, add, replace, enable, disable, remove.");
    assert.deepEqual(invocations, [], "the refusal never reaches the coordinator");
});

test("{§functionality-model-projection} a verb runs through the coordinator as an operation and streams its JSON result", async () => {
    invocations.length = 0;
    const manager = new FunctionalityManager({ family: "fx", workspaceId: 1, coordinator, inputSchemas });
    const { args: runArgs, written, states } = args("fx", '{"verb":"add","alias":"a","definition":{"kind":"ok"}}');
    const result = await manager.run(runArgs);
    assert.equal(result.status, 201);
    assert.deepEqual(invocations, [{ family: "fx", verb: "add", params: { alias: "a", definition: { kind: "ok" } }, caller: "operation" }]);
    assert.deepEqual(states, ["active", "closed"]);
    assert.deepEqual(JSON.parse(written.join("")), { family: "fx", verb: "add", params: { alias: "a", definition: { kind: "ok" } } });
});

test("{§functionality-model-projection} every family's owned refusal survives its management executor", async () => {
    const problem = Problems.create("fixture:management", "unavailable", 502, "The source could not be inspected.", {
        source: "fixture", recovery: "Inspect the configured source.", retryable: false,
    });
    const result = { status: 502, problem };
    for (const cause of [new OperationFailureError(result), Object.assign(new Error(problem.detail), { problem })]) {
        const manager = new FunctionalityManager({
            family: "fx", workspaceId: 1, inputSchemas,
            coordinator: { invoke: async () => { throw cause; } } as unknown as Functionality,
        });
        const { args: runArgs, written, states } = args("fx", '{"verb":"discover"}');
        assert.deepEqual(await manager.run(runArgs), result);
        assert.deepEqual(JSON.parse(written.join("")), result);
        assert.deepEqual(states, ["active", "errored"]);
    }
});

test("{§functionality-model-projection} a pending resource sign-in emits an authorization notice while holding for the settled outcome", async () => {
    const body = { status: 201, family: "mcp", alias: "remote", definition: {
        alias: "remote", origin: "workspace", state: "active",
    } };
    const manager = new FunctionalityManager({
        family: "mcp", workspaceId: 1, inputSchemas,
        coordinator: { invoke: async (_f: string, _v: string, _p: unknown, _i: unknown, _c: string, options?: { onAuthorizationRequired?: (aliases: readonly string[]) => void }) => {
            options?.onAuthorizationRequired?.(["remote"]);
            return { status: 201, body };
        } } as unknown as Functionality,
    });
    const { args: runArgs, written, states, emitted } = args("mcp", '{"verb":"add"}');
    assert.deepEqual(await manager.run(runArgs), { status: 201 });
    assert.deepEqual(emitted, [{
        source: "functionality:mcp",
        kind: "authorization_required",
        level: "info",
        message: "MCP server 'remote' awaits sign-in (/mcp oauth remote).",
    }]);
    assert.deepEqual(states, ["active", "closed"]);
    assert.deepEqual(JSON.parse(written.join("")), body);
});

test("{§functionality-model-projection} an unexpected exception is not reclassified as a managed refusal", async () => {
    for (const cause of [new Error("internal fixture failure"), Object.assign(new Error("malformed failure"), { problem: { status: 502 } })]) {
        const manager = new FunctionalityManager({
            family: "fx", workspaceId: 1, inputSchemas,
            coordinator: { invoke: async () => { throw cause; } } as unknown as Functionality,
        });
        const { args: runArgs, written, states } = args("fx", '{"verb":"discover"}');
        await assert.rejects(() => manager.run(runArgs), (error) => error === cause);
        assert.deepEqual(written, []);
        assert.deepEqual(states, []);
    }
});

test("{§functionality-model-projection} an empty body defaults to list; a non-JSON body and an unknown verb are exact refusals", async () => {
    invocations.length = 0;
    const manager = new FunctionalityManager({ family: "fx", workspaceId: 1, coordinator, inputSchemas });
    assert.equal((await manager.run(args("fx", "   ").args)).status, 200);
    assert.deepEqual(invocations.at(-1), { family: "fx", verb: "list", params: {}, caller: "operation" });
    const refused = await manager.run(args("fx", "not json").args);
    assert.equal(refused.status, 400);
    assert.equal(refused.problem?.type, "https://problems.plurnk.xyz/functionality/arguments-not-json");
    const unknown = await manager.run(args("fx", '{"verb":"destroy"}').args);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.problem?.type, "https://problems.plurnk.xyz/functionality/verb-unknown");
    assert.equal(invocations.length, 1, "refusals never reach the coordinator");
});

// {§functionality-coordinator} — the published manager closes over the coordinator; Core binds the invoking
// workspace and session per operation, and the binding is never retained.
test("{§functionality-model-projection} Core binds the invoking session at the operation; the published manager stays workspace-wide", async () => {
    invocations.length = 0;
    identities.length = 0;
    const manager = new FunctionalityManager({ family: "fx", workspaceId: 1, coordinator, inputSchemas });
    assert.equal((await manager.run(args("fx", "").args)).status, 200);
    assert.equal((await manager.forSession(7).run(args("fx", "").args)).status, 200);
    assert.equal((await manager.run(args("fx", "").args)).status, 200);
    assert.deepEqual(identities, [{ workspaceId: 1 }, { workspaceId: 1, sessionId: 7 }, { workspaceId: 1 }],
        "the bound instance names its session; the published instance never does");
    assert.deepEqual(manager.forSession(7).toolRegistry().tools.map(({ target }) => target), ["fx"], "binding changes the identity, not the teaching");
});
});
