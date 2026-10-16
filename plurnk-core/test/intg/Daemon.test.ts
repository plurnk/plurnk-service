import { ownWorker, TEST_OWNER } from "./_approval.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { rpcCall, subscribeNotifications, flush, connect, withDaemon, waitFor, runLoopToTerminal } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";
import { insertWorkspace, insertWorker, insertLoop, insertTurn, openMigrated } from "./_db.ts";
import { viableWindow } from "./_provider.ts";
import Daemon from "../../src/server/Daemon.ts";
import HostPaths from "../../src/core/HostPaths.ts";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { bindListener } from "./_a2a.ts";
import ServiceTeardown from "../../src/core/ServiceTeardown.ts";
import type { RuntimeRegistration } from "@plurnk/plurnk-execs";
import type { HostSetupSeam } from "../../src/server/ModuleHost.ts";
import Dsl from "./dsl.ts";
import type { Executor } from "@plurnk/plurnk-execs";
import { OperationFailureError } from "../../src/core/results.ts";
import { namedModelWorker } from "./_workers.ts";
import {
    Validator,
    type ApplicationActionContext,
    type OperationResult,
    type PlurnkStatement,
    type ProblemDetails,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import skillsModule from "@plurnk/plurnk-skills/module";

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
import { Mock } from "@plurnk/plurnk-providers";

interface RpcResponse {
    jsonrpc: "2.0";
    id: number | string | null;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

const rpcProblem = (response: RpcResponse): ProblemDetails => {
    const result = Validator.assertOperationResult(response.result as OperationResult);
    assert.ok(result.problem !== undefined);
    return result.problem;
};

const rejectedProblem = async (run: () => Promise<unknown> | unknown): Promise<ProblemDetails> => {
    try {
        await run();
    } catch (error) {
        assert.ok(error instanceof OperationFailureError);
        return error.result.problem;
    }
    assert.fail("Expected operation failure.");
};

test("Daemon: listenerless boot — the seam is live with no socket bound", async () => {
    await withDaemon(null, async (_db, daemon, _addr) => {
        // No port, no listener — the seam itself is the surface. A basic seam read proves boot.
        const workspaces = await daemon.listWorkspaces();
        assert.ok(Array.isArray(workspaces), "the seam answers");
    });
});

test("{§manifest-client-display} {§mimetype-client-display} Daemon composes deterministic scheme and MIME display capabilities for clients", async () => {
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
                                { kind: "scheme", scheme: "message", display: {} },
                { kind: "scheme", scheme: "note", display: {} },
                { kind: "scheme", scheme: "ops", display: {} },
                { kind: "scheme", scheme: "reasoning", display: {} },
                { kind: "scheme", scheme: "skill", display: {} },
                { kind: "scheme", scheme: "worker", display: {} },
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

test("Daemon boot reports mimetype packages withheld by the shared trust gate", async () => {
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

test("{§module-action-registration} Daemon: module actions register once during setup and invoke through ApplicationPort", async () => {
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
                    scope: "worldless",
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
                    scope: "worldless",
                    residency: "none",
                    inputSchema: { $ref: "https://example.invalid/Missing.json" },
                    outputSchema: MODULE_OUTPUT_SCHEMA,
                    handler: async () => ({}),
                }),
                /module action 'example\.invalid' has an invalid input schema/,
            );
            seam.registerModuleAction({
                name: "example.inspect",
                scope: "worldless",
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
                    scope: "worldless",
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
        // {§functionality-scope} Core families and the discovered default modules register beside the
        // module's own action.
        const families = ["workspace.skills.", "workspace.members.", "worker.env.", "workspace.env.", "workspace.schedule.", "workspace.mcp.", "workspace.a2a."];
        assert.deepEqual(daemon.listModuleActions().filter(({ name }) => !families.some((prefix) => name.startsWith(prefix))), [{
            name: "example.inspect",
            scope: "worldless",
            inputSchema: MODULE_INPUT_SCHEMA,
            outputSchema: MODULE_OUTPUT_SCHEMA,
        }]);
        assert.deepEqual(
            daemon.listModuleActions().map(({ name }) => name).filter((name) => name.startsWith("workspace.skills.")),
            ["workspace.skills.add", "workspace.skills.disable", "workspace.skills.discover", "workspace.skills.enable", "workspace.skills.list", "workspace.skills.remove", "workspace.skills.replace"],
        );
        for (const scope of ["worker", "workspace"]) {
            assert.deepEqual(
                daemon.listModuleActions().filter(({ name }) => name.startsWith(`${scope}.env.`)).map(({ name, scope }) => ({ name, scope })),
                ["add", "disable", "discover", "enable", "list", "remove", "replace"].map((verb) => ({ name: `${scope}.env.${verb}`, scope })),
            );
        }
        assert.deepEqual(
            await daemon.invokeModuleAction(
                "example.inspect",
                { target: "sample" },
                { scope: "worldless" },
            ),
            { inspected: "sample" },
        );
        assert.deepEqual(calls, [{
            params: { target: "sample" },
            context: { scope: "worldless" },
        }]);
        await assert.rejects(
            () => daemon.invokeModuleAction("missing", {}, { scope: "worldless" }),
            /module action 'missing' is not registered/,
        );
        await assert.rejects(
            () => daemon.invokeModuleAction(
                "example.inspect",
                {},
                { scope: "workspace", workspaceId: 1 },
            ),
            /requires worldless context, not workspace/,
        );
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§module-action-registration} passive scoped actions validate identities without activating capabilities", async (t) => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    let calls = 0;
    let activations = 0;
    daemon.registerModule({ setup: (seam) => {
        seam.registerWorkspaceCapabilityProvider("passive fixture", {
            activate: () => { activations++; }, deactivate: () => undefined,
        });
        for (const scope of ["workspace", "worker"] as const) seam.registerModuleAction({
            name: `${scope}.passive`, scope, residency: "none",
            inputSchema: MODULE_INPUT_SCHEMA, outputSchema: MODULE_OUTPUT_SCHEMA,
            handler: async () => { calls++; return { inspected: true }; },
        });
    } }, "test-module");
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const workspaceId = await insertWorkspace(db, "passive-actions");
    const workerId = await insertWorker(db, workspaceId, null, "reader", "model");
    for (const scope of ["workspace", "worker"] as const) {
        const context = scope === "workspace" ? { scope, workspaceId } : { scope, workspaceId, workerId };
        assert.deepEqual(await daemon.invokeModuleAction(`${scope}.passive`, {}, context), { inspected: true });
        const problem = await rejectedProblem(() => daemon.invokeModuleAction(`${scope}.passive`, {}, { ...context, workspaceId: 999_999 }));
        assert.equal(problem.status, 404);
        assert.match(problem.detail!, /does not exist/);
    }
    assert.equal(calls, 2, "invalid contexts cannot reach a passive handler");
    assert.equal(activations, 0, "identity validation never starts the workspace's capabilities");
});

test("Daemon: workspace Functionality is shared, demand-activated, and durable across restart", async () => {
    const db = await openMigrated();
    const owner = "workspace Functionality test module";
    const tag = "workspacecap";
    const workspaceId = await insertWorkspace(db, `workspace-functionality-${crypto.randomUUID()}`);
    const peerWorkspaceId = await insertWorkspace(db, `peer-functionality-${crypto.randomUUID()}`);
    const firstWorkerId = await insertWorker(db, workspaceId, null, "first", "model");
    const secondWorkerId = await insertWorker(db, workspaceId, null, "second", "model");
    const peerWorkerId = await insertWorker(db, peerWorkspaceId, null, "peer", "model");
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
            } as unknown as Executor,
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
    // A person's client operation acting for one of the workspace's workers ({§actor-boundary-client-operations}).
    const dispatch = async (daemon: Daemon, id: number, workerId: number) => (await daemon.dispatchClientAction({
        workspaceId: id, actor: TEST_OWNER, contextWorkerId: workerId, statements: [Dsl.buildExec({ runtime: tag, command: "fixture" })],
    }))[0]!;
    const daemon = new Daemon({ db, provider: null });
    assert.throws(() => daemon.registerWorkspaceCapabilityProvider("incomplete fixture",
        { activate: async () => undefined } as never), /requires activate and deactivate functions/);
    daemon.registerModule(capabilityModule, "test-module");
    try {
        await daemon.start();
        await daemon.attachWorkspace({ workspaceId });
        await daemon.attachWorkspace({ workspaceId });
        assert.deepEqual(activated, [], "boot and attachment are passive");

        assert.equal((await dispatch(daemon, workspaceId, firstWorkerId)).status, 200);
        assert.equal((await dispatch(daemon, workspaceId, secondWorkerId)).status, 200);
        assert.equal((await dispatch(daemon, peerWorkspaceId, peerWorkerId)).status, 200);
        assert.deepEqual(activated, [workspaceId, peerWorkspaceId], "one activation per workspace");
        assert.deepEqual(executions, [workspaceId, workspaceId, peerWorkspaceId]);

        await activeSetupSeam().replaceWorkspaceCapabilities({
            workspaceId, namespaceOwner: owner, state: { detached: true }, runtimes: [],
        });
        for (const workerId of [firstWorkerId, secondWorkerId]) {
            assert.equal((await dispatch(daemon, workspaceId, workerId)).status, 400,
                "withdrawal changes the tool surface in this workspace, whichever worker an operation acts for");
        }
        assert.equal((await dispatch(daemon, peerWorkspaceId, peerWorkerId)).status, 200,
            "a different workspace keeps its independent environment");
        assert.deepEqual(await activeSetupSeam().readWorkspaceModuleState(workspaceId, owner), { detached: true });

        await assert.rejects(() => activeSetupSeam().replaceWorkspaceCapabilities({
            workspaceId, namespaceOwner: owner, state: { corrupted: true },
            runtimes: [{ ...registration(workspaceId), decl: { ...registration(workspaceId).decl, name: "worker" } }],
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
        for (const workerId of [firstWorkerId, secondWorkerId]) {
            assert.equal((await dispatch(restored, workspaceId, workerId)).status, 400,
                "every operation in the workspace sees the restored withdrawal");
        }
        assert.equal((await dispatch(restored, peerWorkspaceId, peerWorkerId)).status, 200);
        assert.deepEqual(activated, [workspaceId, peerWorkspaceId]);
    } finally {
        await restored.stop();
        await db.close();
    }
});

test("Daemon: concurrent worker demands share one Functionality activation", async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `workspace-cap-concurrent-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
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
                scope: "worker",
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
            { scope: "worker", workspaceId, workerId },
        );
        await activationStarted.promise;
        const second = daemon.invokeModuleAction(
            "capability.probe",
            {},
            { scope: "worker", workspaceId, workerId },
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
                { scope: "worker", workspaceId, workerId },
            ),
            { ready: true },
        );
        assert.equal(activations, 1, "the activated worker remains warm");
    } finally {
        releaseActivation.resolve();
        await daemon.stop();
        await db.close();
    }
});

test("{§module-workspace-provider} Daemon cools idle capabilities, retained provider work postpones cooling, and later demand reactivates", async (t) => {
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
    const workerId = await insertWorker(db, workspaceId);
    const activations: number[] = [];
    const deactivations: number[] = [];
    let retainWorker: (() => () => void) | null = null;
    const retainedWork: { release: (() => void) | null } = { release: null };
    const daemon = new Daemon({ db, provider: null });
    daemon.registerModule({
        setup: (seam) => {
            seam.registerWorkspaceCapabilityProvider("residency capability fixture", {
                activate: async (context) => {
                    activations.push(context.workspaceId);
                    retainWorker = context.retain;
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
                scope: "worker",
                residency: "required",
                inputSchema: MODULE_INPUT_SCHEMA,
                outputSchema: MODULE_OUTPUT_SCHEMA,
                handler: async (params) => {
                    if (params.hold === true) {
                        if (retainWorker === null) throw new Error("provider retention was unavailable");
                        retainedWork.release = retainWorker();
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
                { scope: "worker", workspaceId, workerId },
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
                { scope: "worker", workspaceId, workerId },
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

test("failed worker Functionality deactivation remains resident for the retry owner", async (t) => {
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
    const workerId = await insertWorker(db, workspaceId);
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
                scope: "worker",
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
            { scope: "worker", workspaceId, workerId },
        );
        await waitFor(() => [deactivations], ([count]) => count === 1);
        await daemon.invokeModuleAction(
            "capability.failed-cooling-probe",
            {},
            { scope: "worker", workspaceId, workerId },
        );
        assert.equal(
            activations,
            1,
            "a rejected deactivation does not falsely evict and reactivate the worker",
        );
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("Daemon first Functionality demand reconciles generated skills for an existing worker", async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `boot-docs-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const daemon = new Daemon({ db, provider: null });
    daemon.registerModule({
        setup: (seam) => {
            seam.registerModuleAction({
                name: "docs.probe",
                scope: "worker",
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
            await db.test_entries_by_scheme_prefix.all({ workspace_id: workspaceId, scheme: "worker", prefix: "/_plurnk/plurnk/%" }),
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
            await db.test_entries_by_scheme_prefix.all({ workspace_id: workspaceId, scheme: "worker", prefix: "/_plurnk/plurnk/%" }),
            [],
            "attachment remains passive",
        );
        assert.deepEqual(
            await daemon.invokeModuleAction("docs.probe", {}, { scope: "worker", workspaceId, workerId }),
            { ready: true },
        );
        const docs = await db.test_entries_by_scheme_prefix.all<{ pathname: string }>({ workspace_id: workspaceId, scheme: "worker", prefix: "/_plurnk/plurnk/%" });
        assert.ok(docs.length > 0, "capability demand publishes the current installed skills surface into an existing workspace");
        assert.equal(
            docs.some(({ pathname }) => pathname === "/_plurnk/plurnk/log.md" || pathname === "/_plurnk/plurnk/prompt.md"),
            false,
            "self-evident log and prompt schemes do not materialize redundant pull documentation",
        );
        const generated = await db.crud_find_workspace_entry.get<{ id: number }>({
            workspace_id: workspaceId,
            scheme: "worker",
            authority: "",
            pathname: docs[0]!.pathname,
        });
        assert.ok(generated !== undefined, "activation publication belongs to the addressed worker");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§methods-workspace-create} workspace.create returns id+name, mints no worker, and emits notification", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const notifications = subscribeNotifications(ws, "workspace/created");
            const response = await rpcCall(ws, 1, "workspace.create", { name: "alpha" });
            const result = response.result as { id: number; name: string };
            assert.equal(result.name, "alpha");
            assert.ok(result.id > 0);
            await flush();
            const captured = notifications();
            assert.equal(captured.length, 1);
            const params = captured[0] as { id: number; name: string };
            assert.equal(params.id, result.id);
            assert.equal(params.name, "alpha");

            const workspaceList = await db.test_list_workspaces.all<{ name: string }>();
            assert.ok(workspaceList.some((s) => s.name === "alpha"));
            assert.deepEqual(await daemon.listWorkers(result.id), [], "creating a workspace mints no worker");
        } finally { ws.close(); }
    });
});

test("workspace.create with no name auto-generates a unique name", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.create");
            const result = response.result as { id: number; name: string };
            assert.match(result.name, /^[0-9A-Za-z]{5}$/, "{§workspace-auto-name}: five anchor-alphabet characters, no prefix");
        } finally { ws.close(); }
    });
});

test("{§workspace-name} workspace.create with a project root and no name is named after the root and selects that world next time", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const home = new HostPaths().home;
        const inside = await mkdtemp(join(home, "project-"));
        const outside = await mkdtemp(join(tmpdir(), "plurnk-outside-"));
        const ws = await connect(addr);
        try {
            const first = (await rpcCall(ws, 1, "workspace.create", { projectRoot: inside })).result as { id: number; name: string };
            assert.equal(first.name, `~/${basename(inside)}`, "the root's path with the daemon's home abbreviated to ~");
            const again = (await rpcCall(ws, 2, "workspace.create", { projectRoot: inside })).result as { id: number; name: string };
            assert.equal(again.id, first.id, "a second default launch on the same project selects the same world");
            const [pair] = await Promise.all([
                daemon.createWorkspace({ projectRoot: inside }),
                daemon.createWorkspace({ projectRoot: inside }),
            ].map((p) => p.then(({ workspaceId }) => workspaceId)));
            assert.equal(pair, first.id, "a concurrent pair resolves to the one world");
            assert.equal((await daemon.listWorkspaces()).filter(({ name }) => name === first.name).length, 1, "no second world of that name");
            const far = (await rpcCall(ws, 3, "workspace.create", { projectRoot: outside })).result as { name: string };
            assert.equal(far.name, outside, "outside the home the name is the absolute path");
            await assert.rejects(daemon.createWorkspace({ name: first.name, projectRoot: inside }), (error: unknown) =>
                error instanceof OperationFailureError && /name-conflict$/u.test(error.result.problem?.type ?? ""), "an explicit name that exists is a conflict, never a selection");
            // The default is a convention, not a mapping: a renamed world is not re-selected by its old default.
            await daemon.renameWorkspace(first.id, "renamed-world");
            const fresh = (await rpcCall(ws, 4, "workspace.create", { projectRoot: inside })).result as { id: number; name: string };
            assert.notEqual(fresh.id, first.id);
            assert.equal(fresh.name, first.name);
        } finally {
            ws.close();
            await rm(inside, { recursive: true, force: true });
            await rm(outside, { recursive: true, force: true });
        }
    });
});

test("{§workspace-label} every envelope, row and created notice carries the folder's label beside it: a default name equals it, any other name leaves it be", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const home = new HostPaths().home;
        const inside = await mkdtemp(join(home, "label ü √ "));
        const outside = await mkdtemp(join(tmpdir(), "plurnk-label-"));
        const created: Array<{ name?: unknown; projectRoot?: unknown; projectLabel?: unknown }> = [];
        const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => { if (method === "workspace/created") created.push(params as never); });
        try {
            const named = await daemon.createWorkspace({ projectRoot: inside });
            const label = `~/${basename(inside)}`;
            assert.deepEqual([named.workspaceName, named.projectRoot, named.projectLabel], [label, inside, label], "a default name is its folder's label");
            const listed = (await daemon.listWorkspaces()).find(({ id }) => id === named.workspaceId);
            assert.equal(listed?.project_label, label);
            assert.equal(listed?.name, listed?.project_label, "a client compares name and label by equality");
            assert.deepEqual(created.at(-1), { id: named.workspaceId, name: label, projectRoot: inside, projectLabel: label });

            const explicit = await daemon.createWorkspace({ name: "explicit", projectRoot: inside });
            assert.deepEqual([explicit.workspaceName, explicit.projectLabel], ["explicit", label], "an explicit name is kept; the label comes from the folder alone");
            await daemon.renameWorkspace(named.workspaceId, "renamed");
            const attached = await daemon.attachWorkspace({ workspaceId: named.workspaceId });
            assert.deepEqual([attached.workspaceName, attached.projectLabel], ["renamed", label], "renaming changes no label");

            const far = await daemon.createWorkspace({ projectRoot: outside });
            assert.deepEqual([far.workspaceName, far.projectLabel], [outside, outside], "outside the home the label is the absolute spelling");
            const headless = await daemon.createWorkspace({ name: "no-folder" });
            assert.equal(headless.projectLabel, null);
            assert.equal((await daemon.listWorkspaces()).find(({ id }) => id === headless.workspaceId)?.project_label, null, "no folder, no invented label");
        } finally {
            unsubscribe();
            await rm(inside, { recursive: true, force: true });
            await rm(outside, { recursive: true, force: true });
        }
    });
});

test("{§workspace-name} a folderless world is created, listed, renamed and attached with its folder null throughout; a rename collision changes nothing", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const headless = await daemon.createWorkspace({ name: "headless" });
        assert.equal(headless.projectRoot, null);
        const other = await daemon.createWorkspace({ name: "other" });
        const listed = (await daemon.listWorkspaces()).find(({ id }) => id === headless.workspaceId);
        assert.equal(listed?.project_root, null, "listed without a folder");
        await assert.rejects(daemon.renameWorkspace(headless.workspaceId, "other"), (error: unknown) =>
            error instanceof OperationFailureError && /name-conflict$/u.test(error.result.problem?.type ?? ""));
        assert.equal((await daemon.listWorkspaces()).find(({ id }) => id === headless.workspaceId)?.name, "headless", "a collision renames nothing");
        const renamed = await daemon.renameWorkspace(headless.workspaceId, "headless-2");
        assert.equal(renamed.name, "headless-2");
        const attached = await daemon.attachWorkspace({ workspaceId: headless.workspaceId });
        assert.equal(attached.workspaceName, "headless-2");
        assert.equal(attached.projectRoot, null, "renaming leaves the folder null");
        assert.notEqual(other.workspaceId, headless.workspaceId);
    });
});

// {§workspace-name} — the admission matrix: every refused spelling at creation and at rename, every
// retained spelling by exact identity, the default derivation, and a workspace that predates the rule.
const REFUSED_SEGMENTS: ReadonlyArray<readonly [name: string, segment: string]> = [
    [".", "."], ["..", ".."], ["a/../b", ".."], ["a/./b", "."], ["../x", ".."], ["x/..", ".."], ["./x", "."], ["x/.", "."],
    ["~/ptl/../etc", ".."], ["/abs/./path", "."],
];
const ILL_FORMED = [String.fromCharCode(0xd800), `lead${String.fromCharCode(0xdc00)}`, `mid${String.fromCharCode(0xd83d)}tail`];
const RETAINED = [
    "~/ptl/project", "/abs/path", "plain", "with space", "ünïcödé/名前", "😀/emoji", "a@b", "100%", "100%25", "%2E%2E", "a/%2E%2E/b", "%2F",
    ".config", "file.txt", "...", "a/.../b", "..x", "x..", ".x/y.", "q?x=1#frag", "back\\slash", "trailing/", "/", "a//b", "~", "a~b",
];
const nameInvalid = (detail: RegExp) => (error: unknown): boolean =>
    error instanceof OperationFailureError && error.result.status === 400
    && /\/daemon\/input\/name-invalid$/u.test(error.result.problem?.type ?? "") && detail.test(error.result.problem?.detail ?? "");

test("{§workspace-name} creation and rename refuse a '.' or '..' segment and ill-formed Unicode as name-invalid; a refusal creates and renames nothing", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const standing = await daemon.createWorkspace({ name: "standing" });
        for (const [name, segment] of REFUSED_SEGMENTS) {
            const refusal = nameInvalid(new RegExp(`^name '.*' has the path segment '${segment.replaceAll(".", "\\.")}'\\.$`, "u"));
            await assert.rejects(daemon.createWorkspace({ name }), refusal, `create ${JSON.stringify(name)}`);
            await assert.rejects(daemon.renameWorkspace(standing.workspaceId, name), refusal, `rename to ${JSON.stringify(name)}`);
        }
        for (const name of ILL_FORMED) {
            const refusal = nameInvalid(/^name is not well-formed Unicode: it holds an unpaired surrogate\.$/u);
            await assert.rejects(daemon.createWorkspace({ name }), refusal, "create with an unpaired surrogate");
            await assert.rejects(daemon.renameWorkspace(standing.workspaceId, name), refusal, "rename to an unpaired surrogate");
        }
        assert.deepEqual((await daemon.listWorkspaces()).map(({ id, name }) => ({ id, name })), [{ id: standing.workspaceId, name: "standing" }],
            "no refused creation made a world, and no refused rename changed the name");
        const refused = await daemon.createWorkspace({ name: "a/../b" }).catch((error: unknown) => error);
        assert.ok(refused instanceof OperationFailureError);
        assert.equal(refused.result.problem?.recovery, "Provide a name with no '.' or '..' between its slashes; a dot within a segment is ordinary.");
        assert.equal(refused.result.problem?.segment, "..");
        assert.equal(refused.result.problem?.retryable, false);
    });
});

test("{§workspace-name} every other spelling is admitted as written at creation and at rename: no repair, no decoding, no collapse", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const created = new Map<number, string>();
        for (const name of RETAINED) {
            const world = await daemon.createWorkspace({ name });
            assert.equal(world.workspaceName, name, `create keeps ${JSON.stringify(name)} exactly`);
            created.set(world.workspaceId, name);
        }
        const listed = new Map((await daemon.listWorkspaces()).map(({ id, name }) => [id, name]));
        assert.deepEqual([...listed.entries()].toSorted(([a], [b]) => a - b), [...created.entries()].toSorted(([a], [b]) => a - b),
            "each name is stored as written and none collapsed into another");
        assert.equal(new Set(RETAINED).size, listed.size, "a literal %2E%2E, %2F and 100%25 stay distinct from what they would decode to");
        const carrier = await daemon.createWorkspace({ name: "carrier" });
        for (const name of RETAINED) {
            const target = `renamed ${name}`;
            assert.equal((await daemon.renameWorkspace(carrier.workspaceId, target)).name, target, `rename keeps ${JSON.stringify(target)} exactly`);
        }
    });
});

test("{§workspace-name} a root spelled with '.' or '..' derives the name of the folder it reaches; an ill-formed root is project-root-invalid", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const home = new HostPaths().home;
        const inside = await mkdtemp(join(home, "dotted-"));
        try {
            const plain = await daemon.createWorkspace({ projectRoot: inside });
            assert.equal(plain.workspaceName, `~/${basename(inside)}`);
            for (const spelling of [`${inside}/.`, `${inside}/sub/..`, `${home}/./${basename(inside)}`, `${inside}/../${basename(inside)}`]) {
                const selected = await daemon.createWorkspace({ projectRoot: spelling });
                assert.equal(selected.workspaceId, plain.workspaceId, `${spelling} selects the folder's world`);
                assert.equal(selected.workspaceName, plain.workspaceName, "and no dot segment reaches the name");
            }
            await assert.rejects(daemon.createWorkspace({ projectRoot: `${inside}/${String.fromCharCode(0xd800)}` }), (error: unknown) =>
                error instanceof OperationFailureError && error.result.status === 400
                && /\/project-root-invalid$/u.test(error.result.problem?.type ?? "")
                && error.result.problem?.detail === "projectRoot is not well-formed Unicode: it holds an unpaired surrogate.");
            assert.equal((await daemon.listWorkspaces()).length, 1, "the refused root made no world");
        } finally { await rm(inside, { recursive: true, force: true }); }
    });
});

test("{§workspace-name} a workspace already carrying a refused spelling stays listed and attachable and is renamed like any other, keeping its id, folder and workers", async () => {
    await withDaemon(null, async (db, daemon) => {
        const legacyId = await insertWorkspace(db, "old/../name");
        const { workerId } = await daemon.createWorker({ workspaceId: legacyId, name: "kept" });
        assert.equal((await daemon.listWorkspaces()).find(({ id }) => id === legacyId)?.name, "old/../name", "enumeration hides nothing");
        const attached = await daemon.attachWorkspace({ workspaceId: legacyId });
        assert.equal(attached.workspaceName, "old/../name", "it is attached under the name it carries");
        await assert.rejects(daemon.renameWorkspace(legacyId, "still/./refused"), nameInvalid(/has the path segment '\.'/u));
        assert.equal((await daemon.listWorkspaces()).find(({ id }) => id === legacyId)?.name, "old/../name", "the refused rename changed nothing");
        const renamed = await daemon.renameWorkspace(legacyId, "old/name");
        assert.deepEqual(renamed, { id: legacyId, name: "old/name" }, "the same world under an admitted name");
        const after = await daemon.attachWorkspace({ workspaceId: legacyId });
        assert.equal(after.projectRoot, attached.projectRoot, "its folder is untouched");
        assert.ok((await daemon.listWorkers(legacyId)).some(({ id }) => id === workerId), "its workers are kept");
    });
});

test("workspace.create on an already-attached connection re-binds in place (no reject)", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const first = await rpcCall(ws, 1, "workspace.create", { name: "first" });
            const second = await rpcCall(ws, 2, "workspace.create", { name: "second" });
            // {§methods-rebind}: re-binding is allowed; the connection switches in place.
            assert.equal(second.error, undefined, "re-create on a bound connection does not reject");
            assert.notEqual((second.result as { id: number }).id, (first.result as { id: number }).id, "switched to a fresh workspace");
        } finally { ws.close(); }
    });
});

test("workspace.list returns workspaces most-recent-first", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        await db.test_workspaces_insert_name_only.run({ name: "first" });
        await db.test_workspaces_insert_name_only.run({ name: "second" });

        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.list");
            const result = response.result as { workspaces: Array<{ id: number; name: string }> };
            assert.equal(result.workspaces.length, 2);
            const names = result.workspaces.map((s) => s.name).toSorted();
            assert.deepEqual(names, ["first", "second"]);
        } finally { ws.close(); }
    });
});

test("{§methods-workspace-attach} workspace.attach binds to an existing workspace and mints nothing", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const existing = await db.test_insert_workspace.get<{ id: number }>({ name: "existing" });

        const first = await connect(addr);
        const second = await connect(addr);
        try {
            for (const ws of [first, second]) {
                const response = await rpcCall(ws, 1, "workspace.attach", { id: existing?.id });
                const result = response.result as { id: number; name: string };
                assert.equal(result.id, existing?.id);
                assert.equal(result.name, "existing");
            }
            assert.deepEqual(await daemon.listWorkers(existing!.id), [], "binding a workspace, from any number of connections, mints no worker");
        } finally { first.close(); second.close(); }
    });
});

test("workspace.attach to nonexistent workspace returns an exact Problem", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.attach", { id: 9999 });
            const problem = rpcProblem(response);
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/workspace/workspace-not-found");
            assert.equal(problem.status, 404);
            assert.equal(problem.workspaceId, 9999);
        } finally { ws.close(); }
    });
});

test("providers.list returns parsed aliases with active marker", async () => {
    await withDaemon(new Mock({ contextWindow: 8192, responses: [] }), async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const original = { ...process.env };
            try {
                process.env.PLURNK_MODEL_gemma = "openai/macher.gguf";
                process.env.PLURNK_MODEL_opus = "openrouter/anthropic/claude-opus";
                process.env.PLURNK_MODEL = "gemma";
                const response = await rpcCall(ws, 1, "providers.list");
                const result = response.result as {
                    aliases: Array<{ alias: string; provider: string; model: string; active: boolean; inputCapacity: number | null }>;
                };
                const gemma = result.aliases.find((a) => a.alias === "gemma");
                const opus = result.aliases.find((a) => a.alias === "opus");
                assert.ok(gemma !== undefined && opus !== undefined);
                assert.equal(gemma?.provider, "openai");
                assert.equal(gemma?.model, "macher.gguf");
                assert.equal(gemma?.active, true);
                assert.equal(opus?.active, false);
                const capacity = 8192 - Number(process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET);
                assert.equal(gemma?.inputCapacity, capacity, "the active alias carries provider-derived input capacity");
                assert.equal(opus?.inputCapacity, null, "an inactive alias has no instantiated capacity");
            } finally {
                // Restore env so other tests aren't polluted.
                for (const k of Object.keys(process.env)) {
                    if (!(k in original)) delete process.env[k];
                }
                Object.assign(process.env, original);
            }
        } finally { ws.close(); }
    });
});
test("workspace.workers lists workers in the workspace, most-recent first", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const workspace = await db.test_insert_workspace.get<{ id: number }>({ name: "list-workers" });
        await db.test_workers_insert.run({ workspace_id: workspace?.id, name: "first" });
        await db.test_workers_insert.run({ workspace_id: workspace?.id, name: "second" });
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.workers", { id: workspace?.id });
            const result = response.result as { workers: Array<{ id: number; name: string; kind: string; lifecycle: string }> };
            assert.equal(result.workers.length, 2);
            assert.deepEqual(result.workers.map((r) => r.name).toSorted(), ["first", "second"]);
            // {§application-worker-observation} — a worker with no parent and no loop is an idle root (#523).
            assert.deepEqual(result.workers.map((r) => [r.kind, r.lifecycle]), [["root", "idle"], ["root", "idle"]]);
        } finally { ws.close(); }
    });
});

test("{§notifications-workspace-created} workspace/created notification broadcasts to other connected clients", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const observer = await connect(addr);
        const creator = await connect(addr);
        try {
            const observerNotifs = subscribeNotifications(observer, "workspace/created");

            await rpcCall(creator, 1, "workspace.create", { name: "broadcast-test" });
            await flush();

            const captured = observerNotifs();
            assert.equal(captured.length, 1);
            const params = captured[0] as { id: number; name: string };
            assert.equal(params.name, "broadcast-test");
        } finally { observer.close(); creator.close(); }
    });
});
test("the client-interface seam — subscribeToEvents delivers workspace-scoped engine events in-process", async () => {
    // The emit half of #broadcast, exposed as an in-process source: a transport module (plurnk-agui)
    // subscribes here and owns its client fan-out; core has no transport connections.
    await withDaemon(null, async (_db, daemon, addr) => {
        const received: Array<{ workspaceId: number | null; method: string; params: unknown }> = [];
        const unsubscribe = daemon.subscribeToEvents((workspaceId, method, params) => { received.push({ workspaceId, method, params }); });
        const ws = await connect(addr);
        try {
            const s = ((await rpcCall(ws, 1, "workspace.create", { name: "seam" })).result as { id: number }).id;
            const isCreated = (e: { method: string; params: unknown }): boolean => e.method === "workspace/created" && (e.params as { id?: number }).id === s;
            await waitFor(() => received, (r) => r.some(isCreated), { timeoutMs: 4000 });
            assert.ok(received.some(isCreated), "the in-process subscriber received the engine event without core owning transport fan-out");
            unsubscribe();
            const countAfter = received.length;
            await rpcCall(ws, 2, "workspace.create", { name: "seam-2" });
            await flush();
            assert.equal(received.length, countAfter, "unsubscribe stops delivery — the seam is a clean subscription");
        } finally { ws.close(); }
    });
});

test("the client-interface seam does not manufacture a resolver from an ownerless durable row", async () => {
    await withDaemon(null, async (db, daemon, _addr) => {
        const workspaceId = await insertWorkspace(db, `prop-seam-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        await ownWorker(db, workspaceId, workerId);
        const loopId = await insertLoop(db, workerId, 1, "p");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const row = await db.engine_insert_log_entry.get<{ id: number }>({
            worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence: 1,
            origin: "model", source: null, model_call_id: null, op: "EDIT",
            scheme: "worker", username: null, password: null, hostname: null, port: null,
            pathname: "/x", query: null, fragment: null, lineMarker: null,
            tx: "````EDIT (worker:///x)\nbody\n````", mimetype_tx: "text/vnd.plurnk",
            rx: JSON.stringify({ status: 202 }), mimetype_rx: "application/json",
            status_rx: 202, weight: 0, state: "proposed", outcome: null, attrs: "{}",
        });
        assert.ok(row !== undefined);
        const pending = await daemon.pendingProposals(workspaceId);
        assert.deepEqual(pending, [], "persistence without this process's lifecycle owner is not a stopped world");
        const problem = await rejectedProblem(() => daemon.resolveProposal(row.id, { decision: "accept" }, { workspaceId, address: TEST_OWNER }));
        assert.equal(problem.type, "https://problems.plurnk.xyz/proposal/resolution/proposal-not-pending");
        assert.equal(problem.status, 409);
        assert.equal(problem.logEntryId, row.id);
    });
});

test("the client-interface seam — runLoop drives a loop end to end on the daemon's own provider + law", async () => {
    // The loop-control hook: the module supplies only workspace/worker/prompt; runLoop fills in the provider
    // and the law-file system prompt (core's), fires the drain via the unified inject, and returns. The
    // outcome arrives on the event source, not a socket. `cancelDrain` (already public) is the cancel hook.
    // A window that comfortably holds the packet: this test drives a loop to CONCLUSION and asserts
    // 200, so the full system prompt (law/definition) + the materialized docs must fit the prompt
    // budget. This test verifies the seam path, not small-window viability
    // ({§tokenomics-window-partition}).
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse("````SEND [200]\ndone\n````", 50),
        makeMockResponse("````SEND [200]\ndone again\n````", 50),
    ] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-runloop" })).result as { id: number };
            const events: Array<{ method: string; params: unknown }> = [];
            daemon.subscribeToEvents((_s, method, params) => { events.push({ method, params }); });

            assert.deepEqual(
                await db.test_entries_by_scheme_prefix.all({ workspace_id: created.id, scheme: "worker", prefix: "/_plurnk/plurnk/%" }),
                [],
                "workspace creation remains passive until real work arrives",
            );
            assert.equal(
                daemon.workspaceDerivationStatus(created.id),
                null,
                "workspace creation does not launch semantic derivation",
            );

            // {§machine-processes} — loops run in a model worker; the runtime actor, where a person's client
            // operations journal ({§connection-lifecycle}), is refused loudly as a loop home.
            const runtimeWorkerId = await daemon.ensureRuntimeWorker(created.id);
            const runtimeProblem = await rejectedProblem(() => daemon.runLoop({
                workspaceId: created.id,
                workerId: runtimeWorkerId,
                prompt: "go",
            }));
            assert.equal(runtimeProblem.type, "https://problems.plurnk.xyz/daemon/worker/model-worker-required");
            assert.equal(runtimeProblem.status, 409);
            assert.equal(runtimeProblem.workerId, runtimeWorkerId);
            // {§worker-model-selection} — the model, reasoning, and spawn-model controls are model-worker
            // surfaces: the runtime actor is refused before any policy row is initialized.
            for (const [surface, call] of [
                ["worker.model.get", () => daemon.readWorkerModel({ workspaceId: created.id, workerId: runtimeWorkerId })],
                ["worker.model.set", () => daemon.setWorkerModel({ workspaceId: created.id, workerId: runtimeWorkerId, selector: "mock/mocktest" })],
                ["worker.effort.get", () => daemon.readWorkerEffort({ workspaceId: created.id, workerId: runtimeWorkerId })],
                ["worker.effort.set", () => daemon.setWorkerEffort({ workspaceId: created.id, workerId: runtimeWorkerId, effort: "low" })],
                ["worker.child.set", () => daemon.setWorkerSpawnModel({ workspaceId: created.id, workerId: runtimeWorkerId, selector: null })],
            ] as const) {
                const refused = await rejectedProblem(call);
                assert.equal(refused.type, "https://problems.plurnk.xyz/daemon/worker/model-worker-required", `${surface} refuses a non-model worker`);
                assert.equal(refused.status, 409);
            }
            const modelWorkerId = await namedModelWorker(daemon, created.id, "main");
            const res = await daemon.runLoop({ workspaceId: created.id, workerId: modelWorkerId, prompt: "go" });
            assert.equal(res.action, "enqueued_new_loop", "runLoop enqueued a fresh loop");
            assert.ok(res.loopId > 0, "runLoop returned the new loop id");

            const terminals = await waitFor(
                () => events.filter((e) => e.method === "loop/terminated" && (e.params as { loopId?: number }).loopId === res.loopId),
                (ts) => ts.length > 0,
                { timeoutMs: 8000 },
            );
            assert.equal((terminals[0].params as { result: { status: number } }).result.status, 200, "the loop runLoop started ran to conclusion (200) — driven and observed through the seam, no socket");

            // The first-turn feature holds on the seam path: Functionality activation materialized
            // the teaching skills into the model worker before packet assembly.
            const docs = await db.test_entries_by_scheme_prefix.all<{ pathname: string }>({ workspace_id: created.id, scheme: "worker", prefix: "/_plurnk/plurnk/%" });
            assert.ok(docs.length > 0);
            const docEdits = (await db.test_log_entries_by_worker_op_full.all<{
                tx: string;
                origin: string;
            }>({ worker_id: runtimeWorkerId, op: "EDIT" })).filter(({ origin }) => origin === "_plurnk");
            assert.ok(docEdits.length > 0, "documentation publication dispatches structural EDIT statements");
            for (const { tx } of docEdits) {
                const statement = JSON.parse(tx) as unknown;
                assert.equal(Validator.validatePlurnkStatement(statement).valid, true);
                const position = (statement as { position?: { line?: number; column?: number } }).position;
                assert.equal(position?.column, 0);
                assert.ok((position?.line ?? 0) > 0, "generated EDIT carries its honest position in the admitted turnOps source");
            }
            const publicationRows = async () => (await db.test_log_entries_by_worker.all<{
                op: string;
                pathname: string | null;
                status_rx: number;
                origin: string;
            }>({ worker_id: runtimeWorkerId })).filter(({ origin, pathname }) =>
                origin === "_plurnk"
                && (pathname === "/_plurnk/AGENTS.md" || pathname?.startsWith("/_plurnk/skills/") === true));
            const publishedCount = (await publicationRows()).length;

            const second = await daemon.runLoop({ workspaceId: created.id, workerId: modelWorkerId, prompt: "go again" });
            const secondTerminals = await waitFor(
                () => events.filter((e) => e.method === "loop/terminated" && (e.params as { loopId?: number }).loopId === second.loopId),
                (ts) => ts.length > 0,
                { timeoutMs: 8000 },
            );
            assert.equal((secondTerminals[0].params as { result: { status: number } }).result.status, 200, "reattaching to the workspace runs normally");

            const afterTwoLoops = await publicationRows();
            assert.equal(afterTwoLoops.length, publishedCount, "model loops never repeat unchanged worker skills publication");
            assert.equal(afterTwoLoops.filter((row) => row.op === "EDIT" && row.status_rx >= 400).length, 0, "worker skills publication produces no error rows");
        } finally { ws.close(); }
    });
});

test("{§methods-op-mirror} the client-interface seam — dispatchClientAction runs a client op through the engine and emits log/entry", async () => {
    // The op keystone: one seam op backs the whole op_* family. The module parses at its edge and hands
    // over the statement; the op is journaled client-origin, dispatched, and the entry emitted on the source.
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-dispatch" })).result as { id: number };
            const entries: Array<{ method: string; params: unknown }> = [];
            daemon.subscribeToEvents((_s, method, params) => { entries.push({ method, params }); });
            const operate = async (statement: PlurnkStatement) =>
                (await daemon.dispatchClientAction({ workspaceId: created.id, actor: TEST_OWNER, statements: [statement] }))[0]!;

            // WRITE then READ worker:///x through the seam — a positive roundtrip proving dispatch + journal.
            const wrote = await operate(Dsl.buildEdit({ target: "worker:///x", content: "seam" }));
            assert.equal(wrote.status, 201, "the client EDIT created the entry through the seam (201)");
            const read = await operate(Dsl.buildRead({ target: "worker:///x" }));
            assert.equal(read.status, 200);
            assert.equal(read.content, "seam", "the value roundtripped — the op executed through the engine, not a shadow path");

            const emitted = entries.filter((e) => e.method === "log/entry");
            assert.ok(emitted.length >= 2, "each dispatched client op emitted a log/entry on the event source (agui fans out to its own clients)");
        } finally { ws.close(); }
    });
});

test("{§connection-lifecycle} {§actor-boundary-client-operations} one client operation owns every statement in one loop of the runtime worker, attributed to its person", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-action-journal" })).result as { id: number };
            const heard: Array<{ workerId: number; loopId: number }> = [];
            const order: string[] = [];
            daemon.subscribeToEvents((_s, method) => { if (method === "log/entry") order.push("entry"); });
            const operation = (actor: string, statements: PlurnkStatement[]) => daemon.dispatchClientAction({
                workspaceId: created.id, actor, statements,
                onLoop: (loop) => { heard.push(loop); order.push("loop"); },
            });

            const results = await operation("test://primary", [
                Dsl.buildEdit({ target: "worker:///x", content: "one action" }),
                Dsl.buildRead({ target: "worker:///x" }),
            ]);
            assert.deepEqual(results.map((result) => result.status), [201, 200]);
            assert.equal(heard.length, 1, "the operation announced exactly one loop");
            assert.deepEqual(order, ["loop", "entry", "entry"], "the loop is announced before any statement runs");
            const [{ workerId, loopId }] = heard;
            const runtime = await daemon.readWorker({ workspaceId: created.id, identity: { id: workerId } });
            assert.equal(runtime?.origin, "_plurnk", "the operation journals in the workspace's runtime worker");
            assert.equal(runtime?.name, "_plurnk");

            const turns = await db.test_list_turns_in_loop.all<{ sequence: number; producer: string; kind: string }>({ loop_id: loopId });
            assert.deepEqual(
                turns.map(({ sequence, producer, kind }) => [sequence, producer, kind]),
                [[1, "client", "operation"], [2, "client", "operation"]],
                "each statement is a distinct ordered client operation turn in the one loop",
            );
            assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status, 200, "the loop closes 200 when the operation succeeds");
            const rows = (await db.test_log_entries_by_worker.all<{ loop_id: number; origin: string; source: string | null }>({ worker_id: workerId }))
                .filter((row) => row.loop_id === loopId);
            assert.equal(rows.length, 2);
            assert.deepEqual(rows.map(({ origin, source }) => [origin, source]), [["client", null], ["client", null]],
                "every row the operation writes is a client-origin act, not an arrival");
            const promptSource = async (id: number) =>
                (await daemon.listWorkerLoops({ workspaceId: created.id, workerId })).find((loop) => loop.id === id)?.promptSource;
            assert.equal(await promptSource(loopId), "test://primary", "the operation's loop names its person");

            // A second person's operation is its own loop in the same runtime worker, attributed to that person.
            await operation("test://secondary", [Dsl.buildRead({ target: "worker:///x" })]);
            assert.equal(heard.length, 2);
            assert.equal(heard[1]!.workerId, workerId, "every person's operation journals in the one runtime worker");
            assert.notEqual(heard[1]!.loopId, loopId, "each operation owns its own loop");
            assert.equal(await promptSource(heard[1]!.loopId), "test://secondary");
            assert.deepEqual((await daemon.listWorkers(created.id)).map(({ origin }) => origin), ["_plurnk"],
                "client operations mint no worker beyond the runtime worker");
        } finally { ws.close(); }
    });
});

test("{§methods-log-read} the client-interface seam — readLog returns a workspace's journal, ownership-verified", async () => {
    // The module's primary render input. Seeded here via the dispatch seam, read back via readLog, and the
    // cross-workspace invariant proven: a workspace reads only its own workers (core holds it, not the module).
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-read" })).result as { id: number };
            await daemon.dispatchClientAction({ workspaceId: created.id, actor: TEST_OWNER, statements: [Dsl.buildEdit({ target: "worker:///x", content: "read me" })] });

            const entries = await daemon.readLog({ workspaceId: created.id, workerId: await daemon.ensureRuntimeWorker(created.id) });
            assert.ok(entries.length >= 1, "readLog returned the workspace's journal entries");
            assert.ok(entries.some((e) => e.op === "EDIT"), "the client EDIT is in the journal the seam read");

            const other = (await rpcCall(ws, 2, "workspace.create", { name: "seam-read-other" })).result as { id: number };
            const otherWorker = await daemon.ensureRuntimeWorker(other.id);
            const problem = await rejectedProblem(() => daemon.readLog({
                workspaceId: created.id,
                workerId: otherWorker,
            }));
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/worker/workspace-mismatch");
            assert.equal(problem.status, 409);
            assert.equal(problem.actualWorkspaceId, other.id);
        } finally { ws.close(); }
    });
});

test("the client-interface seam — metadata reads surface providers, workspaces, workers, and constraints", async () => {
    // The render surface beyond the journal: providers+budget, workspaces, workers, and the constraint overlay.
    const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("````SEND [200]\ndone\n````", 10)] });
    await withDaemon(mock, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-meta" })).result as { id: number };

            // providers + capacity — the active test alias is mocktest, carrying derived input capacity.
            const providers = daemon.listProviders();
            const active = providers.aliases.find((a) => a.active);
            assert.ok(active !== undefined, "listProviders reports the active alias");
            assert.equal(active!.alias, "mocktest");
            assert.equal(typeof active!.inputCapacity, "number", "the active alias carries resolved input capacity");

            // workspaces + workers — the created workspace and its model worker are present.
            const workspaces = await daemon.listWorkspaces();
            assert.ok(workspaces.some((s) => s.id === created.id), "listWorkspaces includes the created workspace");
            const modelWorkerId = await namedModelWorker(daemon, created.id, "main");
            const workers = await daemon.listWorkers(created.id);
            assert.deepEqual(workers.map(({ id }) => id), [modelWorkerId], "listWorkers returns the workspace's workers");

            // prompts — a thin delegation; assert the wiring resolves cleanly.
            const prompts = await daemon.listPrompts(created.id);
            assert.ok(Array.isArray(prompts), "listPrompts returns the workspace's prompt history");
        } finally { ws.close(); }
    });
});

test("{§methods-workspace-create} {§methods-workspace-attach} the client-interface seam — workspace lifecycle: create/attach/rename", async () => {
    // {§methods-workspace-create}: the module decodes its protocol; core owns semantic validation,
    // the envelope, name invariants, membership, and workspace/created.
    const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("````SEND [200]\ndone\n````", 10)] });
    await withDaemon(mock, async (_db, daemon, _addr) => {
        const events: Array<{ method: string; params: unknown }> = [];
        daemon.subscribeToEvents((_s, method, params) => { events.push({ method, params }); });

        // create — returns the envelope + emits workspace/created.
        const env = await daemon.createWorkspace({ name: "seam-life" });
        assert.ok(env.workspaceId > 0, "createWorkspace returns the envelope");
        assert.deepEqual(
            Object.keys(env).toSorted(),
            ["projectLabel", "projectRoot", "workspaceId", "workspaceName"],
            "{§methods-rebind}: the envelope carries the workspace's identity only",
        );
        assert.ok(events.some((e) => e.method === "workspace/created" && (e.params as { id?: number }).id === env.workspaceId), "workspace/created emitted on the event source");

        const attached = await daemon.attachWorkspace({ workspaceId: env.workspaceId });
        assert.equal(attached.workspaceId, env.workspaceId, "attachWorkspace returns an envelope on the same workspace");
        assert.deepEqual(
            Object.keys(attached).toSorted(),
            ["projectLabel", "projectRoot", "workspaceId", "workspaceName"],
            "{§methods-rebind}: attach does not fabricate a bound-worker or action-loop binding",
        );
        assert.deepEqual(await daemon.listWorkers(env.workspaceId), [], "neither creation nor attachment mints a worker");

        // rename — mutations return the applied value; a name collision is refused. (No root
        // mutation on the seam: the workspace pointer is set at workspace.create or never.)
        assert.equal((await daemon.renameWorkspace(env.workspaceId, "seam-life-2")).name, "seam-life-2");
        await daemon.createWorkspace({ name: "seam-life-other" });
        const renameProblem = await rejectedProblem(() =>
            daemon.renameWorkspace(env.workspaceId, "seam-life-other"));
        assert.equal(renameProblem.type, "https://problems.plurnk.xyz/daemon/workspace/name-conflict");
        assert.equal(renameProblem.status, 409);
        assert.equal(renameProblem.name, "seam-life-other");

    });
});

test("the client-interface seam — readEntry returns an entry's shape and incremental channel slice", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-entry" })).result as { id: number };
            await daemon.dispatchClientAction({ workspaceId: created.id, actor: TEST_OWNER, statements: [Dsl.buildEdit({ target: "worker:///x", content: "hello world" })] });
            // A client reads entries from the perspective of a worker of its workspace.
            const reader = await namedModelWorker(daemon, created.id, "main");

            // full shape — the written content is on one of the entry's channels.
            const entry = (await daemon.readEntry({ workspaceId: created.id, workerId: reader, target: "worker:///x" })).entry!;
            const found = Object.entries(entry.channels).find(([, c]) => c.content.includes("hello"));
            assert.ok(found !== undefined, "readEntry returns the entry's channels with content");
            const [channel, chan] = found!;
            assert.equal(chan.content, "hello world");
            assert.equal(chan.contentLength, 11);

            // {§methods-entry-read}: an offset returns only that channel's remaining content.
            const sliced = (await daemon.readEntry({ workspaceId: created.id, workerId: reader, target: "worker:///x", channel, offset: 6 })).entry!;
            assert.equal(sliced.channels[channel].content, "world", "the incremental read returns only the delta from the offset");
            assert.equal(sliced.channels[channel].contentLength, 11, "contentLength is the full length — the next poll resumes from there");

            // a missing entry is 404; an offset without a channel is refused.
            const missing = await daemon.readEntry({ workspaceId: created.id, workerId: reader, target: "worker:///nope" });
            assert.equal(missing.status, 404);
            assert.ok("problem" in missing);
            assert.equal(missing.problem.type, "https://problems.plurnk.xyz/daemon/entry/entry-not-found");
            assert.equal(missing.problem.target, "worker:///nope");
            const offset = await daemon.readEntry({ workspaceId: created.id, workerId: reader, target: "worker:///x", offset: 3 });
            assert.equal(offset.status, 400);
            assert.ok("problem" in offset);
            assert.equal(offset.problem.type, "https://problems.plurnk.xyz/daemon/entry/offset-channel-required");
            assert.equal(offset.problem.recovery, "Select the channel to read from the offset."); // {§problems-functionality}

            const networkEntry = await db.test_seed_entry_workspace.get<{ id: number }>({ attributes: "{}", default_channel: "body", output: 0,
                workspace_id: created.id,
                scheme: "https",
                authority: "example.org:8443",
                pathname: "/x?b=2&a=1&a=3",
            });
            assert.ok(networkEntry !== undefined);
            await db.test_seed_channel_hashed.run({
                entry_id: networkEntry.id,
                name: "body",
                content: "network body",
                mimetype: "text/plain",
                weight: 2,
                content_hash: null,
                state: "static",
            });
            const network = await daemon.readEntry({
                workspaceId: created.id,
                workerId: reader,
                target: "https://example.org:8443/x?b=2&a=1&a=3#body",
            });
            assert.equal(network.status, 200);
            assert.equal(network.entry?.target, "https://example.org:8443/x?b=2&a=1&a=3");
            assert.equal(network.entry?.channels.body.content, "network body");

            const userinfo = await daemon.readEntry({
                workspaceId: created.id,
                workerId: reader,
                target: "https://alice:secret@example.org:8443/x?b=2&a=1&a=3",
            });
            assert.equal(userinfo.status, 400);
            assert.ok("problem" in userinfo);
            assert.equal(userinfo.problem.type, "https://problems.plurnk.xyz/daemon/entry/userinfo-not-allowed");
            assert.doesNotMatch(JSON.stringify(userinfo), /alice|secret/);
        } finally { ws.close(); }
    });
});

test("the client-interface seam — forkWorker branches a worker's log, ownership + name invariants held", async () => {
    const mock = new Mock({ contextWindow: viableWindow(), responses: [makeMockResponse("````SEND [200]\ndone\n````", 10)] });
    await withDaemon(mock, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-fork" })).result as { id: number };
            // A model worker with a completed loop to branch.
            const { finalStatus, modelWorkerId } = await runLoopToTerminal(ws, 2, { prompt: "branch me" });
            assert.equal(finalStatus, 200);
            const sourceWorker = modelWorkerId!;

            const branch = await daemon.forkWorker({ workspaceId: created.id, workerId: sourceWorker, name: "My_branch" });
            assert.ok(branch.workerId > 0 && branch.workerId !== sourceWorker, "forkWorker created a new worker");
            assert.equal(branch.parentWorkerId, sourceWorker, "the branch is lineaged to its parent");
            assert.equal(branch.workerName, "My_branch");
            // {§application-worker-observation} — the directory says how it was minted (#523).
            const observed = await daemon.readWorker({ workspaceId: created.id, identity: { id: branch.workerId } });
            assert.equal(observed?.kind, "fork");
            // A fork inherits its parent's loops by snapshot, so its latest loop is the completed one it forked from.
            assert.equal(observed?.lifecycle, "completed");
            const parent = await daemon.readWorker({ workspaceId: created.id, identity: { id: sourceWorker } });
            assert.equal(parent?.kind, "root");

            // invariants: the runtime actor's name and a foreign worker are both refused.
            await assert.rejects(() => daemon.forkWorker({ workspaceId: created.id, workerId: sourceWorker, name: "_plurnk" }), /must match \[A-Za-z0-9\]\[A-Za-z0-9_-\]\{0,62\}/);
            const invalidName = await rejectedProblem(() => daemon.forkWorker({
                workspaceId: created.id,
                workerId: sourceWorker,
                name: "_invalid",
            }));
            assert.equal(invalidName.type, "https://problems.plurnk.xyz/daemon/worker/name-invalid");
            assert.equal(invalidName.status, 400);
            assert.equal(invalidName.name, "_invalid");
            assert.equal(invalidName.retryable, false);
            const other = (await rpcCall(ws, 3, "workspace.create", { name: "seam-fork-other" })).result as { id: number };
            const otherWorker = await namedModelWorker(daemon, other.id, "main");
            const problem = await rejectedProblem(() => daemon.forkWorker({
                workspaceId: created.id,
                workerId: otherWorker,
            }));
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/worker/workspace-mismatch");
            assert.equal(problem.status, 409);
            assert.equal(problem.actualWorkspaceId, other.id);
        } finally { ws.close(); }
    });
});

test("the module setup seam registers a live tag, dispatchable through the engine", async () => {
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
            assert.equal(exec!.status, 200, "the module runtime is dispatchable through the seam's dispatch path");

            // one-name-one-owner arbitration flows through the seam: a dup and a reserved name fail-hard.
            await assert.rejects(() => daemon.registerRuntime(fakeRegistration("seamtag")), /already/i, "a dup tag is rejected");
            await assert.rejects(() => daemon.registerRuntime(fakeRegistration("worker")), /reserved/i, "a reserved built-in name is rejected");
        } finally { ws.close(); }
    });
});

test("the client-interface seam — a dispatched execution's stdout streams as stream/event on the event source", async () => {
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

test("the client-interface seam — the boot plug-point hands a registered module a live ApplicationPort", async () => {
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

test("Daemon.stop disposes its owned mimetypes after derivations exactly once", async () => {
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

test("Daemon.stop leaves constructor-injected mimetypes caller-owned", async () => {
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

test("daemon shutdown preserves module and scheme lifecycle failures in one aggregate", async () => {
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

test("{§crash-only-stop}: every shutdown owner shares the absolute stop deadline", async (t) => {
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
                setTimeout(() => reject(new Error("test guard: daemon stop remained unbounded")), 500);
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

test("a module that acquires resources during setup is closed when later setup fails", async () => {
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

test("{§actor-boundary-attached-functionality} {§connection-lifecycle} a person's client operations share workspace Functionality and journal in the runtime worker", async () => {
    const db = await openMigrated();
    const owner = "attached Functionality test module";
    const tag = "attachedcap";
    const workspaceId = await insertWorkspace(db, `attached-functionality-${crypto.randomUUID()}`);
    const modelWorkerId = await insertWorker(db, workspaceId, null, "primary", "model");
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
                            } as unknown as Executor,
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

        // The runtime belongs to the workspace; the operation belongs to the person who acted, here for the model worker.
        const [attached] = await daemon.dispatchClientAction({
            workspaceId,
            actor: TEST_OWNER,
            contextWorkerId: modelWorkerId,
            statements: [Dsl.buildExec({ runtime: tag, command: "acting for the model worker" })],
        });
        assert.equal(attached!.status, 200);
        assert.deepEqual(activated, [workspaceId], "residency is acquired for the workspace");
        assert.deepEqual(executions, [workspaceId], "the shared runtime ran");
        const runtimeWorkerId = await daemon.ensureRuntimeWorker(workspaceId);
        const clientRows = (await db.test_log_entries_by_worker.all<{ origin: string; loop_id: number }>({ worker_id: runtimeWorkerId }))
            .filter(({ origin }) => origin === "client");
        assert.equal(clientRows.length, 1, "the client operation journals in the runtime worker");
        const operationLoop = (await daemon.listWorkerLoops({ workspaceId, workerId: runtimeWorkerId }))
            .find(({ id }) => id === clientRows[0]!.loop_id);
        assert.equal(operationLoop?.promptSource, TEST_OWNER, "the operation's loop names its person");
        const modelRows = await db.test_log_entries_by_worker.all<{ origin: string }>({ worker_id: modelWorkerId });
        assert.equal(
            modelRows.some(({ origin }) => origin === "client"),
            false,
            "no client row enters the log of the model worker the person acted for",
        );

        // Acting for no worker uses the same environment.
        const [unattached] = await daemon.dispatchClientAction({
            workspaceId,
            actor: TEST_OWNER,
            statements: [Dsl.buildExec({ runtime: tag, command: "acting for no worker" })],
        });
        assert.equal(unattached!.status, 200, "an operation acting for no worker can use the workspace runtime");
        assert.deepEqual(executions, [workspaceId, workspaceId]);

        // The worker an operation acts for must be a model worker of the workspace.
        const foreignWorkspace = await insertWorkspace(db, `attached-foreign-${crypto.randomUUID()}`);
        const foreignWorker = await insertWorker(db, foreignWorkspace, null, "elsewhere", "model");
        await assert.rejects(
            () => daemon.dispatchClientAction({
                workspaceId,
                actor: TEST_OWNER,
                contextWorkerId: foreignWorker,
                statements: [Dsl.buildExec({ runtime: tag, command: "cross-workspace" })],
            }),
            (error: unknown) => {
                assert.ok(error instanceof OperationFailureError);
                assert.equal(error.result.problem.type, "https://problems.plurnk.xyz/daemon/worker/workspace-mismatch");
                return true;
            },
        );
        await assert.rejects(
            () => daemon.dispatchClientAction({
                workspaceId,
                actor: TEST_OWNER,
                contextWorkerId: runtimeWorkerId,
                statements: [Dsl.buildExec({ runtime: tag, command: "acting for the runtime" })],
            }),
            (error: unknown) => {
                assert.ok(error instanceof OperationFailureError);
                assert.equal(error.result.problem.type, "https://problems.plurnk.xyz/daemon/worker/model-worker-required");
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
