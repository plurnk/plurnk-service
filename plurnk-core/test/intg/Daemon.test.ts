import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Daemon from "../../src/server/Daemon.ts";
import ServiceTeardown from "../../src/core/ServiceTeardown.ts";
import Dsl from "./dsl.ts";
import Results, { OperationFailureError } from "../../src/core/results.ts";
import skillsModule from "@plurnk/plurnk-skills/module";
import { TEST_OWNER } from "./_approval.ts";
import { rpcCall, connect, withDaemon, waitFor, HARNESS_WAIT_MS } from "./_rpc.ts";
import { insertWorkspace, insertSession, openMigrated } from "./_db.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { bindListener } from "./_http.ts";
import { type RuntimeRegistration, type Executor } from "@plurnk/plurnk-execs";
import { type HostSetupSeam } from "../../src/server/ModuleHost.ts";
import { Validator, type ApplicationActionContext, type ProblemDetails } from "@plurnk/plurnk-contracts";
import { type ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import { Mock } from "@plurnk/plurnk-providers";


describe("Daemon", () => {
const MODULE_INPUT_SCHEMA = { type: "object", additionalProperties: true } as const;
const MODULE_OUTPUT_SCHEMA = { type: "object", additionalProperties: true } as const;

const lateWakeFailures: string[] = [];
const consoleError = console.error;
console.error = (...args: unknown[]): void => {
    const rendered = args.map(String).join(" ");
    if (/wake-on-completion/.test(rendered)) lateWakeFailures.push(rendered);
    else consoleError(...args);
};
test.after(() => {
    console.error = consoleError;
    assert.deepEqual(
        lateWakeFailures,
        [],
        "the real daemon/execution teardown path leaves no wake task beyond database ownership",
    );
});

// A stand-in registration in the daemon-module setup shape:
// framework types only — decl + executor + the driver's probe result. The kernel wraps the
// RegistryEntry itself; registration needs no live driver (the scheme face reads lazily at dispatch).
const fakeRegistration = (tag: string) => ({
    namespaceOwner: "daemon test module",
    decl: {
        name: tag,
        glyph: "🔌",
        summary: `${tag} fixture.`,
        invocation: { body: { role: "fixture input", required: true }, example: { body: "fixture" } },
    },
    executor: {
        runtime: tag, glyph: "🔌",
        get manifest() {
            return {
                name: tag,
                channels: { results: "application/json" },
                defaultChannel: "results",
                category: "data",
                writableBy: [],
                volatile: true,
                modelVisible: true,
            } as never;
        },
        get defaultChannel() { return "results"; },
        get channels() { return { results: { mimetype: "application/json" } }; },
        run: async () => ({ status: 200 }),
        probe: async () => ({ available: true, detail: "fake" }),
        effect: () => "read",
    } as unknown as Executor,
    availability: { available: true, detail: "fake" },
});

const rejectedProblem = async (run: () => unknown): Promise<ProblemDetails> => {
    try {
        await run();
    } catch (error) {
        assert.ok(error instanceof OperationFailureError);
        return error.result.problem;
    }
    assert.fail("Expected operation failure.");
};

test("{§methods} Daemon: listenerless boot — the seam is live with no socket bound", async () => {
    await withDaemon(null, async (_db, daemon, _addr) => {
        // No port, no listener — the seam itself is the surface. A basic seam read proves boot.
        const workspaces = await daemon.listWorkspaces();
        assert.ok(Array.isArray(workspaces), "the seam answers");
    });
});

test("{§manifest} {§mimetype-discovery} Daemon composes deterministic scheme and MIME display capabilities for clients", async () => {
    const db = await openMigrated();
    const mimetypes = new Mimetypes({
        discovery: {
            registry: { byExtension: new Map(), byFilename: new Map() },
            handlers: new Map([
                ["text/plain", {
                    mimetype: "text/plain",
                    glyph: "📄",
                    packageName: "@plurnk/plurnk-mimetypes-text-plain",
                    projectionRevision: "test-1",
                    extensions: [".txt"],
                    binary: false,
                    source: "package" as const,
                }],
                ["application/x-unmarked", {
                    mimetype: "application/x-unmarked",
                    glyph: "",
                    packageName: "@acme/mimetype-unmarked",
                    projectionRevision: "test-1",
                    extensions: [],
                    binary: false,
                    source: "package" as const,
                }],
            ]),
            packageAttributions: new Map(), skipped: [],
        },
    });
    const daemon = new Daemon({ db, provider: null, mimetypes });
    daemon.schemes.register("figma", {
        manifest: {
            name: "figma",
            channels: { body: "application/json" },
            defaultChannel: "body",
            category: "data",
            writableBy: ["model"],
            volatile: true,
            modelVisible: true,
            glyph: "󰕧",
        },
    });
    try {
        await skillsModule().setup(daemon);
        const capabilities = await daemon.listClientDisplayCapabilities();
        Validator.assertClientDisplayCapabilities(capabilities);
        assert.deepEqual(
            capabilities.filter((capability) => capability.kind === "scheme"),
            [
                { kind: "scheme", scheme: "figma", display: { glyph: "󰕧" } },
                { kind: "scheme", scheme: "file", display: {} },
                { kind: "scheme", scheme: "log", display: {} },
                { kind: "scheme", scheme: "mcp", display: {} },
                { kind: "scheme", scheme: "message", display: {} },
                { kind: "scheme", scheme: "note", display: {} },
                { kind: "scheme", scheme: "ops", display: {} },
                { kind: "scheme", scheme: "persona", display: {} },
                { kind: "scheme", scheme: "plurnk", display: {} },
                { kind: "scheme", scheme: "reasoning", display: {} },
                { kind: "scheme", scheme: "session", display: {} },
                { kind: "scheme", scheme: "skill", display: {} },
                { kind: "scheme", scheme: "workspace", display: {} },
            ],
        );
        assert.deepEqual(
            capabilities.filter((capability) => capability.kind === "mimetype"),
            [
                { kind: "mimetype", mimetype: "application/x-unmarked", display: {} },
                { kind: "mimetype", mimetype: "text/plain", display: { glyph: "📄" } },
            ],
        );
        assert.equal(
            capabilities.some((capability) => capability.kind === "scheme" && capability.scheme === "exec"),
            false,
            "the internal execution implementation is not advertised as an addressable URI scheme",
        );
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§mimetype} Daemon boot reports mimetype packages withheld by the shared trust gate", async () => {
    const db = await openMigrated();
    const discovery = {
        registry: { byExtension: new Map<string, string>(), byFilename: new Map<string, string>() },
        handlers: new Map(),
        packageAttributions: new Map(),
        skipped: ["@acme/acme-mime-private"],
    };
    const daemon = new Daemon({
        db,
        provider: null,
        mimetypes: new Mimetypes({ discovery }),
    });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => { warnings.push(args.map(String).join(" ")); };
    try {
        await daemon.start();
        assert.ok(
            warnings.some((warning) => /mimetype discovery.*@acme\/acme-mime-private.*untrusted.*not registered/.test(warning)),
            "the composed host names the package and trust decision",
        );
    } finally {
        console.warn = originalWarn;
        await daemon.stop();
        await db.close();
    }
});

test("{§module-seam-slices} Daemon: module actions register once during setup and invoke through ApplicationPort", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    const calls: Array<{
        params: Readonly<Record<string, unknown>>;
        context: ApplicationActionContext;
    }> = [];
    daemon.registerModule({
        setup: (seam) => {
            assert.throws(
                () => seam.registerModuleAction({
                    name: "",
                    scope: "daemon",
                    residency: "none",
                    inputSchema: MODULE_INPUT_SCHEMA,
                    outputSchema: MODULE_OUTPUT_SCHEMA,
                    handler: async () => ({}),
                }),
                /action name must not be empty/,
            );
            assert.throws(
                () => seam.registerModuleAction({
                    name: "example.invalid",
                    scope: "daemon",
                    residency: "none",
                    inputSchema: { $ref: "https://example.invalid/Missing.json" },
                    outputSchema: MODULE_OUTPUT_SCHEMA,
                    handler: async () => ({}),
                }),
                /module action 'example\.invalid' has an invalid input schema/,
            );
            seam.registerModuleAction({
                name: "example.inspect",
                scope: "daemon",
                residency: "none",
                inputSchema: MODULE_INPUT_SCHEMA,
                outputSchema: MODULE_OUTPUT_SCHEMA,
                handler: async (params, context) => {
                    calls.push({ params, context });
                    return { inspected: params.target };
                },
            });
            assert.throws(
                () => seam.registerModuleAction({
                    name: "example.inspect",
                    scope: "daemon",
                    residency: "none",
                    inputSchema: MODULE_INPUT_SCHEMA,
                    outputSchema: MODULE_OUTPUT_SCHEMA,
                    handler: async () => ({}),
                }),
                /module action 'example\.inspect' is already registered/,
            );
        },
    }, "test-module");
    try {
        await daemon.start();
        // {§functionality-coordinator} Core families and the discovered default modules register beside the
        // module's own action.
        const families = ["workspace.skills.", "workspace.members.", "session.env.", "workspace.env.", "workspace.schedule.", "workspace.mcp."];
        assert.deepEqual(daemon.listModuleActions().filter(({ name }) => !families.some((prefix) => name.startsWith(prefix))), [{
            name: "example.inspect",
            scope: "daemon",
            inputSchema: MODULE_INPUT_SCHEMA,
            outputSchema: MODULE_OUTPUT_SCHEMA,
        }]);
        assert.deepEqual(
            daemon.listModuleActions().map(({ name }) => name).filter((name) => name.startsWith("workspace.skills.")),
            ["workspace.skills.add", "workspace.skills.disable", "workspace.skills.discover", "workspace.skills.enable", "workspace.skills.list", "workspace.skills.remove", "workspace.skills.replace"],
        );
        for (const scope of ["session", "workspace"]) {
            assert.deepEqual(
                daemon.listModuleActions().filter(({ name }) => name.startsWith(`${scope}.env.`)).map((action) => ({ name: action.name, scope: action.scope })),
                ["add", "disable", "discover", "enable", "list", "remove", "replace"].map((verb) => ({ name: `${scope}.env.${verb}`, scope })),
            );
        }
        assert.deepEqual(
            await daemon.invokeModuleAction(
                "example.inspect",
                { target: "sample" },
                { scope: "daemon" },
            ),
            { inspected: "sample" },
        );
        assert.deepEqual(calls, [{
            params: { target: "sample" },
            context: { scope: "daemon" },
        }]);
        await assert.rejects(
            () => daemon.invokeModuleAction("missing", {}, { scope: "daemon" }),
            /module action 'missing' is not registered/,
        );
        await assert.rejects(
            () => daemon.invokeModuleAction(
                "example.inspect",
                {},
                { scope: "workspace", workspaceId: 1 },
            ),
            /requires daemon context, not workspace/,
        );
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§module-seam-slices} passive scoped actions validate identities without activating capabilities", async (t) => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    let calls = 0;
    let activations = 0;
    daemon.registerModule({ setup: (seam) => {
        seam.registerWorkspaceCapabilityProvider("passive fixture", {
            activate: () => { activations++; }, deactivate: () => undefined,
        });
        for (const scope of ["workspace", "session"] as const) seam.registerModuleAction({
            name: `${scope}.passive`, scope, residency: "none",
            inputSchema: MODULE_INPUT_SCHEMA, outputSchema: MODULE_OUTPUT_SCHEMA,
            handler: async () => { calls++; return { inspected: true }; },
        });
    } }, "test-module");
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const workspaceId = await insertWorkspace(db, "passive-actions");
    const sessionId = await insertSession(db, workspaceId, null, "reader", "model");
    for (const scope of ["workspace", "session"] as const) {
        const context = scope === "workspace" ? { scope, workspaceId } : { scope, workspaceId, sessionId };
        assert.deepEqual(await daemon.invokeModuleAction(`${scope}.passive`, {}, context), { inspected: true });
        const problem = await rejectedProblem(() => daemon.invokeModuleAction(`${scope}.passive`, {}, { ...context, workspaceId: 999_999 }));
        assert.equal(problem.status, 404);
        assert.match(problem.detail, /does not exist/);
    }
    assert.equal(calls, 2, "invalid contexts cannot reach a passive handler");
    assert.equal(activations, 0, "identity validation never starts the workspace's capabilities");
});

test("{§connection-lifecycle} Daemon: workspace Functionality is shared, demand-activated, and durable across restart", async () => {
    const db = await openMigrated();
    const owner = "workspace Functionality test module";
    const tag = "workspacecap";
    const workspaceId = await insertWorkspace(db, `workspace-functionality-${crypto.randomUUID()}`);
    const peerWorkspaceId = await insertWorkspace(db, `peer-functionality-${crypto.randomUUID()}`);
    const firstSessionId = await insertSession(db, workspaceId, null, "first", "model");
    const secondSessionId = await insertSession(db, workspaceId, null, "second", "model");
    const peerSessionId = await insertSession(db, peerWorkspaceId, null, "peer", "model");
    await db.workspace_module_state_put.run({
        workspace_id: workspaceId, namespace_owner: owner, state: JSON.stringify({ source: "workspace" }),
    });
    const executions: number[] = [];
    const activated: number[] = [];
    let setupSeam: HostSetupSeam | null = null;
    const activeSetupSeam = (): HostSetupSeam => {
        if (setupSeam === null) throw new Error("Functionality setup seam was not handed to the module");
        return setupSeam;
    };
    const registration = (id: number): RuntimeRegistration => {
        const base = fakeRegistration(tag);
        return {
            ...base,
            namespaceOwner: owner,
            executor: {
                ...base.executor,
                run: async () => { executions.push(id); return { status: 200 }; },
            },
        };
    };
    const capabilityModule = {
        setup: (seam: HostSetupSeam): void => {
            setupSeam = seam;
            seam.registerWorkspaceCapabilityProvider(owner, {
                activate: async ({ workspaceId: id }) => {
                    activated.push(id);
                    const state = await seam.readWorkspaceModuleState(id, owner);
                    const detached = typeof state === "object" && state !== null
                        && (state as { detached?: unknown }).detached === true;
                    await seam.replaceWorkspaceCapabilities({
                        workspaceId: id, namespaceOwner: owner, state,
                        runtimes: detached ? [] : [registration(id)],
                    });
                },
                deactivate: async () => undefined,
            });
        },
    };
    // A person's client operation acting for one of the workspace's sessions ({§connection-lifecycle}).
    const dispatch = async (daemon: Daemon, id: number, sessionId: number) => (await daemon.dispatchClientAction({
        workspaceId: id, actor: TEST_OWNER, contextSessionId: sessionId, statements: [Dsl.buildExec({ runtime: tag, command: "fixture" })],
    }))[0];
    const daemon = new Daemon({ db, provider: null });
    assert.throws(() => daemon.registerWorkspaceCapabilityProvider("incomplete fixture",
        { activate: async () => undefined } as never), /requires activate and deactivate functions/);
    daemon.registerModule(capabilityModule, "test-module");
    try {
        await daemon.start();
        await daemon.attachWorkspace({ workspaceId });
        await daemon.attachWorkspace({ workspaceId });
        assert.deepEqual(activated, [], "boot and attachment are passive");

        assert.equal((await dispatch(daemon, workspaceId, firstSessionId)).status, 200);
        assert.equal((await dispatch(daemon, workspaceId, secondSessionId)).status, 200);
        assert.equal((await dispatch(daemon, peerWorkspaceId, peerSessionId)).status, 200);
        assert.deepEqual(activated, [workspaceId, peerWorkspaceId], "one activation per workspace");
        assert.deepEqual(executions, [workspaceId, workspaceId, peerWorkspaceId]);

        await activeSetupSeam().replaceWorkspaceCapabilities({
            workspaceId, namespaceOwner: owner, state: { detached: true }, runtimes: [],
        });
        for (const sessionId of [firstSessionId, secondSessionId]) {
            assert.equal((await dispatch(daemon, workspaceId, sessionId)).status, 400,
                "withdrawal changes the tool surface in this workspace, whichever session an operation acts for");
        }
        assert.equal((await dispatch(daemon, peerWorkspaceId, peerSessionId)).status, 200,
            "a different workspace keeps its independent environment");
        assert.deepEqual(await activeSetupSeam().readWorkspaceModuleState(workspaceId, owner), { detached: true });

        await assert.rejects(() => activeSetupSeam().replaceWorkspaceCapabilities({
            workspaceId, namespaceOwner: owner, state: { corrupted: true },
            runtimes: [{ ...registration(workspaceId), decl: { ...registration(workspaceId).decl, name: "session" } }],
        }), /reserved/);
        assert.deepEqual(await activeSetupSeam().readWorkspaceModuleState(workspaceId, owner), { detached: true },
            "a rejected snapshot cannot mutate durable state");
    } finally {
        await daemon.stop();
    }

    const restored = new Daemon({ db, provider: null });
    restored.registerModule(capabilityModule, "test-module");
    try {
        activated.length = 0;
        await restored.start();
        assert.deepEqual(activated, [], "restart does not hydrate dormant workspaces");
        for (const sessionId of [firstSessionId, secondSessionId]) {
            assert.equal((await dispatch(restored, workspaceId, sessionId)).status, 400,
                "every operation in the workspace sees the restored withdrawal");
        }
        assert.equal((await dispatch(restored, peerWorkspaceId, peerSessionId)).status, 200);
        assert.deepEqual(activated, [workspaceId, peerWorkspaceId]);
    } finally {
        await restored.stop();
        await db.close();
    }
});

test("{§module-lifecycle} Daemon: concurrent session demands share one Functionality activation", async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `workspace-cap-concurrent-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const activationStarted = Promise.withResolvers<void>();
    const releaseActivation = Promise.withResolvers<void>();
    let activations = 0;
    let actions = 0;
    const daemon = new Daemon({ db, provider: null });
    daemon.registerModule({
        setup: (seam) => {
            seam.registerWorkspaceCapabilityProvider("concurrent capability fixture", {
                activate: async ({ workspaceId: activatedWorkspaceId }) => {
                    activations += 1;
                    assert.equal(activatedWorkspaceId, workspaceId);
                    activationStarted.resolve();
                    await releaseActivation.promise;
                    await seam.replaceWorkspaceCapabilities({
                        workspaceId: activatedWorkspaceId,
                        namespaceOwner: "concurrent capability fixture",
                        state: null,
                        runtimes: [],
                    });
                },
                deactivate: async () => undefined,
            });
            seam.registerModuleAction({
                name: "capability.probe",
                scope: "session",
                residency: "required",
                inputSchema: MODULE_INPUT_SCHEMA,
                outputSchema: MODULE_OUTPUT_SCHEMA,
                handler: async () => {
                    actions += 1;
                    return { ready: true };
                },
            });
        },
    }, "test-module");
    try {
        await daemon.start();
        const first = daemon.invokeModuleAction(
            "capability.probe",
            {},
            { scope: "session", workspaceId, sessionId },
        );
        await activationStarted.promise;
        const second = daemon.invokeModuleAction(
            "capability.probe",
            {},
            { scope: "session", workspaceId, sessionId },
        );
        releaseActivation.resolve();
        assert.deepEqual(await Promise.all([first, second]), [
            { ready: true },
            { ready: true },
        ]);
        assert.equal(activations, 1, "both demands await one serialized activation");
        assert.equal(actions, 2, "neither demand is lost after activation");

        assert.deepEqual(
            await daemon.invokeModuleAction(
                "capability.probe",
                {},
                { scope: "session", workspaceId, sessionId },
            ),
            { ready: true },
        );
        assert.equal(activations, 1, "the activated session remains warm");
    } finally {
        releaseActivation.resolve();
        await daemon.stop();
        await db.close();
    }
});

test("{§module-lifecycle} Daemon cools idle capabilities, retained provider work postpones cooling, and later demand reactivates", async (t) => {
    const priorWarmMs = process.env.PLURNK_SERVICE_WORKSPACE_WARM_MS;
    const priorWarmMax = process.env.PLURNK_SERVICE_WORKSPACE_WARM_MAX;
    process.env.PLURNK_SERVICE_WORKSPACE_WARM_MS = "0";
    process.env.PLURNK_SERVICE_WORKSPACE_WARM_MAX = "-1";
    t.after(() => {
        if (priorWarmMs === undefined) delete process.env.PLURNK_SERVICE_WORKSPACE_WARM_MS;
        else process.env.PLURNK_SERVICE_WORKSPACE_WARM_MS = priorWarmMs;
        if (priorWarmMax === undefined) delete process.env.PLURNK_SERVICE_WORKSPACE_WARM_MAX;
        else process.env.PLURNK_SERVICE_WORKSPACE_WARM_MAX = priorWarmMax;
    });

    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `workspace-cap-residency-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const activations: number[] = [];
    const deactivations: number[] = [];
    let retainSession: (() => () => void) | null = null;
    const retainedWork: { release: (() => void) | null } = { release: null };
    const daemon = new Daemon({ db, provider: null });
    daemon.registerModule({
        setup: (seam) => {
            seam.registerWorkspaceCapabilityProvider("residency capability fixture", {
                activate: async (context) => {
                    activations.push(context.workspaceId);
                    retainSession = context.retain;
                    await seam.replaceWorkspaceCapabilities({
                        workspaceId: context.workspaceId,
                        namespaceOwner: "residency capability fixture",
                        state: null,
                        runtimes: [],
                    });
                },
                deactivate: async ({ workspaceId: deactivatedWorkspaceId }) => {
                    deactivations.push(deactivatedWorkspaceId);
                },
            });
            seam.registerModuleAction({
                name: "capability.residency-probe",
                scope: "session",
                residency: "required",
                inputSchema: MODULE_INPUT_SCHEMA,
                outputSchema: MODULE_OUTPUT_SCHEMA,
                handler: async (params) => {
                    if (params.hold === true) {
                        if (retainSession === null) throw new Error("provider retention was unavailable");
                        retainedWork.release = retainSession();
                    }
                    return { ready: true };
                },
            });
        },
    }, "test-module");

    try {
        await daemon.start();
        await daemon.attachWorkspace({ workspaceId });
        assert.deepEqual(activations, [], "attachment does not establish residency");

        assert.deepEqual(
            await daemon.invokeModuleAction(
                "capability.residency-probe",
                { hold: true },
                { scope: "session", workspaceId, sessionId },
            ),
            { ready: true },
        );
        assert.deepEqual(activations, [workspaceId]);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        assert.deepEqual(deactivations, [], "provider-retained work outlives its initiating action");

        assert.ok(retainedWork.release !== null);
        retainedWork.release();
        retainedWork.release = null;
        await waitFor(() => deactivations, (items) => items.length === 1);

        assert.deepEqual(
            await daemon.invokeModuleAction(
                "capability.residency-probe",
                {},
                { scope: "session", workspaceId, sessionId },
            ),
            { ready: true },
        );
        assert.deepEqual(activations, [workspaceId, workspaceId], "cold demand transparently reactivates");
        await waitFor(() => deactivations, (items) => items.length === 2);
    } finally {
        retainedWork.release?.();
        await daemon.stop();
        await db.close();
    }
});

test("{§module-workspace-residency} failed session Functionality deactivation remains resident for the retry owner", async (t) => {
    const priorWarmMs = process.env.PLURNK_SERVICE_WORKSPACE_WARM_MS;
    const priorWarmMax = process.env.PLURNK_SERVICE_WORKSPACE_WARM_MAX;
    process.env.PLURNK_SERVICE_WORKSPACE_WARM_MS = "0";
    process.env.PLURNK_SERVICE_WORKSPACE_WARM_MAX = "-1";
    t.after(() => {
        if (priorWarmMs === undefined) delete process.env.PLURNK_SERVICE_WORKSPACE_WARM_MS;
        else process.env.PLURNK_SERVICE_WORKSPACE_WARM_MS = priorWarmMs;
        if (priorWarmMax === undefined) delete process.env.PLURNK_SERVICE_WORKSPACE_WARM_MAX;
        else process.env.PLURNK_SERVICE_WORKSPACE_WARM_MAX = priorWarmMax;
    });

    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `workspace-cap-failed-cool-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const daemon = new Daemon({ db, provider: null });
    let activations = 0;
    let deactivations = 0;
    daemon.registerModule({
        setup: (seam) => {
            seam.registerWorkspaceCapabilityProvider("failed cooling fixture", {
                activate: async () => { activations += 1; },
                deactivate: async () => {
                    deactivations += 1;
                    if (deactivations === 1) throw new Error("fixture deactivation failed");
                },
            });
            seam.registerModuleAction({
                name: "capability.failed-cooling-probe",
                scope: "session",
                residency: "required",
                inputSchema: MODULE_INPUT_SCHEMA,
                outputSchema: MODULE_OUTPUT_SCHEMA,
                handler: async () => ({ ready: true }),
            });
        },
    }, "test-module");

    try {
        await daemon.start();
        await daemon.invokeModuleAction(
            "capability.failed-cooling-probe",
            {},
            { scope: "session", workspaceId, sessionId },
        );
        await waitFor(() => [deactivations], ([count]) => count === 1);
        await daemon.invokeModuleAction(
            "capability.failed-cooling-probe",
            {},
            { scope: "session", workspaceId, sessionId },
        );
        assert.equal(
            activations,
            1,
            "a rejected deactivation does not falsely evict and reactivate the session",
        );
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§module-lifecycle} Daemon first Functionality demand reconciles generated skills for an existing session", async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `boot-docs-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const daemon = new Daemon({ db, provider: null });
    daemon.registerModule({
        setup: (seam) => {
            seam.registerModuleAction({
                name: "docs.probe",
                scope: "session",
                residency: "required",
                inputSchema: MODULE_INPUT_SCHEMA,
                outputSchema: MODULE_OUTPUT_SCHEMA,
                handler: async () => ({ ready: true }),
            });
        },
    }, "test-module");
    try {
        await daemon.start();
        assert.deepEqual(
            await db.test_entries_by_scheme_prefix.all({ workspace_id: workspaceId, scheme: "plurnk", prefix: "/%" }),
            [],
            "dormant boot does not rewrite workspace documentation",
        );
        await daemon.attachWorkspace({ workspaceId });
        assert.equal(
            daemon.workspaceDerivationStatus(workspaceId),
            null,
            "attachment does not launch semantic derivation",
        );
        assert.deepEqual(
            await db.test_entries_by_scheme_prefix.all({ workspace_id: workspaceId, scheme: "plurnk", prefix: "/%" }),
            [],
            "attachment remains passive",
        );
        assert.deepEqual(
            await daemon.invokeModuleAction("docs.probe", {}, { scope: "session", workspaceId, sessionId }),
            { ready: true },
        );
        const docs = await db.test_entries_by_scheme_prefix.all<{ pathname: string }>({ workspace_id: workspaceId, scheme: "plurnk", prefix: "/%" });
        assert.ok(docs.length > 0, "capability demand publishes the current installed skills surface into an existing workspace");
        assert.equal(
            docs.some(({ pathname }) => pathname === "/log.md" || pathname === "/prompt.md"),
            false,
            "self-evident log and prompt schemes do not materialize redundant pull documentation",
        );
        const generated = await db.crud_find_workspace_entry.get<{ id: number }>({
            workspace_id: workspaceId,
            scheme: "plurnk",
            authority: "",
            pathname: docs[0].pathname,
        });
        assert.ok(generated !== undefined, "activation publication belongs to the addressed session");
    } finally {
        await daemon.stop();
        await db.close();
    }
});


test("{§core-extension-composition} the module setup seam registers a live tag, dispatchable through the engine", async () => {
    // The generic module-load hook builds the RegistryEntry with its own
    // driver and hands it here; the kernel knows nothing about the driver. Tested with a stand-in.
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-module" })).result as { id: number };

            await assert.rejects(
                () => daemon.registerRuntime({ ...fakeRegistration("ownerless"), namespaceOwner: " " }),
                /namespaceOwner must be a non-empty string/,
            );
            assert.equal(daemon.schemes.has("ownerless"), false, "invalid ownership cannot claim a scheme");
            await daemon.registerRuntime(fakeRegistration("seamtag"));
            // The tag is live — the engine dispatches to the registered executor.
            const [exec] = await daemon.dispatchClientAction({ workspaceId: created.id, actor: TEST_OWNER, statements: [Dsl.buildExec({ runtime: "seamtag", command: "ping" })] });
            assert.equal(exec.status, 200, "the module runtime is dispatchable through the seam's dispatch path");

            // one-name-one-owner arbitration flows through the seam: a dup and a reserved name fail-hard.
            await assert.rejects(() => daemon.registerRuntime(fakeRegistration("seamtag")), /already/i, "a dup tag is rejected");
            await assert.rejects(() => daemon.registerRuntime(fakeRegistration("session")), /reserved/i, "a reserved built-in name is rejected");
        } finally { ws.close(); }
    });
});

test("{§stream} the client-interface seam — a dispatched execution's stdout streams as stream/event on the event source", async () => {
    // Client-raised parity check: a seam-dispatched exec must emit incremental stream/event, not just
    // the log/entry + stream/concluded. dispatchClientAction routes through engine.dispatch identically to
    // the WS op.exec path; the stream fires via the engine's global streamEventNotify. Pinned so the
    // per-chunk path can't silently regress. (A streaming stub with a DECLARED channel — the exec seeds
    // the executor's channel topology eagerly, so the write appends and the notify fires.)
    await withDaemon(new Mock({ contextWindow: 8192, responses: [] }), async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            await daemon.registerRuntime({
                namespaceOwner: "stream test module",
                decl: {
                    name: "streamtag",
                    glyph: "🔌",
                    summary: "Streaming fixture.",
                    invocation: { body: { role: "fixture input", required: true }, example: { body: "fixture" } },
                },
                executor: {
                    runtime: "streamtag", glyph: "🔌",
                    get manifest() { return { name: "streamtag", channels: { stdout: "text/plain" }, defaultChannel: "stdout", category: "data", writableBy: [], volatile: true, modelVisible: true } as never; },
                    get defaultChannel() { return "stdout"; },
                    get channels() { return { stdout: { mimetype: "text/plain" } }; },
                    effect: () => "read",
                    probe: async () => ({ available: true, detail: "fake" }),
                    run: async (args: { write: (c: string, x: string, m: string) => void; setState: (c: string, s: string) => void }) => {
                        args.write("stdout", "alpha\n", "text/plain");
                        args.write("stdout", "beta\n", "text/plain");
                        args.setState("stdout", "closed");
                        return { status: 200, exitCode: 0 };
                    },
                } as unknown as Executor,
                availability: { available: true, detail: "fake" },
            });
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-stream" })).result as { id: number };
            const events: string[] = [];
            daemon.subscribeToEvents((_s, method) => { events.push(method); });

            await daemon.dispatchClientAction({ workspaceId: created.id, actor: TEST_OWNER, statements: [Dsl.buildExec({ runtime: "streamtag", command: "go" })] });
            await waitFor(() => events.filter((m) => m === "stream/event"), (s) => s.length > 0, { timeoutMs: 4000 });
            assert.ok(events.filter((m) => m === "stream/event").length > 0, "the exec's stdout arrived as stream/event on the seam — not just log/entry + stream/concluded");
        } finally { ws.close(); }
    });
});

test("{§exec-stream} an execution's summary is its address, how its settled result ended, and the size of each channel its executor declares", async (t) => {
    t.mock.method(console, "error", () => {}); // the invalid report is diagnosed on stderr; the summaries are the witness
    type RunArgs = { write: (channel: string, chunk: string, mimetype: string) => void; setState: (channel: string, state: string) => void };
    const fixture = (name: string, channels: readonly string[], report: (args: RunArgs) => unknown): Executor => ({
        runtime: name, glyph: "🔌",
        get manifest() { return { name, channels: Object.fromEntries(channels.map((channel) => [channel, "text/plain"])), defaultChannel: channels[0], category: "data", writableBy: [], volatile: true, modelVisible: true }; },
        get defaultChannel() { return channels[0]; },
        get channels() { return Object.fromEntries(channels.map((channel) => [channel, { mimetype: "text/plain" }])); },
        effect: () => "read",
        probe: async () => ({ available: true, detail: "fake" }),
        run: async (args: RunArgs) => {
            const reported = report(args);
            for (const channel of channels) args.setState(channel, "closed");
            return reported;
        },
    }) as unknown as Executor;
    // How it ended (a success, a success with an exit code, the executor's own Problem, the service's settlement of an
    // invalid report) crossed with what the executor declares (one channel; two, sized in declared order).
    const cases = [
        { executor: fixture("verbtag", ["results"], (args) => { args.write("results", "{\"ok\":true}", "text/plain"); return { status: 200 }; }),
            summary: /^verbtag:\/\/\/[a-f0-9]{8} completed; results=11 bytes$/u, because: "a success without an exit code completed, and only its declared channel is sized" },
        { executor: fixture("spawntag", ["stdout", "stderr"], (args) => { args.write("stdout", "hi\n", "text/plain"); return { status: 200, exitCode: 0 }; }),
            summary: /^spawntag:\/\/\/[a-f0-9]{8} completed \(exit 0\); stdout=3 bytes, stderr=0 bytes$/u, because: "a success names its exit code, and its channels are sized in declared order" },
        { executor: fixture("refusetag", ["results"], () => Results.failure("refusetag", "fixture-refused", 409, "The fixture refused.")),
            summary: /^refusetag:\/\/\/[a-f0-9]{8} fixture refused; results=0 bytes$/u, because: "a failure is its Problem's title, never completed" },
        { executor: fixture("claimtag", ["stdout", "stderr"], () => ({ status: 102, exitCode: 0 })),
            summary: /^claimtag:\/\/\/[a-f0-9]{8} executor invalid result; stdout=0 bytes, stderr=0 bytes$/u, because: "the settled result speaks, not the executor's report" },
    ];
    await withDaemon(new Mock({ contextWindow: 8192, responses: [] }), async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            for (const { executor } of cases) {
                await daemon.registerRuntime({
                    namespaceOwner: "summary test module",
                    decl: { name: executor.runtime, glyph: "🔌", summary: "Summary fixture.", invocation: { body: { role: "fixture input", required: true }, example: { body: "fixture" } } },
                    executor,
                    availability: { available: true, detail: "fake" },
                });
            }
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "conclusion-summary" })).result as { id: number };
            const summaries = new Map<string, string>();
            daemon.subscribeToEvents((_s, method, params) => {
                const concluded = params as { scheme?: unknown; summary?: unknown };
                if (method === "stream/concluded" && typeof concluded.scheme === "string" && typeof concluded.summary === "string") summaries.set(concluded.scheme, concluded.summary);
            });
            for (const { executor } of cases) {
                await daemon.dispatchClientAction({ workspaceId: created.id, actor: TEST_OWNER, statements: [Dsl.buildExec({ runtime: executor.runtime, command: "go" })] });
            }
            await waitFor(() => [...summaries.keys()], (seen) => seen.length === cases.length, { timeoutMs: 4000 });
            for (const { executor, summary, because } of cases) assert.match(summaries.get(executor.runtime) ?? "", summary, because);
        } finally { ws.close(); }
    });
});

test("{§module-lifecycle} the client-interface seam — the boot plug-point hands a registered module a live ApplicationPort", async () => {
    // Hook D: register a module before start(); at boot it receives the curated seam and wires itself.
    // "Here's your handle, open your own listener." Proven by driving the live seam from inside the init.
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: new Mock({ contextWindow: 8192, responses: [] }) });
    try {
        let handed: ApplicationPort | null = null;
        let createdInInit: number | null = null;
        daemon.registerModule({
            start: async (seam) => {
                handed = seam;
                const env = await seam.createWorkspace({ name: "from-module-init" });
                createdInInit = env.workspaceId;
            },
        }, "test-module");
        await daemon.start();

        assert.ok(handed !== null, "the module init ran at boot with the seam handle");
        assert.ok(createdInInit !== null && createdInInit > 0, "the init drove a LIVE seam — createWorkspace worked during boot");
        const seam = handed as ApplicationPort;
        assert.ok((await seam.listWorkspaces()).some((s) => s.id === createdInInit), "the module's seam and the daemon are one live surface");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§module-shutdown-order} module producers stop before draining and observers close after settlement", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({
        db,
        provider: new Mock({
            contextWindow: 8192,
            responses: [],
        }),
    });
    const events: string[] = [];
    const originalDrainDerivations = daemon.engine.drainDerivations.bind(daemon.engine);
    daemon.engine.drainDerivations = async (reason): Promise<void> => {
        await originalDrainDerivations(reason);
        events.push("derivations-drained");
    };
    daemon.registerModule({
        setup: async (seam) => {
            events.push("setup");
            await seam.registerScheme("module-lifecycle-fixture", {
                manifest: {
                    name: "module-lifecycle-fixture",
                    channels: { body: "text/plain" },
                    defaultChannel: "body",
                    category: "data",
                    writableBy: [],
                    volatile: false,
                    modelVisible: false,
                },
                ready: async () => { events.push("capability-ready"); },
            });
        },
        start: async () => {
            events.push("start");
            return {
                stop: async () => { events.push("listener-stop"); },
                close: async () => {
                    events.push("listener-close");
                },
            };
        },
        stop: async () => { events.push("module-stop"); },
        close: async () => {
            events.push("module-close");
        },
    }, "test-module");
    try {
        await daemon.start();
        assert.deepEqual(events, ["setup", "capability-ready", "start"]);
        await daemon.stop();
        assert.deepEqual(events, [
            "setup",
            "capability-ready",
            "start",
            "listener-stop",
            "module-stop",
            "derivations-drained",
            "listener-close",
            "module-close",
        ]);
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§module-lifecycle} stop-only modules and self-returned lifetimes are tracked exactly once", async (t) => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    t.after(async () => { await daemon.stop(); await db.close(); });
    const calls: string[] = [];
    daemon.registerModule({ stop() { calls.push("stop-only"); } }, "test-module");
    daemon.registerModule({
        start() { return this; },
        stop() { calls.push("stop-self"); },
        close() { calls.push("close-self"); },
    }, "test-module");
    await daemon.start();
    await daemon.stop();
    await daemon.stop();
    assert.deepEqual(calls, ["stop-self", "stop-only", "close-self"]);
});

test("{§module-shutdown-order} a stalled producer does not prevent other producers or observers from closing", async (t) => {
    const prior = process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS;
    process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS = "100";
    t.after(() => {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS;
        else process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS = prior;
    });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    t.after(async () => { await daemon.stop(); await db.close(); });
    const calls: string[] = [];
    daemon.registerModule({
        stop() { calls.push("producer-stopped"); },
        close() { calls.push("observer-closed"); },
    }, "test-module");
    daemon.registerModule({ stop: () => new Promise(() => {}) }, "test-module");
    await daemon.start();
    await assert.rejects(daemon.stop(), (cause: unknown) => {
        assert.ok(cause instanceof AggregateError);
        assert.ok(cause.errors.some((error: unknown) => String(error).includes("stop deadline exceeded waiting for modules stop")));
        return true;
    });
    assert.deepEqual(calls, ["producer-stopped", "observer-closed"]);
});

test("{§module-shutdown-order} service teardown joins the expired daemon drain before database release", async (t) => {
    const prior = process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS;
    process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS = "50";
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    const pending = Promise.withResolvers<void>();
    const events: string[] = [];
    let closing: Promise<void> | undefined;
    t.after(async () => {
        pending.resolve();
        await daemon.stop();
        await (closing ?? db.close());
        if (prior === undefined) delete process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS;
        else process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS = prior;
    });
    daemon.registerModule({
        stop() { events.push("producer stop"); return pending.promise; },
        close() { events.push("observer close"); },
    }, "test-module");
    await daemon.start();
    const teardown = new ServiceTeardown(
        (deadline) => daemon.stop(deadline),
        ["database close", async () => { events.push("database close"); closing = db.close(); await closing; }],
    );
    await assert.rejects(teardown.close(), (cause: unknown) => {
        assert.ok(cause instanceof Error);
        assert.match(ServiceTeardown.diagnostic("shutdown", cause), /stop deadline exceeded waiting for modules stop/);
        return true;
    });
    assert.deepEqual(events, ["producer stop", "observer close", "database close"]);
});

test("{§mimetype} Daemon.stop disposes its owned mimetypes after derivations exactly once", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    const events: string[] = [];
    let disposals = 0;
    const originalDrain = daemon.engine.drainDerivations.bind(daemon.engine);
    daemon.engine.drainDerivations = async (): Promise<void> => {
        await originalDrain();
        events.push("derivations-drained");
    };
    const ownedMimetypes = daemon.mimetypes;
    const originalDispose = ownedMimetypes.dispose.bind(ownedMimetypes);
    ownedMimetypes.dispose = async (): Promise<void> => {
        disposals += 1;
        events.push("mimetypes-disposed");
        await originalDispose();
    };
    try {
        await daemon.stop();
        assert.equal(disposals, 0, "pre-start stop acquires and releases nothing");
        await daemon.start();
        await daemon.stop();
        await daemon.stop();
        assert.equal(disposals, 1, "repeated stop does not repeat owned teardown");
        assert.deepEqual(events, ["derivations-drained", "mimetypes-disposed"]);
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§mimetype} Daemon.stop leaves constructor-injected mimetypes caller-owned", async () => {
    const db = await openMigrated();
    const injected = new Mimetypes({
        discovery: {
            registry: { byExtension: new Map(), byFilename: new Map() },
            handlers: new Map(),
            packageAttributions: new Map(), skipped: [],
        },
    });
    let disposals = 0;
    const originalDispose = injected.dispose.bind(injected);
    injected.dispose = async (): Promise<void> => {
        disposals += 1;
        await originalDispose();
    };
    const daemon = new Daemon({ db, provider: null, mimetypes: injected });
    try {
        await daemon.start();
        await daemon.stop();
        assert.equal(disposals, 0, "the daemon does not destroy caller-owned state");
        assert.equal((await injected.classify("text/plain")).binary, false, "caller-owned state remains usable");
        await injected.dispose();
        assert.equal(disposals, 1, "the caller retains explicit teardown authority");
    } finally {
        await daemon.stop();
        await injected.dispose();
        await db.close();
    }
});

test("{§module-shutdown-order} daemon shutdown preserves module and scheme lifecycle failures in one aggregate", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({
        db,
        provider: new Mock({
            contextWindow: 8192,
            responses: [],
        }),
    });
    daemon.registerModule({
        async stop() { throw new Error("module stop failed"); },
        async close() { throw new Error("module close failed"); },
    }, "test-module");
    daemon.mimetypes.dispose = async () => { throw new Error("mimetype dispose failed"); };
    daemon.schemes.register("broken-close", {
        manifest: {
            name: "broken-close",
            channels: { body: "text/plain" },
            defaultChannel: "body",
            category: "data",
            writableBy: ["model"],
            volatile: false,
            modelVisible: true,
        },
        async close() { throw new Error("scheme close failed"); },
    });
    try {
        await daemon.start();
        await assert.rejects(
            () => daemon.stop(),
            (error: unknown) => {
                assert.ok(error instanceof AggregateError);
                assert.equal(error.message, "daemon shutdown failed");
                assert.deepEqual(
                    error.errors.map((cause) => String(cause)),
                    [
                        "Error: module stop failed",
                        "Error: module close failed",
                        "Error: mimetype dispose failed",
                        "Error: scheme close failed",
                    ],
                );
                return true;
            },
        );
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§module-shutdown-order}: every shutdown owner shares the absolute stop deadline", async (t) => {
    const prior = process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS;
    process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS = "50";
    t.after(() => {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS;
        else process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS = prior;
    });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    daemon.registerModule({
        close: () => new Promise(() => {}),
    }, "test-module");
    try {
        await daemon.start();
        const guarded = Promise.race([
            daemon.stop(),
            new Promise<never>((_resolve, reject) => {
                setTimeout(() => reject(new Error("test guard: daemon stop remained unbounded")), HARNESS_WAIT_MS).unref();
            }),
        ]);
        await assert.rejects(
            guarded,
            (error: unknown) => {
                assert.ok(error instanceof AggregateError);
                assert.equal(error.message, "daemon shutdown failed");
                assert.match(String(error.errors[0]), /stop deadline exceeded waiting for modules close/);
                return true;
            },
        );
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§module-contract} a module that acquires resources during setup is closed when later setup fails", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({
        db,
        provider: new Mock({
            contextWindow: 8192,
            responses: [],
        }),
    });
    let closed = false;
    daemon.registerModule({
        setup: async () => {
            throw new Error("setup failed");
        },
        close: async () => {
            closed = true;
        },
    }, "test-module");
    try {
        await assert.rejects(() => daemon.start(), /setup failed/);
        await daemon.stop();
        assert.equal(closed, true, "setup-acquired resources are not leaked after boot failure");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§actor-boundary} {§connection-lifecycle} a person's client operations share workspace Functionality and journal in the runtime session", async () => {
    const db = await openMigrated();
    const owner = "attached Functionality test module";
    const tag = "attachedcap";
    const workspaceId = await insertWorkspace(db, `attached-functionality-${crypto.randomUUID()}`);
    const modelSessionId = await insertSession(db, workspaceId, null, "primary", "model");
    await db.workspace_module_state_put.run({
        workspace_id: workspaceId,
        namespace_owner: owner,
        state: JSON.stringify({ source: "workspace" }),
    });
    const executions: number[] = [];
    const activated: number[] = [];
    const capabilityModule = {
        setup: (seam: HostSetupSeam): void => {
            seam.registerWorkspaceCapabilityProvider(owner, {
                activate: async ({ workspaceId: activeWorkspaceId }) => {
                    activated.push(activeWorkspaceId);
                    const state = await seam.readWorkspaceModuleState(activeWorkspaceId, owner);
                    const base = fakeRegistration(tag);
                    await seam.replaceWorkspaceCapabilities({
                        workspaceId: activeWorkspaceId,
                        namespaceOwner: owner,
                        state,
                        runtimes: state === null ? [] : [{
                            ...base,
                            namespaceOwner: owner,
                            executor: {
                                ...base.executor,
                                run: async () => { executions.push(activeWorkspaceId); return { status: 200 }; },
                            },
                        }],
                    });
                },
                deactivate: async () => undefined,
            });
        },
    };
    const daemon = new Daemon({ db, provider: null });
    daemon.registerModule(capabilityModule, "test-module");
    try {
        await daemon.start();
        await daemon.attachWorkspace({ workspaceId });

        // The runtime belongs to the workspace; the operation belongs to the person who acted, here for the model session.
        const [attached] = await daemon.dispatchClientAction({
            workspaceId,
            actor: TEST_OWNER,
            contextSessionId: modelSessionId,
            statements: [Dsl.buildExec({ runtime: tag, command: "acting for the model session" })],
        });
        assert.equal(attached.status, 200);
        assert.deepEqual(activated, [workspaceId], "residency is acquired for the workspace");
        assert.deepEqual(executions, [workspaceId], "the shared runtime ran");
        const runtimeSessionId = await daemon.ensureRuntimeSession(workspaceId);
        const clientRows = (await db.test_log_entries_by_session.all<{ origin: string; loop_id: number }>({ session_id: runtimeSessionId }))
            .filter(({ origin }) => origin === "client");
        assert.equal(clientRows.length, 1, "the client operation journals in the runtime session");
        const operationLoop = (await daemon.listSessionLoops({ workspaceId, sessionId: runtimeSessionId }))
            .find(({ id }) => id === clientRows[0].loop_id);
        assert.equal(operationLoop?.promptSource, TEST_OWNER, "the operation's loop names its person");
        const modelRows = await db.test_log_entries_by_session.all<{ origin: string }>({ session_id: modelSessionId });
        assert.equal(
            modelRows.some(({ origin }) => origin === "client"),
            false,
            "no client row enters the log of the model session the person acted for",
        );

        // Acting for no session uses the same environment.
        const [unattached] = await daemon.dispatchClientAction({
            workspaceId,
            actor: TEST_OWNER,
            statements: [Dsl.buildExec({ runtime: tag, command: "acting for no session" })],
        });
        assert.equal(unattached.status, 200, "an operation acting for no session can use the workspace runtime");
        assert.deepEqual(executions, [workspaceId, workspaceId]);

        // The session an operation acts for must be a model session of the workspace.
        const foreignWorkspace = await insertWorkspace(db, `attached-foreign-${crypto.randomUUID()}`);
        const foreignSession = await insertSession(db, foreignWorkspace, null, "elsewhere", "model");
        await assert.rejects(
            () => daemon.dispatchClientAction({
                workspaceId,
                actor: TEST_OWNER,
                contextSessionId: foreignSession,
                statements: [Dsl.buildExec({ runtime: tag, command: "cross-workspace" })],
            }),
            (error: unknown) => {
                assert.ok(error instanceof OperationFailureError);
                assert.equal(error.result.problem.type, "https://problems.plurnk.xyz/daemon/session/workspace-mismatch");
                return true;
            },
        );
        await assert.rejects(
            () => daemon.dispatchClientAction({
                workspaceId,
                actor: TEST_OWNER,
                contextSessionId: runtimeSessionId,
                statements: [Dsl.buildExec({ runtime: tag, command: "acting for the runtime" })],
            }),
            (error: unknown) => {
                assert.ok(error instanceof OperationFailureError);
                assert.equal(error.result.problem.type, "https://problems.plurnk.xyz/daemon/session/model-session-required");
                return true;
            },
        );
        assert.deepEqual(executions, [workspaceId, workspaceId], "a refused operation runs nothing");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

// {§credential-authority} — the posture witnesses set PLURNK_AUTH and PLURNK_SECRET themselves and
// restore the tier's own values after.
const withPosture = async <T>(posture: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
    const saved = Object.fromEntries(Object.keys(posture).map((key) => [key, process.env[key]]));
    const apply = (values: Record<string, string | undefined>): void => {
        for (const [key, value] of Object.entries(values)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
    apply(posture);
    try { return await fn(); } finally { apply(saved); }
};

test("{§credential-authority} under PLURNK_AUTH=1 a minted operator secret is written beside the database, 0600; a configured secret or PLURNK_AUTH=0 leaves no file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-posture-"));
    const dbPath = join(dir, "plurnk.db");
    const secretFile = join(dir, "secret");
    const boot = async (): Promise<{ daemon: Daemon; close: () => Promise<void> }> => {
        const db = await openMigrated(dbPath);
        const daemon = new Daemon({ db, provider: null, dbPath });
        await daemon.start();
        return { daemon, close: async () => { await daemon.stop(); await db.close(); } };
    };
    try {
        const minted = await withPosture({ PLURNK_AUTH: "1", PLURNK_SECRET: undefined }, boot);
        try {
            assert.equal(minted.daemon.secretFile, secretFile, "the file is named for same-user tools");
            assert.equal((await readFile(secretFile, "utf8")).trim(), minted.daemon.credentials.operatorSecret, "the file holds this boot's secret");
            assert.equal((await stat(secretFile)).mode & 0o777, 0o600);
        } finally { await minted.close(); }
        const configured = await withPosture({ PLURNK_AUTH: "1", PLURNK_SECRET: "configured" }, boot);
        try {
            assert.equal(configured.daemon.credentials.operatorSecret, "configured");
            assert.equal(configured.daemon.secretFile, null);
            await assert.rejects(readFile(secretFile), { code: "ENOENT" }, "a configured secret removes the file a minting boot left");
        } finally { await configured.close(); }
        await writeFile(secretFile, "stale\n", { mode: 0o600 });
        const off = await withPosture({ PLURNK_AUTH: "0", PLURNK_SECRET: undefined }, boot);
        try {
            assert.equal(off.daemon.credentials.operatorSecret, null);
            assert.equal(off.daemon.secretFile, null);
            assert.equal(off.daemon.credentials.face(), null);
            await assert.rejects(readFile(secretFile), { code: "ENOENT" }, "an open daemon leaves no stale secret behind");
        } finally { await off.close(); }
        await withPosture({ PLURNK_AUTH: "maybe" }, async () => {
            const db = await openMigrated(dbPath);
            try { assert.throws(() => new Daemon({ db, provider: null, dbPath }), /PLURNK_AUTH must be 0 or 1/u); }
            finally { await db.close(); }
        });
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("{§credential-authority} a listening daemon under PLURNK_AUTH=1 refuses to start until a module publishes the authority's face", async () => {
    const empty = await mkdtemp(join(tmpdir(), "plurnk-no-modules-"));
    const nodeModulesPath = join(empty, "node_modules");
    try {
        await withPosture({ PLURNK_AUTH: "1", PLURNK_SECRET: undefined }, async () => {
            const db = await openMigrated();
            const http = await bindListener();
            const silent = new Daemon({ db, provider: null, http, nodeModulesPath });
            try {
                await assert.rejects(silent.start(), /PLURNK_AUTH=1, and no module publishes an authorization server/u);
            } finally { await silent.stop(); await http.close(); await db.close(); }
            const db2 = await openMigrated();
            const http2 = await bindListener();
            const issuing = new Daemon({ db: db2, provider: null, http: http2, nodeModulesPath });
            issuing.registerModule({ setup: async (seam) => { seam.credentials.publish({ issuer: () => "http://127.0.0.1:1" }); } }, "test-issuer");
            try {
                await issuing.start();
                assert.equal(issuing.credentials.face()?.issuer({ headers: {} }), "http://127.0.0.1:1");
                assert.ok(issuing.credentials.operatorSecret, "the authority holds a minted operator secret");
            } finally { await issuing.stop(); await http2.close(); await db2.close(); }
        });
    } finally { await rm(empty, { recursive: true, force: true }); }
});
});

