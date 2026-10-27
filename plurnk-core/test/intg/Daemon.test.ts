import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Daemon from "../../src/server/Daemon.ts";
import HostPaths from "../../src/core/HostPaths.ts";
import ServiceTeardown from "../../src/core/ServiceTeardown.ts";
import Dsl from "./dsl.ts";
import Results, { OperationFailureError, type SchemeResult } from "../../src/core/results.ts";
import skillsModule from "@plurnk/plurnk-skills/module";
import RuntimeSession from "../../src/core/RuntimeSession.ts";
import SeamSocket from "./_seam.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Places, { type PlaceGates } from "../../src/server/Places.ts";
import { ownSession, TEST_OWNER, serverProposals } from "./_approval.ts";
import { rpcCall, subscribeNotifications, connect, withDaemon, waitFor, runLoopToTerminal, HARNESS_WAIT_MS, waitForDb, rpcProblem } from "./_rpc.ts";
import { makeMockResponse, makeRawMockResponse } from "./_mock.ts";
import { insertWorkspace, insertSession, insertLoop, insertTurn, openMigrated, holdChild, seedEntryWithChannel } from "./_db.ts";
import { viableWindow } from "./_provider.ts";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { bindListener } from "./_http.ts";
import { type RuntimeRegistration, type Executor } from "@plurnk/plurnk-execs";
import { type HostSetupSeam } from "../../src/server/ModuleHost.ts";
import { namedModelSession } from "./_sessions.ts";
import { Validator, type ApplicationActionContext, type PlurnkStatement, type ProblemDetails, Problems, type ApplicationGauge, type ApplicationStream } from "@plurnk/plurnk-contracts";
import { type ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import { Mock, chatMessageText, AiSdkProvider, type ProviderRequestAccounting } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { type Db } from "../../src/core/Db.ts";
import { providerRequestSettlementParams } from "../../src/core/provider-accounting.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { testArtifactDirectory } from "../../../scripts/lib/test-artifacts.ts";

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
                                { kind: "scheme", scheme: "message", display: {} },
                { kind: "scheme", scheme: "note", display: {} },
                { kind: "scheme", scheme: "ops", display: {} },
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
            await db.test_entries_by_scheme_prefix.all({ workspace_id: workspaceId, scheme: "workspace", prefix: "/_plurnk/plurnk/%" }),
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
            await db.test_entries_by_scheme_prefix.all({ workspace_id: workspaceId, scheme: "workspace", prefix: "/_plurnk/plurnk/%" }),
            [],
            "attachment remains passive",
        );
        assert.deepEqual(
            await daemon.invokeModuleAction("docs.probe", {}, { scope: "session", workspaceId, sessionId }),
            { ready: true },
        );
        const docs = await db.test_entries_by_scheme_prefix.all<{ pathname: string }>({ workspace_id: workspaceId, scheme: "workspace", prefix: "/_plurnk/plurnk/%" });
        assert.ok(docs.length > 0, "capability demand publishes the current installed skills surface into an existing workspace");
        assert.equal(
            docs.some(({ pathname }) => pathname === "/_plurnk/plurnk/log.md" || pathname === "/_plurnk/plurnk/prompt.md"),
            false,
            "self-evident log and prompt schemes do not materialize redundant pull documentation",
        );
        const generated = await db.crud_find_workspace_entry.get<{ id: number }>({
            workspace_id: workspaceId,
            scheme: "workspace",
            authority: "",
            pathname: docs[0].pathname,
        });
        assert.ok(generated !== undefined, "activation publication belongs to the addressed session");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§methods-workspace-create} workspace.create returns id+name, mints no session, and emits notification", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const notifications = subscribeNotifications(ws, "workspace/created");
            const response = await rpcCall(ws, 1, "workspace.create", { name: "alpha" });
            const result = response.result as { id: number; name: string };
            assert.equal(result.name, "alpha");
            assert.ok(result.id > 0);
            const captured = notifications();
            assert.equal(captured.length, 1);
            const params = captured[0] as { id: number; name: string };
            assert.equal(params.id, result.id);
            assert.equal(params.name, "alpha");

            const workspaceList = await db.test_list_workspaces.all<{ name: string }>();
            assert.ok(workspaceList.some((s) => s.name === "alpha"));
            assert.deepEqual(await daemon.listSessions(result.id), [], "creating a workspace mints no session");
        } finally { ws.close(); }
    });
});

test("{§execution-output-identity} workspace.create with no name auto-generates a unique name", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.create");
            const result = response.result as { id: number; name: string };
            assert.match(result.name, /^[0-9A-Za-z]{5}$/, "{§execution-output-identity}: five anchor-alphabet characters, no prefix");
            assert.match(result.name, /[A-Za-z]/u, "{§execution-output-identity}: a generated name is not a decimal ID");
        } finally { ws.close(); }
    });
});

test("{§execution-output-identity} workspace.create with a project root and no name is named after the root and selects that workspace next time", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const home = new HostPaths().home;
        const inside = await mkdtemp(join(home, "project-"));
        const outside = await mkdtemp(join(tmpdir(), "plurnk-outside-"));
        const ws = await connect(addr);
        try {
            const first = (await rpcCall(ws, 1, "workspace.create", { projectRoot: inside })).result as { id: number; name: string };
            assert.equal(first.name, `~/${basename(inside)}`, "the root's path with the daemon's home abbreviated to ~");
            const again = (await rpcCall(ws, 2, "workspace.create", { projectRoot: inside })).result as { id: number; name: string };
            assert.equal(again.id, first.id, "a second default launch on the same project selects the same workspace");
            const [pair] = await Promise.all([
                daemon.createWorkspace({ projectRoot: inside }),
                daemon.createWorkspace({ projectRoot: inside }),
            ].map((p) => p.then(({ workspaceId }) => workspaceId)));
            assert.equal(pair, first.id, "a concurrent pair resolves to the one workspace");
            assert.equal((await daemon.listWorkspaces()).filter(({ name }) => name === first.name).length, 1, "no second workspace of that name");
            const far = (await rpcCall(ws, 3, "workspace.create", { projectRoot: outside })).result as { name: string };
            assert.equal(far.name, outside, "outside the home the name is the absolute path");
            await assert.rejects(daemon.createWorkspace({ name: first.name, projectRoot: inside }), (error: unknown) =>
                error instanceof OperationFailureError && (error.result.problem?.type ?? "").endsWith("name-conflict"), "an explicit name that exists is a conflict, never a selection");
            // The default is a convention, not a mapping: a renamed workspace is not re-selected by its old default.
            await daemon.renameWorkspace(first.id, "renamed-workspace");
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

test("{§methods-workspace-create} read-only selection uses exactly the ID, literal name or folder-derived default and creates nothing", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const projectRoot = join(new HostPaths().home, "read-only-selection");
        const folder = await daemon.createWorkspace({ projectRoot });
        const literal = await daemon.createWorkspace({ name: `${folder.workspaceId}#user` });
        const before = await daemon.listWorkspaces();
        const events: string[] = [];
        const unsubscribe = daemon.subscribeToEvents((_workspaceId, method) => { events.push(method); });
        try {
            assert.equal((await daemon.attachWorkspace({ workspaceId: folder.workspaceId })).workspaceId, folder.workspaceId);
            assert.equal((await daemon.attachWorkspace({ name: folder.workspaceName })).workspaceId, folder.workspaceId);
            assert.equal((await daemon.attachWorkspace({ projectRoot })).workspaceId, folder.workspaceId);
            assert.equal((await daemon.attachWorkspace({ projectRoot: `${projectRoot}/../read-only-selection/.` })).workspaceId, folder.workspaceId);
            assert.equal((await daemon.attachWorkspace({ name: literal.workspaceName })).workspaceId, literal.workspaceId);
            for (const selection of [{ workspaceId: 999999 }, { name: "absent" }, { projectRoot: `${projectRoot}-absent` }]) {
                await assert.rejects(daemon.attachWorkspace(selection), (error: unknown) =>
                    error instanceof OperationFailureError && error.result.status === 404 && (error.result.problem?.type ?? "").endsWith("workspace-not-found"));
            }
            assert.deepEqual(await daemon.listWorkspaces(), before);
            assert.deepEqual(await daemon.listSessions(folder.workspaceId), []);
            assert.deepEqual(await daemon.listSessions(literal.workspaceId), []);
            assert.deepEqual(events, [], "selection emits no creation or activation events");
            await daemon.renameWorkspace(folder.workspaceId, "renamed-selection");
            await assert.rejects(daemon.attachWorkspace({ projectRoot }), (error: unknown) =>
                error instanceof OperationFailureError && error.result.status === 404 && (error.result.problem?.type ?? "").endsWith("workspace-not-found"),
                "a stored project folder does not become a second lookup identity after rename");
            assert.equal((await daemon.attachWorkspace({ name: "renamed-selection" })).workspaceId, folder.workspaceId);
        } finally { unsubscribe(); }
    });
});

test("{§methods-workspace-create} selection rejects ambiguous, empty and invalid inputs without creating anything", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const cases = [
            [{}, "identity-invalid"],
            [{ workspaceId: 1, name: "a" }, "identity-invalid"],
            [{ name: "a", projectRoot: "/a" }, "identity-invalid"],
            [{ workspaceId: 1, projectRoot: "/a" }, "identity-invalid"],
            [{ workspaceId: 0 }, "identifier-invalid"],
            [{ name: "" }, "name-invalid"],
            [{ projectRoot: null }, "identity-invalid"],
            [{ projectRoot: "relative" }, "project-root-not-absolute"],
        ] as const;
        for (const [selection, code] of cases) {
            await assert.rejects(daemon.attachWorkspace(selection as Parameters<ApplicationPort["attachWorkspace"]>[0]), (error: unknown) =>
                error instanceof OperationFailureError && error.result.status === 400 &&  error.result.problem?.type.endsWith(`/${code}`),
                JSON.stringify(selection));
        }
        assert.deepEqual(await daemon.listWorkspaces(), []);
    });
});

test("{§execution-output-identity} every envelope, row and created notice carries the folder's label beside it: a default name equals it, any other name leaves it be", async () => {
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

test("{§execution-output-identity} {§notifications} a folderless workspace is created, listed, renamed and attached with its folder null throughout; a rename collision changes nothing", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const renames: Array<[number | null, unknown]> = [];
        const unsubscribe = daemon.subscribeToEvents((workspaceId, method, params) => { if (method === "workspace/renamed") renames.push([workspaceId, params]); });
        const headless = await daemon.createWorkspace({ name: "headless" });
        assert.equal(headless.projectRoot, null);
        const other = await daemon.createWorkspace({ name: "other" });
        const listed = (await daemon.listWorkspaces()).find(({ id }) => id === headless.workspaceId);
        assert.equal(listed?.project_root, null, "listed without a folder");
        await assert.rejects(daemon.renameWorkspace(headless.workspaceId, "other"), (error: unknown) =>
            error instanceof OperationFailureError && (error.result.problem?.type ?? "").endsWith("name-conflict"));
        assert.equal((await daemon.listWorkspaces()).find(({ id }) => id === headless.workspaceId)?.name, "headless", "a collision renames nothing");
        assert.deepEqual(renames, [], "a refused rename announces nothing");
        const renamed = await daemon.renameWorkspace(headless.workspaceId, "headless-2");
        assert.equal(renamed.name, "headless-2");
        unsubscribe();
        assert.deepEqual(renames, [[headless.workspaceId, { id: headless.workspaceId, name: "headless-2" }]], "a rename is announced once, in its workspace");
        const attached = await daemon.attachWorkspace({ workspaceId: headless.workspaceId });
        assert.equal(attached.workspaceName, "headless-2");
        assert.equal(attached.projectRoot, null, "renaming leaves the folder null");
        assert.notEqual(other.workspaceId, headless.workspaceId);
    });
});

// {§execution-output-identity} — the admission matrix: every refused spelling at creation and at rename, every
// retained spelling by exact identity, the default derivation, and a workspace that predates the rule.
const REFUSED_SEGMENTS: ReadonlyArray<readonly [name: string, segment: string]> = [
    [".", "."], ["..", ".."], ["a/../b", ".."], ["a/./b", "."], ["../x", ".."], ["x/..", ".."], ["./x", "."], ["x/.", "."],
    ["~/ptl/../etc", ".."], ["/abs/./path", "."],
];
const ILL_FORMED = [String.fromCharCode(0xd800), `lead${String.fromCharCode(0xdc00)}`, `mid${String.fromCharCode(0xd83d)}tail`];
const RETAINED = [
    "~/ptl/project", "/abs/path", "plain", "with space", "ünïcödé/名前", "😀/emoji", "a@b", "100%", "100%25", "%2E%2E", "a/%2E%2E/b", "%2F",
    ".config", "file.txt", "...", "a/.../b", "..x", "x..", ".x/y.", "q?x=1#frag", "back\\slash", "trailing/", "/", "a//b", "~", "a~b",
    "~/123", "/123", "123/project", "123#alice", "1.5", "1e3", "0x10", "-1", "+1", "１２３", " 123", "123 ",
];
const nameInvalid = (detail: RegExp) => (error: unknown): boolean =>
    error instanceof OperationFailureError && error.result.status === 400
    && (error.result.problem?.type ?? "").endsWith("/daemon/input/name-invalid") && detail.test(error.result.problem?.detail ?? "");

test("{§execution-output-identity} decimal ID spellings are refused at creation and rename without changing state", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const standing = await daemon.createWorkspace({ name: "standing" });
        for (const name of ["0", "1", "42", "00", "0042", "9007199254740993", "9".repeat(100)]) {
            const refusal = nameInvalid(/^name consists only of ASCII decimal digits, reserved for workspace IDs\.$/u);
            await assert.rejects(daemon.createWorkspace({ name }), refusal, `create ${name}`);
            await assert.rejects(daemon.renameWorkspace(standing.workspaceId, name), refusal, `rename to ${name}`);
        }
        assert.deepEqual((await daemon.listWorkspaces()).map(({ id, name }) => ({ id, name })), [
            { id: standing.workspaceId, name: "standing" },
        ]);
    });
});

test("{§execution-output-identity} a numeric folder basename produces a path name, retaining folder-default selection", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const root = await mkdtemp(join(tmpdir(), "plurnk-numeric-folder-"));
        try {
            const projectRoot = join(root, "123");
            const created = await daemon.createWorkspace({ projectRoot });
            assert.equal(created.workspaceName, new HostPaths().abbreviateUserPath(projectRoot));
            assert.equal(created.projectRoot, projectRoot);
            assert.equal((await daemon.createWorkspace({ projectRoot })).workspaceId, created.workspaceId);
        } finally { await rm(root, { recursive: true, force: true }); }
    });
});

test("{§execution-output-identity} an existing numeric name remains listed, attachable and renameable without changing identity", async () => {
    await withDaemon(null, async (db, daemon) => {
        const workspaceId = await insertWorkspace(db, "42");
        const { sessionId } = await daemon.createSession({ workspaceId, name: "alice" });
        assert.equal((await daemon.listWorkspaces()).find(({ id }) => id === workspaceId)?.name, "42");
        assert.equal((await daemon.attachWorkspace({ workspaceId })).workspaceName, "42");
        assert.equal((await daemon.attachWorkspace({ name: "42" })).workspaceId, workspaceId,
            "lookup preserves an existing label even when that spelling is no longer admitted for creation");
        await assert.rejects(daemon.renameWorkspace(workspaceId, "0042"), nameInvalid(/reserved for workspace IDs/u));
        assert.deepEqual(await daemon.renameWorkspace(workspaceId, "renamed"), { id: workspaceId, name: "renamed" });
        const attached = await daemon.attachWorkspace({ workspaceId });
        assert.deepEqual([attached.workspaceId, attached.workspaceName, attached.projectRoot], [workspaceId, "renamed", null]);
        assert.ok((await daemon.listSessions(workspaceId)).some(({ id, name }) => id === sessionId && name === "alice"));
    });
});

test("{§execution-output-identity} creation and rename refuse a '.' or '..' segment and ill-formed Unicode as name-invalid; a refusal creates and renames nothing", async () => {
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
            "no refused creation made a workspace, and no refused rename changed the name");
        const refused = await daemon.createWorkspace({ name: "a/../b" }).catch((error: unknown) => error);
        assert.ok(refused instanceof OperationFailureError);
        assert.equal(refused.result.problem?.recovery, "Provide a name with no '.' or '..' between its slashes; a dot within a segment is ordinary.");
        assert.equal(refused.result.problem?.segment, "..");
        assert.equal(refused.result.problem?.retryable, false);
    });
});

test("{§execution-output-identity} every other spelling is admitted as written at creation and at rename: no repair, no decoding, no collapse", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const created = new Map<number, string>();
        for (const name of RETAINED) {
            const workspace = await daemon.createWorkspace({ name });
            assert.equal(workspace.workspaceName, name, `create keeps ${JSON.stringify(name)} exactly`);
            created.set(workspace.workspaceId, name);
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

test("{§execution-output-identity} a root spelled with '.' or '..' derives the name of the folder it reaches; an ill-formed root is project-root-invalid", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const home = new HostPaths().home;
        const inside = await mkdtemp(join(home, "dotted-"));
        try {
            const plain = await daemon.createWorkspace({ projectRoot: inside });
            assert.equal(plain.workspaceName, `~/${basename(inside)}`);
            for (const spelling of [`${inside}/.`, `${inside}/sub/..`, `${home}/./${basename(inside)}`, `${inside}/../${basename(inside)}`]) {
                const selected = await daemon.createWorkspace({ projectRoot: spelling });
                assert.equal(selected.workspaceId, plain.workspaceId, `${spelling} selects the folder's workspace`);
                assert.equal(selected.workspaceName, plain.workspaceName, "and no dot segment reaches the name");
            }
            await assert.rejects(daemon.createWorkspace({ projectRoot: `${inside}/${String.fromCharCode(0xd800)}` }), (error: unknown) =>
                error instanceof OperationFailureError && error.result.status === 400
                && (error.result.problem?.type ?? "").endsWith("/project-root-invalid")
                && error.result.problem?.detail === "projectRoot is not well-formed Unicode: it holds an unpaired surrogate.");
            assert.equal((await daemon.listWorkspaces()).length, 1, "the refused root made no workspace");
        } finally { await rm(inside, { recursive: true, force: true }); }
    });
});

test("{§execution-output-identity} a workspace already carrying a refused spelling stays listed and attachable and is renamed like any other, keeping its id, folder and sessions", async () => {
    await withDaemon(null, async (db, daemon) => {
        const legacyId = await insertWorkspace(db, "old/../name");
        const { sessionId } = await daemon.createSession({ workspaceId: legacyId, name: "kept" });
        assert.equal((await daemon.listWorkspaces()).find(({ id }) => id === legacyId)?.name, "old/../name", "enumeration hides nothing");
        const attached = await daemon.attachWorkspace({ workspaceId: legacyId });
        assert.equal(attached.workspaceName, "old/../name", "it is attached under the name it carries");
        await assert.rejects(daemon.renameWorkspace(legacyId, "still/./refused"), nameInvalid(/has the path segment '\.'/u));
        assert.equal((await daemon.listWorkspaces()).find(({ id }) => id === legacyId)?.name, "old/../name", "the refused rename changed nothing");
        const renamed = await daemon.renameWorkspace(legacyId, "old/name");
        assert.deepEqual(renamed, { id: legacyId, name: "old/name" }, "the same workspace under an admitted name");
        const after = await daemon.attachWorkspace({ workspaceId: legacyId });
        assert.equal(after.projectRoot, attached.projectRoot, "its folder is untouched");
        assert.ok((await daemon.listSessions(legacyId)).some(({ id }) => id === sessionId), "its sessions are kept");
    });
});

test("{§methods-workspace-create} workspace.create on an already-attached connection re-binds in place (no reject)", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const first = await rpcCall(ws, 1, "workspace.create", { name: "first" });
            const second = await rpcCall(ws, 2, "workspace.create", { name: "second" });
            // {§methods-workspace-create}: re-binding is allowed; the connection switches in place.
            assert.equal(second.error, undefined, "re-create on a bound connection does not reject");
            assert.notEqual((second.result as { id: number }).id, (first.result as { id: number }).id, "switched to a fresh workspace");
        } finally { ws.close(); }
    });
});

test("{§methods} workspace.list returns workspaces most-recent-first", async () => {
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

test("{§methods-workspace-create} workspace.attach binds to an existing workspace and mints nothing", async () => {
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
            assert.deepEqual(await daemon.listSessions(existing!.id), [], "binding a workspace, from any number of connections, mints no session");
        } finally { first.close(); second.close(); }
    });
});

test("{§methods-workspace-create} workspace.attach to nonexistent workspace returns an exact Problem", async () => {
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

test("{§methods} providers.list returns parsed aliases with active marker", async () => {
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
test("{§application-session-observation} workspace.sessions lists sessions in the workspace, most-recent first", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const workspace = await db.test_insert_workspace.get<{ id: number }>({ name: "list-sessions" });
        await db.test_sessions_insert.run({ workspace_id: workspace?.id, name: "first" });
        await db.test_sessions_insert.run({ workspace_id: workspace?.id, name: "second" });
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.sessions", { id: workspace?.id });
            const result = response.result as { sessions: Array<{ id: number; name: string; kind: string; lifecycle: string }> };
            assert.equal(result.sessions.length, 2);
            assert.deepEqual(result.sessions.map((r) => r.name).toSorted(), ["first", "second"]);
            // {§application-session-observation} — a session with no parent and no loop is an idle root (#523).
            assert.deepEqual(result.sessions.map((r) => [r.kind, r.lifecycle]), [["root", "idle"], ["root", "idle"]]);
        } finally { ws.close(); }
    });
});

test("{§notifications} workspace/created notification broadcasts to other connected clients", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const observer = await connect(addr);
        const creator = await connect(addr);
        try {
            const observerNotifs = subscribeNotifications(observer, "workspace/created");

            await rpcCall(creator, 1, "workspace.create", { name: "broadcast-test" });

            const captured = observerNotifs();
            assert.equal(captured.length, 1);
            const params = captured[0] as { id: number; name: string };
            assert.equal(params.name, "broadcast-test");
        } finally { observer.close(); creator.close(); }
    });
});
test("{§methods} the client-interface seam — subscribeToEvents delivers workspace-scoped engine events in-process", async () => {
    // The emit half of #broadcast, exposed as an in-process source: a transport module (plurnk-acp)
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
            assert.equal(received.length, countAfter, "unsubscribe stops delivery — the seam is a clean subscription");
        } finally { ws.close(); }
    });
});

test("{§methods} the client-interface seam does not manufacture a resolver from an ownerless durable row", async () => {
    await withDaemon(null, async (db, daemon, _addr) => {
        const workspaceId = await insertWorkspace(db, `prop-seam-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        await ownSession(db, workspaceId, sessionId);
        const loopId = await insertLoop(db, sessionId, 1, "p");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const row = await db.engine_insert_log_entry.get<{ id: number }>({
            session_id: sessionId, loop_id: loopId, turn_id: turnId, sequence: 1,
            origin: "model", source: null, model_call_id: null, op: "EDIT",
            scheme: "workspace", username: null, password: null, hostname: null, port: null,
            pathname: "/x", query: null, fragment: null, lineMarker: null,
            tx: "````EDIT (workspace:///x)\nbody\n````", mimetype_tx: "text/vnd.plurnk",
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

test("{§tokenomics} the client-interface seam — runLoop drives a loop end to end on the daemon's own provider + law", async () => {
    // The loop-control hook: the module supplies only workspace/session/prompt; runLoop fills in the provider
    // and the law-file system prompt (core's), fires the drain via the unified inject, and returns. The
    // outcome arrives on the event source, not a socket. `cancelDrain` (already public) is the cancel hook.
    // A window that comfortably holds the packet: this test drives a loop to CONCLUSION and asserts
    // 200, so the full system prompt (law/definition) + the materialized docs must fit the prompt
    // budget. This test verifies the seam path, not small-window viability
    // ({§tokenomics}).
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
                await db.test_entries_by_scheme_prefix.all({ workspace_id: created.id, scheme: "workspace", prefix: "/_plurnk/plurnk/%" }),
                [],
                "workspace creation remains passive until real work arrives",
            );
            assert.equal(
                daemon.workspaceDerivationStatus(created.id),
                null,
                "workspace creation does not launch semantic derivation",
            );

            // {§machine-processes} — loops run in a model session; the runtime actor, where a person's client
            // operations journal ({§connection-lifecycle}), is refused loudly as a loop home.
            const runtimeSessionId = await daemon.ensureRuntimeSession(created.id);
            const runtimeProblem = await rejectedProblem(() => daemon.runLoop({
                workspaceId: created.id,
                sessionId: runtimeSessionId,
                prompt: "go",
            }));
            assert.equal(runtimeProblem.type, "https://problems.plurnk.xyz/daemon/session/model-session-required");
            assert.equal(runtimeProblem.status, 409);
            assert.equal(runtimeProblem.sessionId, runtimeSessionId);
            // {§session-model-selection} — the model, reasoning, and spawn-model controls are model-session
            // surfaces: the runtime actor is refused before any policy row is initialized.
            for (const [surface, call] of [
                ["session.model.get", () => daemon.readSessionModel({ workspaceId: created.id, sessionId: runtimeSessionId })],
                ["session.model.set", () => daemon.setSessionModel({ workspaceId: created.id, sessionId: runtimeSessionId, selector: "mock/mocktest" })],
                ["session.effort.get", () => daemon.readSessionEffort({ workspaceId: created.id, sessionId: runtimeSessionId })],
                ["session.effort.set", () => daemon.setSessionEffort({ workspaceId: created.id, sessionId: runtimeSessionId, effort: "low" })],
                ["session.child.set", () => daemon.setSessionSpawnModel({ workspaceId: created.id, sessionId: runtimeSessionId, selector: null })],
            ] as const) {
                const refused = await rejectedProblem(call);
                assert.equal(refused.type, "https://problems.plurnk.xyz/daemon/session/model-session-required", `${surface} refuses a non-model session`);
                assert.equal(refused.status, 409);
            }
            const modelSessionId = await namedModelSession(daemon, created.id, "main");
            const res = await daemon.runLoop({ workspaceId: created.id, sessionId: modelSessionId, prompt: "go" });
            assert.equal(res.action, "enqueued_new_loop", "runLoop enqueued a fresh loop");
            assert.ok(res.loopId > 0, "runLoop returned the new loop id");

            const terminals = await waitFor(
                () => events.filter((e) => e.method === "loop/terminated" && (e.params as { loopId?: number }).loopId === res.loopId),
                (ts) => ts.length > 0,
                { timeoutMs: 8000 },
            );
            assert.equal((terminals[0].params as { result: { status: number } }).result.status, 200, "the loop runLoop started ran to conclusion (200) — driven and observed through the seam, no socket");

            // The first-turn feature holds on the seam path: Functionality activation materialized
            // the teaching skills into the model session before packet assembly.
            const docs = await db.test_entries_by_scheme_prefix.all<{ pathname: string }>({ workspace_id: created.id, scheme: "workspace", prefix: "/_plurnk/plurnk/%" });
            assert.ok(docs.length > 0);
            const docEdits = (await db.test_log_entries_by_session_op_full.all<{
                tx: string;
                origin: string;
            }>({ session_id: runtimeSessionId, op: "EDIT" })).filter(({ origin }) => origin === "_plurnk");
            assert.ok(docEdits.length > 0, "documentation publication dispatches structural EDIT statements");
            for (const { tx } of docEdits) {
                const statement = JSON.parse(tx) as unknown;
                assert.equal(Validator.validatePlurnkStatement(statement).valid, true);
                const position = (statement as { position?: { line?: number; column?: number } }).position;
                assert.equal(position?.column, 0);
                assert.ok((position?.line ?? 0) > 0, "generated EDIT carries its honest position in the admitted turnOps source");
            }
            const publicationRows = async () => (await db.test_log_entries_by_session.all<{
                op: string;
                pathname: string | null;
                status_rx: number;
                origin: string;
            }>({ session_id: runtimeSessionId })).filter(({ origin, pathname }) =>
                origin === "_plurnk"
                && (pathname === "/_plurnk/AGENTS.md" || pathname?.startsWith("/_plurnk/skills/") === true));
            const publishedCount = (await publicationRows()).length;

            const second = await daemon.runLoop({ workspaceId: created.id, sessionId: modelSessionId, prompt: "go again" });
            const secondTerminals = await waitFor(
                () => events.filter((e) => e.method === "loop/terminated" && (e.params as { loopId?: number }).loopId === second.loopId),
                (ts) => ts.length > 0,
                { timeoutMs: 8000 },
            );
            assert.equal((secondTerminals[0].params as { result: { status: number } }).result.status, 200, "reattaching to the workspace runs normally");

            const afterTwoLoops = await publicationRows();
            assert.equal(afterTwoLoops.length, publishedCount, "model loops never repeat unchanged session skills publication");
            assert.equal(afterTwoLoops.filter((row) => row.op === "EDIT" && row.status_rx >= 400).length, 0, "session skills publication produces no error rows");
        } finally { ws.close(); }
    });
});

test("{§methods} the client-interface seam — dispatchClientAction runs a client op through the engine and emits log/entry", async () => {
    // The op keystone: one seam op backs the whole op_* family. The module parses at its edge and hands
    // over the statement; the op is journaled client-origin, dispatched, and the entry emitted on the source.
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-dispatch" })).result as { id: number };
            const entries: Array<{ method: string; params: unknown }> = [];
            daemon.subscribeToEvents((_s, method, params) => { entries.push({ method, params }); });
            const operate = async (statement: PlurnkStatement) =>
                (await daemon.dispatchClientAction({ workspaceId: created.id, actor: TEST_OWNER, statements: [statement] }))[0];

            // WRITE then READ workspace:///x through the seam — a positive roundtrip proving dispatch + journal.
            const wrote = await operate(Dsl.buildEdit({ target: "workspace:///x", content: "seam" }));
            assert.equal(wrote.status, 201, "the client EDIT created the entry through the seam (201)");
            const read = await operate(Dsl.buildRead({ target: "workspace:///x" }));
            assert.equal(read.status, 200);
            assert.equal(read.content, "seam", "the value roundtripped — the op executed through the engine, not a shadow path");

            const emitted = entries.filter((e) => e.method === "log/entry");
            assert.ok(emitted.length >= 2, "each dispatched client op emitted a log/entry on the event source (acp fans out to its own clients)");
        } finally { ws.close(); }
    });
});

test("{§connection-lifecycle} {§connection-lifecycle} one client operation owns every statement in one loop of the runtime session, attributed to its person", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-action-journal" })).result as { id: number };
            const heard: Array<{ sessionId: number; loopId: number }> = [];
            const order: string[] = [];
            daemon.subscribeToEvents((_s, method) => { if (method === "log/entry") order.push("entry"); });
            const operation = (actor: string, statements: PlurnkStatement[]) => daemon.dispatchClientAction({
                workspaceId: created.id, actor, statements,
                onLoop: (loop) => { heard.push(loop); order.push("loop"); },
            });

            const results = await operation("test://primary", [
                Dsl.buildEdit({ target: "workspace:///x", content: "one action" }),
                Dsl.buildRead({ target: "workspace:///x" }),
            ]);
            assert.deepEqual(results.map((result) => result.status), [201, 200]);
            assert.equal(heard.length, 1, "the operation announced exactly one loop");
            assert.deepEqual(order, ["loop", "entry", "entry"], "the loop is announced before any statement runs");
            const [{ sessionId, loopId }] = heard;
            const runtime = await daemon.readSession({ workspaceId: created.id, identity: { id: sessionId } });
            assert.equal(runtime?.origin, "_plurnk", "the operation journals in the workspace's runtime session");
            assert.equal(runtime?.name, "_plurnk");

            const turns = await db.test_list_turns_in_loop.all<{ sequence: number; producer: string; kind: string }>({ loop_id: loopId });
            assert.deepEqual(
                turns.map(({ sequence, producer, kind }) => [sequence, producer, kind]),
                [[1, "client", "operation"], [2, "client", "operation"]],
                "each statement is a distinct ordered client operation turn in the one loop",
            );
            assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status, 200, "the loop closes 200 when the operation succeeds");
            const rows = (await db.test_log_entries_by_session.all<{ loop_id: number; origin: string; source: string | null }>({ session_id: sessionId }))
                .filter((row) => row.loop_id === loopId);
            assert.equal(rows.length, 2);
            assert.deepEqual(rows.map(({ origin, source }) => [origin, source]), [["client", null], ["client", null]],
                "every row the operation writes is a client-origin act, not an arrival");
            const promptSource = async (id: number) =>
                (await daemon.listSessionLoops({ workspaceId: created.id, sessionId })).find((loop) => loop.id === id)?.promptSource;
            assert.equal(await promptSource(loopId), "test://primary", "the operation's loop names its person");

            // A second person's operation is its own loop in the same runtime session, attributed to that person.
            await operation("test://secondary", [Dsl.buildRead({ target: "workspace:///x" })]);
            assert.equal(heard.length, 2);
            assert.equal(heard[1].sessionId, sessionId, "every person's operation journals in the one runtime session");
            assert.notEqual(heard[1].loopId, loopId, "each operation owns its own loop");
            assert.equal(await promptSource(heard[1].loopId), "test://secondary");
            assert.deepEqual((await daemon.listSessions(created.id)).map(({ origin }) => origin), ["_plurnk"],
                "client operations mint no session beyond the runtime session");
        } finally { ws.close(); }
    });
});

test("{§methods} the client-interface seam — readLog returns a workspace's journal, ownership-verified", async () => {
    // The module's primary render input. Seeded here via the dispatch seam, read back via readLog, and the
    // cross-workspace invariant proven: a workspace reads only its own sessions (core holds it, not the module).
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-read" })).result as { id: number };
            await daemon.dispatchClientAction({ workspaceId: created.id, actor: TEST_OWNER, statements: [Dsl.buildEdit({ target: "workspace:///x", content: "read me" })] });

            const entries = await daemon.readLog({ workspaceId: created.id, sessionId: await daemon.ensureRuntimeSession(created.id) });
            assert.ok(entries.length >= 1, "readLog returned the workspace's journal entries");
            assert.ok(entries.some((e) => e.op === "EDIT"), "the client EDIT is in the journal the seam read");

            const other = (await rpcCall(ws, 2, "workspace.create", { name: "seam-read-other" })).result as { id: number };
            const otherSession = await daemon.ensureRuntimeSession(other.id);
            const problem = await rejectedProblem(() => daemon.readLog({
                workspaceId: created.id,
                sessionId: otherSession,
            }));
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/session/workspace-mismatch");
            assert.equal(problem.status, 409);
            assert.equal(problem.actualWorkspaceId, other.id);
        } finally { ws.close(); }
    });
});

test("{§methods} the client-interface seam — metadata reads surface providers, workspaces, sessions, and constraints", async () => {
    // The render surface beyond the journal: providers+budget, workspaces, sessions, and the constraint overlay.
    const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("````SEND [200]\ndone\n````", 10)] });
    await withDaemon(mock, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-meta" })).result as { id: number };

            // providers + capacity — the active test alias is mocktest, carrying derived input capacity.
            const providers = daemon.listProviders();
            const active = providers.aliases.find((a) => a.active);
            assert.ok(active !== undefined, "listProviders reports the active alias");
            assert.equal(active.alias, "mocktest");
            assert.equal(typeof active.inputCapacity, "number", "the active alias carries resolved input capacity");

            // workspaces + sessions — the created workspace and its model session are present.
            const workspaces = await daemon.listWorkspaces();
            assert.ok(workspaces.some((s) => s.id === created.id), "listWorkspaces includes the created workspace");
            const modelSessionId = await namedModelSession(daemon, created.id, "main");
            const sessions = await daemon.listSessions(created.id);
            assert.deepEqual(sessions.map(({ id }) => id), [modelSessionId], "listSessions returns the workspace's sessions");

            // prompts — a thin delegation; assert the wiring resolves cleanly.
            const prompts = await daemon.listPrompts(created.id);
            assert.ok(Array.isArray(prompts), "listPrompts returns the workspace's prompt history");
        } finally { ws.close(); }
    });
});

test("{§methods-workspace-create} {§methods-workspace-create} the client-interface seam — workspace lifecycle: create/attach/rename", async () => {
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
            "{§methods-workspace-create}: the envelope carries the workspace's identity only",
        );
        assert.ok(events.some((e) => e.method === "workspace/created" && (e.params as { id?: number }).id === env.workspaceId), "workspace/created emitted on the event source");

        const attached = await daemon.attachWorkspace({ workspaceId: env.workspaceId });
        assert.equal(attached.workspaceId, env.workspaceId, "attachWorkspace returns an envelope on the same workspace");
        assert.deepEqual(
            Object.keys(attached).toSorted(),
            ["projectLabel", "projectRoot", "workspaceId", "workspaceName"],
            "{§methods-workspace-create}: attach does not fabricate a bound-session or action-loop binding",
        );
        assert.deepEqual(await daemon.listSessions(env.workspaceId), [], "neither creation nor attachment mints a session");

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

test("{§methods} the client-interface seam — readEntry returns an entry's shape and incremental channel slice", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-entry" })).result as { id: number };
            await daemon.dispatchClientAction({ workspaceId: created.id, actor: TEST_OWNER, statements: [Dsl.buildEdit({ target: "workspace:///x", content: "hello world" })] });
            // A client reads entries from the perspective of a session of its workspace.
            const reader = await namedModelSession(daemon, created.id, "main");

            // full shape — the written content is on one of the entry's channels.
            const entry = (await daemon.readEntry({ workspaceId: created.id, sessionId: reader, target: "workspace:///x" })).entry!;
            const found = Object.entries(entry.channels).find(([, c]) => c.content.includes("hello"));
            assert.ok(found !== undefined, "readEntry returns the entry's channels with content");
            const [channel, chan] = found;
            assert.equal(chan.content, "hello world");
            assert.equal(chan.contentLength, 11);

            // {§methods}: an offset returns only that channel's remaining content.
            const sliced = (await daemon.readEntry({ workspaceId: created.id, sessionId: reader, target: "workspace:///x", channel, offset: 6 })).entry!;
            assert.equal(sliced.channels[channel].content, "world", "the incremental read returns only the delta from the offset");
            assert.equal(sliced.channels[channel].contentLength, 11, "contentLength is the full length — the next poll resumes from there");

            // a missing entry is 404; an offset without a channel is refused.
            const missing = await daemon.readEntry({ workspaceId: created.id, sessionId: reader, target: "workspace:///nope" });
            assert.equal(missing.status, 404);
            assert.ok("problem" in missing);
            assert.equal(missing.problem.type, "https://problems.plurnk.xyz/daemon/entry/entry-not-found");
            assert.equal(missing.problem.target, "workspace:///nope");
            const offset = await daemon.readEntry({ workspaceId: created.id, sessionId: reader, target: "workspace:///x", offset: 3 });
            assert.equal(offset.status, 400);
            assert.ok("problem" in offset);
            assert.equal(offset.problem.type, "https://problems.plurnk.xyz/daemon/entry/offset-channel-required");
            assert.equal(offset.problem.recovery, "Select the channel to read from the offset."); // {§operation-results}

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
                sessionId: reader,
                target: "https://example.org:8443/x?b=2&a=1&a=3#body",
            });
            assert.equal(network.status, 200);
            assert.equal(network.entry?.target, "https://example.org:8443/x?b=2&a=1&a=3");
            assert.equal(network.entry?.channels.body.content, "network body");

            const userinfo = await daemon.readEntry({
                workspaceId: created.id,
                sessionId: reader,
                target: "https://alice:secret@example.org:8443/x?b=2&a=1&a=3",
            });
            assert.equal(userinfo.status, 400);
            assert.ok("problem" in userinfo);
            assert.equal(userinfo.problem.type, "https://problems.plurnk.xyz/daemon/entry/userinfo-not-allowed");
            assert.doesNotMatch(JSON.stringify(userinfo), /alice|secret/);
        } finally { ws.close(); }
    });
});

test("{§application-session-observation} the client-interface seam — forkSession branches a session's log, ownership + name invariants held", async () => {
    const mock = new Mock({ contextWindow: viableWindow(), responses: [makeMockResponse("````SEND [200]\ndone\n````", 10)] });
    await withDaemon(mock, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-fork" })).result as { id: number };
            // A model session with a completed loop to branch.
            const { finalStatus, modelSessionId } = await runLoopToTerminal(ws, 2, { prompt: "branch me" });
            assert.equal(finalStatus, 200);
            const sourceSession = modelSessionId!;

            const branch = await daemon.forkSession({ workspaceId: created.id, sessionId: sourceSession, name: "My_branch" });
            assert.ok(branch.sessionId > 0 && branch.sessionId !== sourceSession, "forkSession created a new session");
            assert.equal(branch.parentSessionId, sourceSession, "the branch is lineaged to its parent");
            assert.equal(branch.sessionName, "My_branch");
            // {§application-session-observation} — the directory says how it was minted (#523).
            const observed = await daemon.readSession({ workspaceId: created.id, identity: { id: branch.sessionId } });
            assert.equal(observed?.kind, "fork");
            // A fork inherits its parent's loops by snapshot, so its latest loop is the completed one it forked from.
            assert.equal(observed?.lifecycle, "completed");
            const parent = await daemon.readSession({ workspaceId: created.id, identity: { id: sourceSession } });
            assert.equal(parent?.kind, "root");

            // invariants: the runtime actor's name and a foreign session are both refused.
            await assert.rejects(() => daemon.forkSession({ workspaceId: created.id, sessionId: sourceSession, name: "_plurnk" }), /must match \[A-Za-z0-9\]\[A-Za-z0-9_-\]\{0,62\}/);
            const invalidName = await rejectedProblem(() => daemon.forkSession({
                workspaceId: created.id,
                sessionId: sourceSession,
                name: "_invalid",
            }));
            assert.equal(invalidName.type, "https://problems.plurnk.xyz/daemon/session/name-invalid");
            assert.equal(invalidName.status, 400);
            assert.equal(invalidName.name, "_invalid");
            assert.equal(invalidName.retryable, false);
            const other = (await rpcCall(ws, 3, "workspace.create", { name: "seam-fork-other" })).result as { id: number };
            const otherSession = await namedModelSession(daemon, other.id, "main");
            const problem = await rejectedProblem(() => daemon.forkSession({
                workspaceId: created.id,
                sessionId: otherSession,
            }));
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/session/workspace-mismatch");
            assert.equal(problem.status, 409);
            assert.equal(problem.actualWorkspaceId, other.id);
        } finally { ws.close(); }
    });
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

describe("ApplicationPort.topology", () => {
test("{§notifications} {§application-session-observation} {§methods-workspace-create}{§methods-workspace-create}{§methods-workspace-create}: exterior adapters observe exact topology and durable loop state", async () => {
    const provider = new Mock({
        contextWindow: 16_384,
        responses: [makeMockResponse("````SEND [200]\ncomposed result\n````", 10)],
    });

    await withDaemon(provider, async (_db, daemon) => {
        const workspace = await daemon.createWorkspace({
            name: `application-topology-${crypto.randomUUID()}`,
            projectRoot: null,
        });
        const contextId = crypto.randomUUID();
        const taskId = crypto.randomUUID();
        const context = await daemon.createSession({
            workspaceId: workspace.workspaceId,
            name: contextId,
        });
        assert.deepEqual(
            await daemon.readSession({ workspaceId: workspace.workspaceId, identity: { name: taskId } }),
            null,
            "an absent exact lookup is singular and explicit",
        );
        const task = await daemon.forkSession({
            workspaceId: workspace.workspaceId,
            sessionId: context.sessionId,
            name: taskId,
        });
        assert.equal(
            (await daemon.readSession({ workspaceId: workspace.workspaceId, identity: { id: task.sessionId } }))?.name,
            taskId,
        );

        const roots = await daemon.listSessions(workspace.workspaceId, {
            origin: "model",
            parentSessionId: null,
        });
        const projectedContext = roots.find(({ id }) => id === context.sessionId);
        assert.ok(projectedContext);
        assert.deepEqual(projectedContext, {
            id: context.sessionId,
            name: contextId,
            created_at: projectedContext.created_at,
            origin: "model",
            owner: "_plurnk",
            parentSessionId: null,
            // {§application-session-observation} — a root session with no loop yet (#523).
            kind: "root",
            lifecycle: "idle",
            // {§machine-processes} — shown.
            hidden_at: null,
        });
        assert.equal(typeof projectedContext.created_at, "string");
        // {§methods-workspace-create} — an omitted parent filter returns every lineage
        // position; the child is listed beside its root, not hidden behind it.
        const everyPosition = await daemon.listSessions(workspace.workspaceId, { origin: "model" });
        assert.deepEqual(
            everyPosition.map(({ id }) => id).toSorted((left, right) => left - right),
            [context.sessionId, task.sessionId].toSorted((left, right) => left - right),
        );
        assert.ok(
            (await daemon.listSessions(workspace.workspaceId)).some(({ id }) => id === task.sessionId),
            "a query-less listing includes the child",
        );
        const children = await daemon.listSessions(workspace.workspaceId, {
            origin: "model",
            parentSessionId: context.sessionId,
        });
        assert.equal(children.length, 1);
        assert.deepEqual(children[0], {
            id: task.sessionId,
            name: taskId,
            created_at: children[0]?.created_at,
            origin: "model",
            owner: "_plurnk",
            parentSessionId: context.sessionId,
            // forkSession mints a FORK child (fork boundary set); no loop has run on it yet.
            kind: "fork",
            lifecycle: "idle",
            hidden_at: null,
        });

        const terminated: Array<{ loopId: number }> = [];
        const packets: Array<{ sessionId: number; loopId: number; packetCount: number }> = [];
        const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => {
            if (method === "loop/terminated") terminated.push(params as { loopId: number });
            if (method === "loop/packet") packets.push(params as { sessionId: number; loopId: number; packetCount: number });
        });
        try {
            const accepted = await daemon.runLoop({
                workspaceId: workspace.workspaceId,
                sessionId: task.sessionId,
                prompt: "produce the composed result",
                source: `acp://peer/contexts/${contextId}/tasks/${taskId}`,
            });
            await waitFor(
                () => terminated,
                (events) => events.some(({ loopId }) => loopId === accepted.loopId),
            );

            const loops = await daemon.listSessionLoops({
                workspaceId: workspace.workspaceId,
                sessionId: task.sessionId,
            });
            const own = loops.find(({ id }) => id === accepted.loopId);
            assert.deepEqual(own, {
                id: accepted.loopId,
                sessionId: task.sessionId,
                sequence: own?.sequence,
                status: 200,
                prompt: "produce the composed result",
                promptSource: `acp://peer/contexts/${contextId}/tasks/${taskId}`,
                claimedAt: own?.claimedAt,
                terminatedAt: own?.terminatedAt,
                terminalResult: {
                    status: 200,
                },
                packetCount: 1,
                waitUntil: null,
                // {§loop-completion} A peer's task is no session's operation.
                invocation: null,
            });
            assert.equal(typeof own?.terminatedAt, "string");
            assert.equal(typeof own?.claimedAt, "string");
            assert.ok(Date.parse(own.claimedAt!) <= Date.parse(own.terminatedAt!), "a loop first runs before it concludes");
            const messages = await daemon.readMessages({ workspaceId: workspace.workspaceId, sessionId: task.sessionId });
            assert.deepEqual(messages.filter(({ direction }) => direction === "outbound").map(({ body }) => body), ["composed result"]);
            assert.deepEqual(packets.map(({ sessionId, loopId, packetCount }) => ({ sessionId, loopId, packetCount })),
                [{ sessionId: task.sessionId, loopId: accepted.loopId, packetCount: 1 }], "packet chronology broadcasts once when inference evidence becomes durable");
        } finally {
            unsubscribe();
        }
    });
});

test("{§methods-workspace-create} {§session-scheme}: an exact read resolves every name a listing returns, the runtime session's included", async () => {
    await withDaemon(new Mock({ contextWindow: 16_384, responses: [] }), async (db, daemon) => {
        const workspace = await daemon.createWorkspace({ name: `session-read-${crypto.randomUUID()}`, projectRoot: null });
        const runtimeId = await RuntimeSession.ensure(db, workspace.workspaceId);
        const listed = (await daemon.listSessions(workspace.workspaceId)).find(({ id }) => id === runtimeId);
        assert.ok(listed !== undefined, "the listing returns the runtime session");
        const byName = await daemon.readSession({ workspaceId: workspace.workspaceId, identity: { name: listed.name } });
        assert.deepEqual(byName, await daemon.readSession({ workspaceId: workspace.workspaceId, identity: { id: runtimeId } }),
            "the listed name resolves the listed session: a lookup is no minting door");
        assert.equal(byName?.origin, "_plurnk", "and the reader sees what it is, so it can refuse to bind it");
        assert.equal(await daemon.readSession({ workspaceId: workspace.workspaceId, identity: { name: "_absent" } }), null,
            "a name no session carries is absent, not malformed");
    });
});
});

describe("Daemon.addressed-messages", () => {
process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "100";

test("{§methods}: a client message's address is its idempotency key: the same words are the accepted message, other words are refused", async () => {
    const provider = new Mock({ contextWindow: 100_000, responses: [makeMockResponse(PlurnkParser.frame("SEND [200]", "Hello back."))] });
    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "keyed-messages", projectRoot: null });
        const { sessionId } = await daemon.createSession({ workspaceId, name: "keyed" });
        const address = "acp://operator/threads/keyed/messages/m1";
        const refusal = async (attempt: Promise<unknown>): Promise<string | null> => {
            try { await attempt; return null; } catch (cause) {
                const problem = Problems.fromError(cause);
                return problem === null ? String(cause) : `${problem.status} ${problem.type.slice(problem.type.lastIndexOf("/") + 1)}`;
            }
        };
        assert.equal(await daemon.messageAdmission({ workspaceId, address, body: "Hello." }), "new");
        await daemon.runLoop({ workspaceId, sessionId, prompt: "Hello.", source: address, messageAddress: address });
        assert.equal(await daemon.messageAdmission({ workspaceId, address, body: "Hello." }), "accepted", "a repeat attaches to the message already accepted");
        assert.equal(await refusal(daemon.messageAdmission({ workspaceId, address, body: "Edited." })), "422 message-address-reused");
        assert.equal(await refusal(daemon.runLoop({ workspaceId, sessionId, prompt: "Hello.", source: address, messageAddress: address })),
            "409 message-already-accepted", "admission refuses the same words racing the original");
        assert.equal(await refusal(daemon.runLoop({ workspaceId, sessionId, prompt: "Edited.", source: address, messageAddress: address })),
            "422 message-address-reused", "and other words under the same key");
        const elsewhere = await daemon.createWorkspace({ name: "keyed-messages-elsewhere", projectRoot: null });
        assert.equal(await daemon.messageAdmission({ workspaceId: elsewhere.workspaceId, address, body: "Edited." }), "new", "the key is the workspace's");
        assert.deepEqual((await daemon.readMessages({ workspaceId, sessionId })).filter(({ direction }) => direction === "inbound").map(({ body }) => body),
            ["Hello."], "nothing refused is admitted");
    });
});

test("{§session-scheme}: an empty directed SEND refuses before admission and the model can recover", async () => {
    const provider = new Mock({ contextWindow: 100_000, responses: [
        makeMockResponse([
            PlurnkParser.frame("SEND (session://receiver)", null),
            PlurnkParser.frame("NOTE", "Keep the sibling operation."),
        ].join("\n\n")),
        makeMockResponse(PlurnkParser.frame("SEND [200]", "No message was delivered to the receiver.")),
    ] });
    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "empty-session-message", projectRoot: null });
        const sender = await daemon.createSession({ workspaceId, name: "sender" });
        const receiver = await daemon.createSession({ workspaceId, name: "receiver" });
        const accepted = await daemon.runLoop({ workspaceId, sessionId: sender.sessionId, prompt: "Check delivery." });
        const loops = await waitForDb(() => daemon.listSessionLoops({ workspaceId, sessionId: sender.sessionId }),
            (rows) => rows.some((row) => row.id === accepted.loopId && row.status === 200));
        assert.equal(loops.find((row) => row.id === accepted.loopId)?.status, 200);
        const rows = await daemon.readLog({ workspaceId, sessionId: sender.sessionId, loopId: accepted.loopId });
        const refused = rows.find((row) => row.origin === "model" && row.op === "SEND" && row.status_rx === 422);
        assert.ok(refused);
        assert.equal(refused.status_rx, 422);
        const receipt = refused.rx as SchemeResult;
        assert.equal(receipt.problem?.type, "https://problems.plurnk.xyz/scheme/session/message-empty");
        assert.equal(receipt.problem?.detail, "SEND has no message text or attachments."); // {§operation-results}
        assert.ok(rows.some((row) => row.origin === "model" && row.op === "NOTE" && row.status_rx === 200));
        assert.deepEqual(await daemon.listSessionLoops({ workspaceId, sessionId: receiver.sessionId }), [], "no empty receiving loop is created");
        assert.deepEqual(await daemon.readMessages({ workspaceId, sessionId: receiver.sessionId }), [], "no empty message is stored");
        assert.equal(provider.received.length, 2, "only the sender ran and recovered");
        assert.match(provider.received[1].map(chatMessageText).join("\n"), /SEND has no message text or attachments\./);
        const history = await daemon.readMessages({ workspaceId, sessionId: sender.sessionId });
        assert.deepEqual(history.filter(({ direction }) => direction === "outbound").map(({ body }) => body), [
            "No message was delivered to the receiver.",
        ]);
    });
});

test("{§message-arrival} {§connection-lifecycle}: a person's answer, sent as a client operation, wakes its assigned session without making another request", async () => {
    const provider = new Mock({ contextWindow: 100_000, responses: [
        makeMockResponse("````WAIT\nA collaborator may answer the request.\n````"),
        makeMockResponse("````WAIT\nThe collaborator answered; the held child is still running.\n````"),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "client-answer-wake" });
        const { sessionId } = await daemon.createSession({ workspaceId, name: "assigned" });
        await holdChild(db, workspaceId, sessionId);
        const address = "message://assigned/12345678";
        const accepted = await daemon.runLoop({ workspaceId, sessionId, prompt: "What is the result?", messageAddress: address });
        await waitForDb(() => db.test_get_loop_status.get({ id: accepted.loopId }), (row) => row?.status === 202);
        const parsed = PlurnkParser.parseStatements(PlurnkParser.frame(`SEND (${address}) [200]`, "The result is 42."));
        assert.equal(parsed.items.length, 1);
        const item = parsed.items[0];
        assert.equal(item.kind, "statement");
        if (item.kind !== "statement") throw new Error("The reply fixture did not parse.");
        const [result] = await daemon.dispatchClientAction({ workspaceId, actor: "test://collaborator", statements: [item.statement] });
        assert.equal(result.status, 200);
        await waitForDb(async () => provider.received.length, (count) => count === 2);
        await waitForDb(() => db.test_get_loop_status.get({ id: accepted.loopId }), (row) => row?.status === 202);
        assert.match(JSON.stringify(provider.received[1]), /The result is 42\./);
        assert.equal((await db.message_unanswered_count.get({ loop_id: accepted.loopId }))?.count, 0);
        assert.equal((await db.test_messages_by_session.all({ session_id: sessionId })).length, 1, "a reply is not another incoming obligation");
        assert.equal((await db.test_loop_queue_by_session.all({ session_id: sessionId })).length, 1, "the same parked loop resumed");
        const history = await daemon.readMessages({ workspaceId, sessionId });
        assert.deepEqual(history.map(({ direction, body }) => ({ direction, body })), [
            { direction: "inbound", body: "What is the result?" },
            { direction: "outbound", body: "The result is 42." },
        ]);
        await daemon.cancelSession({ workspaceId, sessionId });
    });
});
});

describe("Daemon.inbox", () => {
const streamed = (frames: readonly object[], hold?: Promise<void>): Response => new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
        const send = (frame: object): void => { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`)); };
        const [first, ...rest] = frames;
        if (first !== undefined) send(first);
        await hold;
        for (const frame of rest) send(frame);
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
    },
}), { headers: { "content-type": "text/event-stream" } });

// Turn 1 streams its reasoning, holds until released, then answers; turn 2 answers at once.
const heldProvider = (): { provider: AiSdkProvider; release: () => void; calls: () => number } => {
    const held = Promise.withResolvers<void>();
    let calls = 0;
    const frame = (delta: object, finish: string | null = null): object => ({
        id: `inbox-${calls}`, model: "inbox-witness", choices: [{ index: 0, delta, finish_reason: finish }],
        ...(finish === null ? {} : { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }),
    });
    const provider = new AiSdkProvider({
        model: "inbox-witness", url: "https://example.test/v1/chat/completions",
        contextWindow: 100_000, streaming: true, fetchTimeoutMs: 20_000, operationTimeoutMs: 20_000,
        temperature: null, repeatPenalty: null, effort: { mode: "adaptive", budget: null }, retryAttempts: 0,
        fetch: async () => {
            calls++;
            if (calls === 1) {
                return streamed([frame({ reasoning_content: "Weighing A." }), frame({ content: "````SEND [200]\nAnswer A.\n````" }, "stop")], held.promise);
            }
            return streamed([frame({ content: "````SEND [200]\nAnswer B.\n````" }, "stop")]);
        },
    });
    return { provider, release: () => held.resolve(), calls: () => calls };
};

const address = (id: string): string => `acp://operator/threads/inbox/messages/${id}`;

test("{§methods} a message accepted mid-turn is in the inbox until its arrival row lands", async () => {
    const { provider, release, calls } = heldProvider();
    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "inbox" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const first = await daemon.runLoop({ workspaceId, sessionId, prompt: "A", source: address("A"), messageAddress: address("A") });
        await waitForDb(async () => calls(), (count) => count >= 1);
        assert.deepEqual(await daemon.readInbox({ workspaceId, sessionId }), [], "the headline message is observed by the turn in flight");
        const second = await daemon.runLoop({ workspaceId, sessionId, prompt: "B", source: address("B"), messageAddress: address("B") });
        assert.equal(second.loopId, first.loopId, "{§message-arrival} the follow-up joins the live loop");
        assert.deepEqual(await daemon.readInbox({ workspaceId, sessionId }),
            [{ path: address("B"), source: address("B"), body: "B", loopId: first.loopId, lifecycle: "running" }],
            "accepted, durable, and not yet observed: in the inbox by its immutable address, source, words, loop and its lifecycle");
        assert.equal(await daemon.messageAdmission({ workspaceId, address: address("B"), body: "B" }), "accepted",
            "{§methods} the same address and words are already accepted");
        release();
        await waitForDb(() => daemon.listSessionLoops({ workspaceId, sessionId }), (loops) => loops.some(({ id, status }) => id === first.loopId && status === 200));
        assert.equal(calls(), 2, "the next turn boundary published B and the model answered it");
        assert.deepEqual(await daemon.readInbox({ workspaceId, sessionId }), [], "published: out of the inbox");
        const messages = await daemon.readMessages({ workspaceId, sessionId });
        assert.deepEqual(messages.filter(({ direction }) => direction === "inbound").map(({ body }) => body), ["A", "B"], "and durable as ever");
    });
});

test("{§methods} {§message-arrival} a loop cancelled before observing a message leaves it in the inbox with that terminal lifecycle", async () => {
    const { provider, release, calls } = heldProvider();
    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "inbox-cancel" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const first = await daemon.runLoop({ workspaceId, sessionId, prompt: "A", source: address("A"), messageAddress: address("A") });
        await waitForDb(async () => calls(), (count) => count >= 1);
        await daemon.runLoop({ workspaceId, sessionId, prompt: "B", source: address("B"), messageAddress: address("B") });
        assert.equal((await daemon.readInbox({ workspaceId, sessionId })).length, 1);
        await daemon.cancelSession({ workspaceId, sessionId });
        release();
        await waitForDb(() => daemon.listSessionLoops({ workspaceId, sessionId }), (loops) => loops.some(({ id, terminatedAt }) => id === first.loopId && terminatedAt !== null));
        assert.deepEqual(await daemon.readInbox({ workspaceId, sessionId }),
            [{ path: address("B"), source: address("B"), body: "B", loopId: first.loopId, lifecycle: "cancelled" }],
            "the loop concluded without observing it: still unobserved, and its lifecycle says nothing will");
        assert.ok((await daemon.readMessages({ workspaceId, sessionId })).some(({ body }) => body === "B"), "{§message-arrival} acceptance is durable");
        assert.equal(await daemon.messageAdmission({ workspaceId, address: address("B"), body: "B" }), "accepted", "{§methods} and its address stays taken");
    });
});
});

describe("Daemon.loop-status-notice", () => {
type LoopStatusNotice = { sessionId: number; loopId: number; notice: { source: string; kind: string; level: string; status: number; waitUntil: number | null; packetCount: number; claimedAt: number | null } };

test("{§operation-results}: claim, park and wake each broadcast the loop's status as a lifecycle notice", async () => {
    const provider = new Mock({
        contextWindow: 65536,
        responses: [
            makeMockResponse("````WAIT\nWaiting on the child.\n````"),
            makeMockResponse("````NOTE\nWoken by the message.\n````\n````WAIT\n````"),
        ],
    });
    await withDaemon(provider, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const { workspaceId } = await daemon.createWorkspace({ name: "loop-status-notice" });
            await rpcAttach(ws, workspaceId);
            const sessionId = await namedModelSession(daemon, workspaceId, "main");
            await holdChild(db, workspaceId, sessionId);
            const captured = subscribeNotifications(ws, "notice/event");
            const terminals = subscribeNotifications(ws, "loop/terminated");
            const lifecycle = (): LoopStatusNotice[] => (captured() as LoopStatusNotice[])
                .filter(({ notice }) => notice.source === "engine:lifecycle" && notice.kind === "loop_status");
            try {
                const accepted = await daemon.inject({
                    workspaceId, sessionId,
                    providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
                    effort: "adaptive", systemPrompt: "test system", prompt: "Delegate and wait.",
                });
                await waitForDb(() => db.test_get_loop_status.get<{ status: number }>({ id: accepted.loopId }), (row) => row?.status === 202);
                await waitForDb(async () => lifecycle(), (notices) => notices.length >= 2);
                assert.deepEqual(lifecycle().map(({ loopId, notice }) => [loopId, notice.status, notice.level]), [[accepted.loopId, 102, "info"], [accepted.loopId, 202, "info"]],
                    "running when claimed, parked when suspended, both naming the loop");
                const firstDeadline = lifecycle()[1].notice.waitUntil;
                assert.ok(typeof firstDeadline === "number" && firstDeadline > Date.now(), "the parked notice names a future wake deadline");
                assert.equal(lifecycle()[0].notice.waitUntil, null, "running has no countdown");
                assert.equal((await daemon.listSessionLoops({ workspaceId, sessionId })).find(({ id }) => id === accepted.loopId)?.waitUntil,
                    firstDeadline, "reattachment and live updates describe the same durable deadline");
                // {§acp-status-descendants} — every beat carries its loop's own packet count and claim stamp, the ones a snapshot reads.
                const projected = (await daemon.listSessionLoops({ workspaceId, sessionId })).find(({ id }) => id === accepted.loopId)!;
                assert.deepEqual(lifecycle().map(({ notice }) => [notice.packetCount, notice.claimedAt]), [[0, Date.parse(projected.claimedAt!)], [projected.packetCount, Date.parse(projected.claimedAt!)]],
                    "claimed with no packet yet, parked after its first, the same claim stamp throughout");

                const delivered = await daemon.runLoop({ workspaceId, sessionId, prompt: "A message wakes it." });
                assert.equal(delivered.loopId, accepted.loopId);
                await waitForDb(async () => lifecycle(), (notices) => notices.length >= 5);
                assert.deepEqual(lifecycle().slice(2).map(({ notice }) => notice.status), [100, 102, 202], "waking queues the loop, then claim and WAIT move it through running to parked");
                assert.deepEqual(lifecycle().slice(2, 4).map(({ notice }) => notice.waitUntil), [null, null], "the countdown clears before inference begins");
                const nextDeadline = lifecycle()[4].notice.waitUntil;
                assert.ok(typeof nextDeadline === "number" && nextDeadline > firstDeadline, "the next WAIT starts a fresh bounded park");
                assert.equal((await daemon.listSessionLoops({ workspaceId, sessionId })).find(({ id }) => id === accepted.loopId)?.waitUntil, nextDeadline);
                assert.ok(lifecycle().every(({ sessionId: owner }) => owner === sessionId), "every beat names the owning session");
                const packets = await db.test_log_entries_by_loop.all<{ op: string; rx: string }>({ loop_id: accepted.loopId });
                assert.ok(packets.every(({ rx }) => !rx.includes("loop_status")), "the beat is transient: no log row, nothing for a packet");
                assert.ok(lifecycle().slice(2).every(({ notice }) => notice.claimedAt === Date.parse(projected.claimedAt!)), "a woken loop keeps its first claim stamp");
                // {§notifications} — the terminal carries the stamp a snapshot reads.
                await daemon.cancelSession({ workspaceId, sessionId });
                await waitForDb(async () => terminals(), (events) => events.length >= 1);
                const ended = (await daemon.listSessionLoops({ workspaceId, sessionId })).find(({ id }) => id === accepted.loopId)!;
                assert.equal((terminals()[0] as { terminatedAt: number }).terminatedAt, Date.parse(ended.terminatedAt!));
            } finally { await daemon.cancelSession({ workspaceId, sessionId }); }
        } finally { ws.close(); }
    });
});

const rpcAttach = async (ws: Awaited<ReturnType<typeof connect>>, workspaceId: number): Promise<void> => {
    const response = await rpcCall(ws, 1, "workspace.attach", { id: workspaceId });
    if ("error" in response && response.error !== undefined) throw new Error(`attach failed: ${JSON.stringify(response.error)}`);
};
});

describe("Daemon.notice-event", () => {
test("{§notifications} notifyNotice broadcasts to clients attached to the loop's workspace", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspaceResp = await rpcCall(ws, 1, "workspace.create", { name: "notices-test" });
            const workspaceId = (workspaceResp.result as { id: number }).id;
            const captured = subscribeNotifications(ws, "notice/event");

            daemon.notifyNotice(workspaceId, {
                sessionId: 7,
                loopId: 42,
                notice: {
                    source: "provider:local",
                    kind: "output_unaccounted",
                    level: "warn",
                    message: "transported grammar diverged from returned content",
                    position: { type: "content-offset", line: 3, column: 7 },
                },
            });

            const notices = (captured() as Array<{ sessionId: number; loopId: number; notice: { source: string; kind: string; message: string } }>)
                .filter((item) => item.loopId === 42);
            assert.equal(notices.length, 1);
            assert.equal(notices[0].sessionId, 7);
            assert.equal(notices[0].loopId, 42);
            assert.equal(notices[0].notice.source, "provider:local");
            assert.equal(notices[0].notice.kind, "output_unaccounted");
            assert.equal(notices[0].notice.message, "transported grammar diverged from returned content");
        } finally { ws.close(); }
    });
});

test("{§operation-results} notice/event is workspace-scoped — other workspaces don't see it", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const wsA = await connect(addr);
        const wsB = await connect(addr);
        try {
            const aResp = await rpcCall(wsA, 1, "workspace.create", { name: "notices-A" });
            const bResp = await rpcCall(wsB, 1, "workspace.create", { name: "notices-B" });
            const workspaceA = (aResp.result as { id: number }).id;
            const workspaceB = (bResp.result as { id: number }).id;

            const aEvents = subscribeNotifications(wsA, "notice/event");
            const bEvents = subscribeNotifications(wsB, "notice/event");

            daemon.notifyNotice(workspaceA, { sessionId: 11, loopId: 1, notice: { source: "engine:turn", kind: "turn_awaiting_model", level: "info", message: "awaiting model response" } });
            daemon.notifyNotice(workspaceB, { sessionId: 12, loopId: 2, notice: { source: "exec:sqlite", kind: "query_progress", level: "info", completed: 5, total: 10, percent: 50 } });


            const aCaptured = (aEvents() as Array<{ notice: { kind: string } }>).filter((item) => item.notice.kind === "turn_awaiting_model");
            const bCaptured = (bEvents() as Array<{ notice: { kind: string } }>).filter((item) => item.notice.kind === "query_progress");
            assert.equal(aCaptured.length, 1);
            assert.equal(aCaptured[0].notice.kind, "turn_awaiting_model");
            assert.equal(bCaptured.length, 1);
            assert.equal(bCaptured[0].notice.kind, "query_progress");
        } finally { wsA.close(); wsB.close(); }
    });
});
});

describe("Daemon.ops", () => {
test("{§methods} op.edit creates an entry via engine.dispatch (origin=client)", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "ops-test" });
            const response = await rpcCall(ws, 2, "op.edit", {
                target: "workspace:///france/capital", content: "Paris",
            });
            assert.equal((response.result as { status: number }).status, 201);

            const entry = await db.test_get_entry_by_pathname_scheme.get<{ scheme: string; pathname: string }>({ pathname: "/france/capital", scheme: "workspace" });
            assert.equal(entry?.scheme, "workspace");
            assert.equal(entry?.pathname, "/france/capital");
            const body = (await db.test_get_body_by_pathname.get<{ content: string }>({ pathname: "/france/capital" }))?.content;
            assert.equal(body, "Paris");
            const log = await db.test_first_log_entry.get<{ id: number; session_id: number; origin: string; op: string }>();
            assert.ok(log !== undefined);
            assert.equal(log?.origin, "client");
            assert.equal(log?.op, "EDIT");
        } finally { ws.close(); }
    });
});

test("{§methods}: op.edit log/entry notification precedes the action response", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "notify-order" });
            // Record inbound messages in arrival order, after the workspace is up — so we capture
            // only the op.edit exchange: the log/entry notification must land before response#2.
            const order: string[] = [];
            ws.on("message", (data) => {
                const m = JSON.parse(typeof data === "string" ? data : (data as Buffer).toString("utf8")) as { method?: string; id?: number };
                order.push(m.method ?? `response#${m.id}`);
            });
            await rpcCall(ws, 2, "op.edit", { target: "workspace:///x", content: "hi" });
            const notifyIdx = order.indexOf("log/entry");
            const respIdx = order.indexOf("response#2");
            assert.ok(notifyIdx !== -1, `log/entry should have fired (order: ${order.join(", ")})`);
            assert.ok(respIdx !== -1 && notifyIdx < respIdx, `{§methods}: log/entry must precede the op response (order: ${order.join(", ")})`);
        } finally { ws.close(); }
    });
});

test("{§methods} op.read fetches an entry's body", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "read-test" });
            await rpcCall(ws, 2, "op.edit", { target: "workspace:///x", content: "hello" });
            const response = await rpcCall(ws, 3, "op.read", { target: "workspace:///x" });
            const result = response.result as { status: number; content: string };
            assert.equal(result.status, 200);
            assert.equal(result.content, "hello");
        } finally { ws.close(); }
    });
});

test("{§methods} op.read on nonexistent entry returns 404", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "404-test" });
            const response = await rpcCall(ws, 2, "op.read", { target: "workspace:///nope" });
            assert.equal((response.result as { status: number }).status, 404);
        } finally { ws.close(); }
    });
});

test("{§methods} op.dispatch accepts a raw PlurnkStatement AST and dispatches it", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "dispatch-test" });
            const statement = {
                op: "EDIT" as const,
                aside: null,
                metadata: null,
                target: {
                    kind: "url" as const, raw: "workspace:///hello",
                    scheme: "workspace", username: null, password: null,
                    hostname: null, port: null, pathname: "/hello",
                    query: null, fragment: null,
                },
                lineMarker: null,
                matcher: null,
                body: "world",
                position: { line: 1, column: 1 },
            };
            const response = await rpcCall(ws, 2, "op.dispatch", { statement });
            assert.equal((response.result as { status: number }).status, 201);

            const body = (await db.test_get_body_by_pathname.get<{ content: string }>({ pathname: "/hello" }))?.content;
            assert.equal(body, "world");
        } finally { ws.close(); }
    });
});

test("{§notifications} op.* fires log/entry notification with the entry shape", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const notifications = subscribeNotifications(ws, "log/entry");
            await rpcCall(ws, 1, "workspace.create", { name: "notif-test" });
            await rpcCall(ws, 2, "op.edit", { target: "workspace:///x", content: "test" });

            const captured = notifications();
            assert.equal(captured.length, 1);
            const params = captured[0] as { entry: { op: string; origin: string; status_rx: number } };
            assert.equal(params.entry.op, "EDIT");
            assert.equal(params.entry.origin, "client");
            assert.equal(params.entry.status_rx, 201);
        } finally { ws.close(); }
    });
});

test("{§notifications} log/entry notification is scoped to workspace", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const wsA = await connect(addr);
        const wsB = await connect(addr);
        try {
            const aNotifs = subscribeNotifications(wsA, "log/entry");
            const bNotifs = subscribeNotifications(wsB, "log/entry");

            await rpcCall(wsA, 1, "workspace.create", { name: "workspace-A" });
            await rpcCall(wsB, 1, "workspace.create", { name: "workspace-B" });

            await rpcCall(wsA, 2, "op.edit", { target: "workspace:///x", content: "from A" });

            assert.equal(aNotifs().length, 1);
            assert.equal(bNotifs().length, 0);
        } finally { wsA.close(); wsB.close(); }
    });
});
test("{§find-result-projection} op.find on empty scope returns 200 with empty results", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "find-test" });
            const response = await rpcCall(ws, 2, "op.find", { scope: "workspace:///empty/" });
            const result = response.result as { status: number; results: string[]; content: string };
            assert.equal(result.status, 200);
            assert.deepEqual(result.results, []);
            assert.equal(result.content, "[]", "FIND content is a JSON catalog array — empty here");
        } finally { ws.close(); }
    });
});

test("{§connection-lifecycle} a completed client operation concludes its administrative loop", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspace = await rpcCall(ws, 1, "workspace.create", { name: "note-test" });
            const workspaceId = (workspace.result as { id: number }).id;

            // The operation opens its own loop in the workspace's runtime session.
            const response = await rpcCall(ws, 2, "op.dispatch", { statement: Dsl.parseSingleStatement("````NOTE\nClient observation.\n````") });
            assert.equal((response.result as { status: number }).status, 200);

            const runtime = await daemon.ensureRuntimeSession(workspaceId);
            const operations = (await daemon.listSessionLoops({ workspaceId, sessionId: runtime }))
                .filter(({ promptSource }) => promptSource === SeamSocket.owner);
            assert.deepEqual(operations.map(({ status }) => status), [200], "the one operation's loop concluded 200");
        } finally { ws.close(); }
    });
});
});

describe("Daemon.outside-event", () => {
test("{§notifications} notifyOutsideEvent broadcasts the exact payload to the loop's workspace only", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const wsA = await connect(addr);
        const wsB = await connect(addr);
        try {
            const workspaceA = ((await rpcCall(wsA, 1, "workspace.create", { name: "outside-A" })).result as { id: number }).id;
            await rpcCall(wsB, 1, "workspace.create", { name: "outside-B" });
            const aEvents = subscribeNotifications(wsA, "outside/event");
            const bEvents = subscribeNotifications(wsB, "outside/event");
            const event = { sessionId: 7, loopId: 42, turnId: 9, coordinate: "alice-1-3", text: "Thinking out loud.", tokens: 9 };
            daemon.notifyOutsideEvent(workspaceA, event);
            // {§notifications}: the envelope stamps the scope; the payload is otherwise exact.
            assert.deepEqual(aEvents(), [{ ...event, workspaceId: workspaceA }], "the payload arrives once, exactly as emitted");
            assert.deepEqual(bEvents(), [], "another workspace's client sees nothing");
        } finally { wsA.close(); wsB.close(); }
    });
});
});

describe("Daemon.session-gauge", () => {
const NONE: ApplicationGauge = { curationWeight: null, curationBudget: null, contextTokens: null, contextCapacity: null };

// Each packet's gauge in arrival order, and each terminal's, by loop.
const observe = (daemon: Daemon) => {
    const packets: Array<{ loopId: number; gauge: ApplicationGauge }> = [];
    const terminals = new Map<number, ApplicationGauge>();
    const off = daemon.subscribeToEvents((_workspaceId: number | null, method: string, params: unknown) => {
        if (method === "loop/packet") packets.push(params as { loopId: number; gauge: ApplicationGauge });
        if (method !== "loop/terminated") return;
        const { loopId, usage: { curationWeight, curationBudget, contextTokens, contextCapacity } } = params as {
            loopId: number; usage: ApplicationGauge;
        };
        terminals.set(loopId, { curationWeight, curationBudget, contextTokens, contextCapacity });
    });
    const terminal = (loopId: number) => waitForDb(async () => terminals.get(loopId), (value) => value !== undefined);
    const latest = (): ApplicationGauge => packets.at(-1)?.gauge ?? NONE;
    const lastOf = (loopId: number): ApplicationGauge | undefined => packets.findLast((packet) => packet.loopId === loopId)?.gauge;
    return { packets, terminal, latest, lastOf, off };
};

test("{§methods-workspace-create}: the gauge the Session's latest packet reported, moving with each model turn", async (t) => {
    const provider = new Mock({ contextWindow: 32768, responses: [
        makeMockResponse("````SEND [200]\nThe first answer.\n````"),
        makeMockResponse("````NOTE\nWorking on the second.\n````"),
        makeMockResponse("````SEND [200]\nThe second answer.\n````"),
        makeMockResponse("````SEND [200]\nThe third answer.\n````"),
    ] });
    // The second loop's second call is held while the gauge is read, then cancelled.
    const generate = provider.generate.bind(provider);
    let calls = 0;
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.mock.method(provider, "generate", async (...args: Parameters<Mock["generate"]>) => {
        if (++calls === 3) {
            held.resolve();
            await release.promise;
        }
        return generate(...args);
    });
    t.after(() => release.resolve());
    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "session-gauge" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const { packets, terminal, latest, lastOf, off } = observe(daemon);
        try {
            const gauge = () => daemon.sessionGauge({ workspaceId, sessionId });
            assert.deepEqual(await gauge(), NONE, "a Session without a packet reports no gauge");

            const { loopId: first } = await daemon.runLoop({ workspaceId, sessionId, prompt: "Answer once." });
            const concluded = await terminal(first);
            assert.deepEqual(lastOf(first), concluded, "a loop's last packet and its terminal report one gauge");
            assert.deepEqual(await gauge(), latest(), "the gauge the latest packet reported");

            const { loopId: second } = await daemon.runLoop({ workspaceId, sessionId, prompt: "Answer again." });
            await held.promise;
            const working = lastOf(second);
            assert.ok(working !== undefined, "the working loop's first turn reported its gauge before the loop ends");
            assert.notDeepEqual(working, concluded, "that turn's gauge is its own");
            assert.deepEqual(await gauge(), working, "the gauge moves with the working loop's turn");
            await daemon.cancelSession({ workspaceId, sessionId, reason: "user_escape" });
            release.resolve();
            await terminal(second);
            assert.deepEqual(await gauge(), latest(), "a cancelled loop leaves the gauge its latest packet reported");

            const { loopId: third } = await daemon.runLoop({ workspaceId, sessionId, prompt: "Answer a third time." });
            const ended = await terminal(third);
            assert.deepEqual(lastOf(third), ended, "each loop's last packet and terminal agree");
            assert.deepEqual(await gauge(), latest(), "the gauge follows the packet that came last");
            assert.ok(packets.length >= 4, "every model turn reported a packet");

            const { workspaceId: elsewhere } = await daemon.createWorkspace({ name: "session-gauge-elsewhere" });
            await assert.rejects(daemon.sessionGauge({ workspaceId: elsewhere, sessionId }), (error: unknown) =>
                error instanceof OperationFailureError
                && error.result.problem?.type === "https://problems.plurnk.xyz/daemon/session/workspace-mismatch");
        } finally {
            off();
        }
    });
});

test("{§methods-workspace-create}: absent capacity evidence stays absent, as the packet reported it", async () => {
    const provider = new Mock({ contextWindow: null, responses: [makeMockResponse("````SEND [200]\nThe answer.\n````")] });
    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "session-gauge-uncalibrated" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const { terminal, latest, off } = observe(daemon);
        try {
            const { loopId } = await daemon.runLoop({ workspaceId, sessionId, prompt: "Answer once." });
            await terminal(loopId);
            const gauge = await daemon.sessionGauge({ workspaceId, sessionId });
            assert.deepEqual(gauge, latest(), "the gauge the packet reported");
            assert.equal(gauge.contextCapacity, null, "no capacity evidence, no capacity");
            assert.equal(gauge.curationBudget, null, "no capacity, no curation budget");
            assert.notEqual(gauge.curationWeight, null, "the packet's own weight is still known");
        } finally {
            off();
        }
    });
});
});

describe("Daemon.workspace", () => {
interface RpcResponse {
    jsonrpc: "2.0";
    id: number;
    result?: unknown;
    error?: { code: number; message: string };
}

const wsRpcCall = (ws: SeamSocket, id: number, method: string, params?: object): Promise<RpcResponse> =>
    new Promise((resolve, reject) => {
        const onMessage = (data: Buffer | string) => {
            const text = typeof data === "string" ? data : data.toString("utf8");
            const parsed = JSON.parse(text) as RpcResponse;
            if (parsed.id === id) { ws.off("message", onMessage); resolve(parsed); }
        };
        ws.on("message", onMessage);
        ws.on("error", reject);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });

// The integration harness calls the in-process seam. {§rpc}
const withWsDaemon = async <T>(fn: (db: Db, addr: { daemon: Daemon }) => Promise<T>): Promise<T> => {
    const db = await openMigrated();
    const daemon = new Daemon({ db });
    await daemon.start();
    try { return await fn(db, { daemon }); }
    finally { await daemon.stop(); await db.close(); }
};

const wsConnect = (addr: { daemon: Daemon }): Promise<SeamSocket> => Promise.resolve(new SeamSocket(addr.daemon));

test("{§methods-workspace-create}: a bound connection switches workspaces without reconnecting", async () => {
    await withWsDaemon(async (_db, addr) => {
        const ws = await wsConnect(addr);
        try {
            const a = await wsRpcCall(ws, 1, "workspace.create", { name: "first" });
            const aId = (a.result as { id: number }).id;
            // Re-create on the SAME connection succeeds and rebinds.
            const b = await wsRpcCall(ws, 2, "workspace.create", { name: "second" });
            assert.equal(b.error, undefined, "re-create on a bound connection must not throw");
            const bId = (b.result as { id: number }).id;
            assert.notEqual(bId, aId, "the connection switched to a fresh workspace");
            // Re-attach to the first by id — also re-binds cleanly.
            const back = await wsRpcCall(ws, 3, "workspace.attach", { id: aId });
            assert.equal(back.error, undefined, "re-attach on a bound connection must not throw");
            assert.equal((back.result as { id: number }).id, aId, "switched back to the first workspace");
        } finally { ws.close(); }
    });
});

test("{§methods-workspace-create} workspace.rename mutates the workspace name; rejects collision + empty", async () => {
    await withWsDaemon(async (_db, addr) => {
        const ws = await wsConnect(addr);
        try {
            const created = await wsRpcCall(ws, 1, "workspace.create", { name: "rename-a" });
            const id = (created.result as { id: number }).id;

            // Rename the attached workspace — same id (immutable identity), new handle.
            const renamed = await wsRpcCall(ws, 2, "workspace.rename", { name: "rename-b" });
            const rr = renamed.result as { id: number; name: string };
            assert.equal(rr.id, id, "same workspace — its mutable name changed, not its identity");
            assert.equal(rr.name, "rename-b", "the workspace name is mutated");

            // The old name is freed — a new workspace can take it (and re-binds this connection).
            const reuse = await wsRpcCall(ws, 3, "workspace.create", { name: "rename-a" });
            assert.equal(reuse.error, undefined, "the freed name is available again");

            // Collision: rename the (now "rename-a") workspace to a name another workspace holds.
            const collide = await wsRpcCall(ws, 4, "workspace.rename", { name: "rename-b" });
            const collisionProblem = rpcProblem(collide);
            assert.equal(collisionProblem.type, "https://problems.plurnk.xyz/daemon/workspace/name-conflict");
            assert.equal(collisionProblem.name, "rename-b");

            // Empty name is a contract violation.
            const empty = await wsRpcCall(ws, 5, "workspace.rename", { name: "" });
            const emptyProblem = rpcProblem(empty);
            assert.equal(emptyProblem.type, "https://problems.plurnk.xyz/daemon/input/name-invalid");
            assert.equal(emptyProblem.field, "name");

            // Self-rename is a no-op, not a collision.
            const self = await wsRpcCall(ws, 6, "workspace.rename", { name: "rename-a" });
            assert.equal(self.error, undefined, "renaming to its own name is a no-op, not a collision");
            assert.equal((self.result as { name: string }).name, "rename-a");
        } finally { ws.close(); }
    });
});
});

describe("Engine.session-accounting", () => {
const spend = async (db: Db, loopId: number, sequence: number, inputTokens: number, costUsd: string): Promise<void> => {
    const turnId = await insertTurn(db, loopId, sequence, 200);
    const call = await db.engine_open_model_call.get<{ id: number }>({ turn_id: turnId, kind: "emission", attributions: "[]", model: "mock" });
    if (call === undefined) throw new Error("fixture model call did not open");
    const request = await db.engine_open_provider_request.get<{ id: number }>({ inference_call_id: call.id, sequence: 1, provider: "provider:mock", model: "mock" });
    if (request === undefined) throw new Error("fixture provider request did not open");
    const accounting: ProviderRequestAccounting = {
        provider: "provider:mock", model: "mock", outcome: "response",
        usage: { inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 },
        cost: { kind: "estimated", amount: { amount: costUsd, currency: "USD" }, source: "fixture" },
    };
    await db.engine_settle_provider_request.run(providerRequestSettlementParams(request.id, accounting));
};

test("{§methods-workspace-create}: the session's own and its descendants' settled spend since it began, and nothing else", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "session-spend");
        const parent = await insertSession(db, workspaceId, null, "parent", "model");
        const child = await insertSession(db, workspaceId, parent, "child", "model");
        const grandchild = await insertSession(db, workspaceId, child, "grandchild", "model");
        const stranger = await insertSession(db, workspaceId, null, "stranger", "model");
        const idle = await insertSession(db, workspaceId, null, "idle", "model");
        // An earlier delegation of the same child: still this session's tree, still its spend.
        const earlier = await insertLoop(db, child, 1, "earlier");
        await spend(db, earlier, 1, 1000, "1.00");
        const parentLoop = await insertLoop(db, parent, 1, "delegate");
        await spend(db, parentLoop, 1, 500, "0.50");
        const childLoop = await insertLoop(db, child, 2, "child work");
        await spend(db, childLoop, 1, 100, "0.10");
        await spend(db, childLoop, 2, 200, "0.20");
        const grandchildLoop = await insertLoop(db, grandchild, 1, "grandchild work");
        await spend(db, grandchildLoop, 1, 40, "0.04");
        const strangerLoop = await insertLoop(db, stranger, 1, "unrelated");
        await spend(db, strangerLoop, 1, 7000, "7.00");

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const accounting = await engine.sessionAccounting(parent);
        assert.equal(accounting.requests.length, 5, "its own request and every descendant's, the older delegation included");
        assert.equal(accounting.usage?.inputTokens, 1840, "the stranger's 7000 never counts");
        assert.equal(accounting.costUsd, "1.84");

        const own = await engine.loopUsage(parentLoop);
        assert.equal(own.accounting.usage?.inputTokens, 500, "one loop's own accounting keeps its meaning");

        const leaf = await engine.sessionAccounting(grandchild);
        assert.equal(leaf.usage?.inputTokens, 40, "a session without descendants reports its own");
        const none = await engine.sessionAccounting(idle);
        assert.equal(none.requests.length, 0);
        assert.equal(none.costUsd, "0", "nothing spent projects explicit zero");
    } finally { await db.close(); }
});
});

describe("place-hiding", () => {
const refusal = async (attempt: Promise<unknown>): Promise<ProblemDetails> => {
    try {
        await attempt;
    } catch (error) {
        assert.ok(error instanceof OperationFailureError, `a Problem, not ${String(error)}`);
        return error.result.problem;
    }
    assert.fail("the call was not refused");
};

const sorted = (ids: readonly number[]): number[] => ids.toSorted((a, b) => a - b);

type Mark = { place: "workspace" | "session"; id: number; hidden_at: string | null; hidden_by: number | null };
const marks = async (db: Db, workspaceId: number): Promise<Mark[]> => db.test_place_marks.all<Mark>({ workspace_id: workspaceId });
const groups = async (db: Db, workspaceId: number): Promise<Record<number, number | null>> =>
    Object.fromEntries((await marks(db, workspaceId)).filter(({ place }) => place === "session").map(({ id, hidden_by }) => [id, hidden_by]));

const NO_GATES: PlaceGates = async () => ({ proposals: [], questions: [] });

// The work a place can hold, and what of it is live: a loop queued, running or parked ({§session-loop-lifecycle}), an
// open stream, detached or not, and a gate the engine reports.
const WORK = ["none", "queued", "running", "parked", "concluded", "stream", "detached stream", "closed stream", "proposal", "question"] as const;
type Work = typeof WORK[number];
const COUNTS: Readonly<Record<Work, { loops: number; streams: number; proposals: number; questions: number } | null>> = {
    none: null, concluded: null, "closed stream": null,
    queued: { loops: 1, streams: 0, proposals: 0, questions: 0 },
    running: { loops: 1, streams: 0, proposals: 0, questions: 0 },
    parked: { loops: 1, streams: 0, proposals: 0, questions: 0 },
    stream: { loops: 0, streams: 1, proposals: 0, questions: 0 },
    "detached stream": { loops: 0, streams: 1, proposals: 0, questions: 0 },
    proposal: { loops: 0, streams: 0, proposals: 1, questions: 0 },
    question: { loops: 0, streams: 0, proposals: 0, questions: 1 },
};

const seedWork = async (db: Db, workspaceId: number, sessionId: number, work: Work): Promise<void> => {
    if (work === "queued" || work === "running" || work === "parked") {
        const status = { queued: 100, running: 102, parked: 202 }[work];
        await db.test_loops_insert_with_status.run({ session_id: sessionId, sequence: 1, status, prompt: "work", terminal_result: null });
    } else if (work === "concluded") {
        await db.test_loops_insert_with_status.run({ session_id: sessionId, sequence: 1, status: 200, prompt: "work", terminal_result: JSON.stringify({ status: 200 }) });
    } else if (work === "stream" || work === "detached stream" || work === "closed stream") {
        const entryId = await seedEntryWithChannel(db, { workspaceId, scheme: "sh", pathname: `/${sessionId}/1/1/sh`, channel: "stdout", content: "", state: "active" });
        const stream = await db.test_open_subscription_detached.get<{ id: number }>({ session_id: sessionId, entry_id: entryId, detached: work === "detached stream" ? 1 : 0 });
        assert.ok(stream !== undefined);
        if (work === "closed stream") await db.test_close_subscription.run({ id: stream.id });
    }
};

// Where the work sits: on the place (the session, or a root of the workspace), beneath it (a grandchild of the session,
// or a child in the workspace), or outside it (a sibling of the session, or a session of another workspace).
const POSITIONS = ["at", "beneath", "outside"] as const;

for (const target of ["workspace", "session"] as const) {
    test(`{§machine-processes} a ${target}'s hide is refused, naming what is live, exactly while live work sits on it or beneath it; nothing is marked by a refusal`, async () => {
        const db = await openMigrated();
        try {
            for (const position of POSITIONS) {
                for (const work of WORK) {
                    const label = `${work} ${position} the ${target}`;
                    const workspaceId = await insertWorkspace(db, `matrix-${crypto.randomUUID()}`);
                    const other = await insertWorkspace(db, `matrix-other-${crypto.randomUUID()}`);
                    const root = await insertSession(db, workspaceId, null, "root");
                    const child = await insertSession(db, workspaceId, root, "child");
                    const grandchild = await insertSession(db, workspaceId, child, "grandchild");
                    const sibling = await insertSession(db, workspaceId, null, "sibling");
                    const stranger = await insertSession(db, other, null, "stranger");
                    const holder = target === "workspace"
                        ? { at: root, beneath: child, outside: stranger }[position]
                        : { at: root, beneath: grandchild, outside: sibling }[position];
                    const holderWorkspace = holder === stranger ? other : workspaceId;
                    await seedWork(db, holderWorkspace, holder, work);
                    const gates: PlaceGates = async (id) => ({
                        proposals: work === "proposal" && id === holderWorkspace ? [{ sessionId: holder }] : [],
                        questions: work === "question" && id === holderWorkspace ? [{ sessionId: holder }] : [],
                    });
                    const before = await marks(db, workspaceId);
                    const hide = target === "workspace"
                        ? Places.setWorkspaceHidden(db, gates, workspaceId, true).then(({ hiding }) => hiding)
                        : Places.setSessionHidden(db, gates, workspaceId, root, true);
                    const live = position === "outside" ? null : COUNTS[work];
                    if (live === null) {
                        assert.equal(typeof (await hide).hidden_at, "string", `${label}: hidden`);
                        continue;
                    }
                    const problem = await refusal(hide);
                    assert.equal(problem.status, 409, label);
                    assert.ok(problem.type.endsWith("/live-work"), `${label}: ${problem.type}`);
                    assert.deepEqual({ loops: problem.loops, streams: problem.streams, proposals: problem.proposals, questions: problem.questions }, live, label);
                    assert.deepEqual(await marks(db, workspaceId), before, `${label}: a refused hide marks nothing`);
                }
            }
        } finally { await db.close(); }
    });
}

test("{§machine-processes} a session's hide marks its subtree as one group: a group inside joins it, a session created beneath joins it, a second hide changes nothing, and showing any member shows the group", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `groups-${crypto.randomUUID()}`);
        const root = await insertSession(db, workspaceId, null, "root");
        const a = await insertSession(db, workspaceId, root, "a");
        const a1 = await insertSession(db, workspaceId, a, "a1");
        const b = await insertSession(db, workspaceId, root, "b");
        const sibling = await insertSession(db, workspaceId, null, "sibling");

        const inner = await Places.setSessionHidden(db, NO_GATES, workspaceId, a, true);
        assert.deepEqual(sorted(inner.sessionIds), sorted([a, a1]));
        assert.deepEqual(await groups(db, workspaceId), { [root]: null, [a]: a, [a1]: a, [b]: null, [sibling]: null }, "a hide marks the session and every session beneath it");
        const outer = await Places.setSessionHidden(db, NO_GATES, workspaceId, root, true);
        assert.deepEqual(sorted(outer.sessionIds), sorted([root, a, a1, b]));
        assert.deepEqual(await groups(db, workspaceId), { [root]: root, [a]: root, [a1]: root, [b]: root, [sibling]: null }, "a group hidden inside joins the outer one");
        assert.deepEqual(await Places.setSessionHidden(db, NO_GATES, workspaceId, a1, true), { id: a1, hidden_at: outer.hidden_at, sessionIds: [] }, "hiding a hidden session changes nothing");
        const late = await insertSession(db, workspaceId, a, "late");
        assert.equal((await groups(db, workspaceId))[late], root, "a session created beneath a hidden session joins its group");

        const shown = await Places.setSessionHidden(db, NO_GATES, workspaceId, a1, false);
        assert.deepEqual(shown, { id: a1, hidden_at: null, sessionIds: sorted([root, a, a1, b, late]) });
        assert.ok((await marks(db, workspaceId)).every(({ hidden_at }) => hidden_at === null), "showing any member shows the whole group");
        assert.deepEqual(await Places.setSessionHidden(db, NO_GATES, workspaceId, sibling, false), { id: sibling, hidden_at: null, sessionIds: [] }, "showing a shown session changes nothing");

        const hiddenWorkspace = await Places.setWorkspaceHidden(db, NO_GATES, workspaceId, true);
        assert.equal(hiddenWorkspace.changed, true);
        assert.ok((await marks(db, workspaceId)).every(({ place, hidden_at }) => (place === "workspace") === (hidden_at !== null)), "a workspace's mark is its own");
        assert.deepEqual(await Places.setWorkspaceHidden(db, NO_GATES, workspaceId, true), { hiding: hiddenWorkspace.hiding, changed: false }, "a second hide keeps the first mark");
        assert.deepEqual(await Places.setWorkspaceHidden(db, NO_GATES, workspaceId, false), { hiding: { id: workspaceId, hidden_at: null }, changed: true });
        assert.deepEqual(await Places.setWorkspaceHidden(db, NO_GATES, workspaceId, false), { hiding: { id: workspaceId, hidden_at: null }, changed: false });

        const other = await insertWorkspace(db, `groups-other-${crypto.randomUUID()}`);
        for (const hidden of [true, false]) {
            assert.equal((await refusal(Places.setSessionHidden(db, NO_GATES, other, root, hidden))).status, 404, "a session of another workspace is not found");
            assert.equal((await refusal(Places.setWorkspaceHidden(db, NO_GATES, Number.MAX_SAFE_INTEGER, hidden))).status, 404, "a workspace that does not exist is not found");
        }
    } finally { await db.close(); }
});

test("{§machine-processes} a live loop starting on a hidden session brings back its group and its workspace; concluded history brings nothing back", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `return-${crypto.randomUUID()}`);
        const root = await insertSession(db, workspaceId, null, "root");
        const child = await insertSession(db, workspaceId, root, "child");
        const sibling = await insertSession(db, workspaceId, null, "sibling");
        await Places.setWorkspaceHidden(db, NO_GATES, workspaceId, true);
        await Places.setSessionHidden(db, NO_GATES, workspaceId, root, true);
        await Places.setSessionHidden(db, NO_GATES, workspaceId, sibling, true);
        const hidden = await marks(db, workspaceId);

        await db.test_loops_insert_with_status.run({ session_id: child, sequence: 1, status: 200, prompt: "history", terminal_result: JSON.stringify({ status: 200 }) });
        assert.deepEqual(await marks(db, workspaceId), hidden, "a concluded loop is history, never work");

        await db.test_insert_queued_loop.get({ session_id: child, sequence: 2, prompt: "work" });
        assert.deepEqual((await marks(db, workspaceId)).map(({ place, id, hidden_at }) => [place, id, hidden_at !== null]), [
            ["session", root, false], ["session", child, false], ["session", sibling, true], ["workspace", workspaceId, false],
        ], "the loop's group and workspace are shown; another group stays hidden");
    } finally { await db.close(); }
});

test("{§machine-processes} {§methods-workspace-create} listings filter by the mark only when asked; the overview leaves out hidden sessions and, in the daemon's scope, every session of a hidden workspace", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const shownWorkspace = await daemon.createWorkspace({ name: `shown-${crypto.randomUUID()}` });
        const hiddenWorkspace = await daemon.createWorkspace({ name: `hidden-${crypto.randomUUID()}` });
        const shown = await daemon.createSession({ workspaceId: shownWorkspace.workspaceId, name: "shown" });
        const hidden = await daemon.createSession({ workspaceId: shownWorkspace.workspaceId, name: "hidden" });
        const inside = await daemon.createSession({ workspaceId: hiddenWorkspace.workspaceId, name: "inside" });
        await daemon.setSessionHidden({ workspaceId: shownWorkspace.workspaceId, sessionId: hidden.sessionId, hidden: true });
        await daemon.setWorkspaceHidden({ workspaceId: hiddenWorkspace.workspaceId, hidden: true });

        const names = async (hiddenFilter?: boolean): Promise<string[]> => (await daemon.listSessions(shownWorkspace.workspaceId, {
            origin: "model", ...(hiddenFilter === undefined ? {} : { hidden: hiddenFilter }),
        })).map(({ name }) => name).toSorted();
        assert.deepEqual(await names(), ["hidden", "shown"], "an unfiltered listing holds every session");
        assert.deepEqual(await names(false), ["shown"]);
        assert.deepEqual(await names(true), ["hidden"]);
        const ids = async (hiddenFilter?: boolean): Promise<number[]> => (await daemon.listWorkspaces(hiddenFilter === undefined ? {} : { hidden: hiddenFilter }))
            .map(({ id }) => id).filter((id) => id === shownWorkspace.workspaceId || id === hiddenWorkspace.workspaceId).toSorted((a, b) => a - b);
        assert.deepEqual(await ids(), sorted([shownWorkspace.workspaceId, hiddenWorkspace.workspaceId]));
        assert.deepEqual(await ids(false), [shownWorkspace.workspaceId]);
        assert.deepEqual(await ids(true), [hiddenWorkspace.workspaceId]);
        assert.equal(typeof (await daemon.readSession({ workspaceId: shownWorkspace.workspaceId, identity: { name: "hidden" } }))?.hidden_at, "string", "a direct read finds a hidden session");
        assert.equal((await daemon.attachWorkspace({ name: hiddenWorkspace.workspaceName })).workspaceId, hiddenWorkspace.workspaceId, "an attach finds a hidden workspace");
        assert.deepEqual(await ids(true), [hiddenWorkspace.workspaceId], "and leaves it hidden");

        const overview = async (workspaceId?: number) => {
            const read = await daemon.readSessionOverview({ ...(workspaceId === undefined ? {} : { workspaceId }), limit: 100, excerptChars: 40 });
            return { sessions: read.sessions.map(({ id }) => id).filter((id) => [shown.sessionId, hidden.sessionId, inside.sessionId].includes(id)), workspaces: read.workspaces.map(({ id }) => id) };
        };
        assert.deepEqual(await overview(), { sessions: [shown.sessionId], workspaces: [shownWorkspace.workspaceId] }, "the daemon's overview");
        assert.deepEqual(await overview(shownWorkspace.workspaceId), { sessions: [shown.sessionId], workspaces: [shownWorkspace.workspaceId] }, "a workspace's overview");
        assert.deepEqual(await overview(hiddenWorkspace.workspaceId), { sessions: [inside.sessionId], workspaces: [hiddenWorkspace.workspaceId] }, "a hidden workspace's own overview holds its shown sessions");

        for (const attempt of [
            () => daemon.setWorkspaceHidden({ workspaceId: shownWorkspace.workspaceId, hidden: "yes" as unknown as boolean }),
            () => daemon.setSessionHidden({ workspaceId: shownWorkspace.workspaceId, sessionId: shown.sessionId, hidden: 1 as unknown as boolean }),
            () => daemon.listSessions(shownWorkspace.workspaceId, { hidden: "no" as unknown as boolean }),
            () => daemon.listWorkspaces({ hidden: null as unknown as boolean }),
        ]) {
            const problem = await refusal(attempt());
            assert.equal(problem.status, 400);
            assert.ok(problem.type.endsWith("/flag-invalid"), problem.type);
        }
    });
});

test("{§methods-workspace-create} {§methods-workspace-create} {§notifications} {§notifications} {§execution-output-identity} each change is announced once in its workspace; creating by the folder selects and shows a hidden workspace; an explicit name it holds conflicts", async () => {
    const folder = await mkdtemp(join(tmpdir(), "plurnk-hidden-"));
    try {
        await withDaemon(null, async (_db, daemon) => {
            const events: Array<[number | null, string, unknown]> = [];
            const unsubscribe = daemon.subscribeToEvents((workspaceId, method, params) => {
                if (method === "workspace/hidden" || method === "session/hidden") events.push([workspaceId, method, params]);
            });
            const created = await daemon.createWorkspace({ projectRoot: folder });
            const hidden = await daemon.setWorkspaceHidden({ workspaceId: created.workspaceId, hidden: true });
            assert.equal(typeof hidden.hidden_at, "string");
            assert.deepEqual(await daemon.setWorkspaceHidden({ workspaceId: created.workspaceId, hidden: true }), hidden, "a second hide keeps the first mark");
            const selected = await daemon.createWorkspace({ projectRoot: folder });
            assert.equal(selected.workspaceId, created.workspaceId, "creating by the folder selects the hidden workspace");
            assert.equal((await daemon.listWorkspaces()).find(({ id }) => id === created.workspaceId)?.hidden_at, null, "and shows it");

            const named = await daemon.createWorkspace({ name: `named-${crypto.randomUUID()}` });
            const namedHidden = await daemon.setWorkspaceHidden({ workspaceId: named.workspaceId, hidden: true });
            const conflict = await refusal(daemon.createWorkspace({ name: named.workspaceName }));
            assert.equal(conflict.status, 409);
            assert.ok(conflict.type.endsWith("/name-conflict"), conflict.type);
            assert.match(conflict.detail ?? "", /by a hidden workspace/u, "the conflict says the name's holder is hidden");

            const session = await daemon.createSession({ workspaceId: created.workspaceId, name: "quiet" });
            const sessionHidden = await daemon.setSessionHidden({ workspaceId: created.workspaceId, sessionId: session.sessionId, hidden: true });
            assert.deepEqual(sessionHidden.sessionIds, [session.sessionId]);
            await daemon.setSessionHidden({ workspaceId: created.workspaceId, sessionId: session.sessionId, hidden: true });
            const sessionShown = await daemon.setSessionHidden({ workspaceId: created.workspaceId, sessionId: session.sessionId, hidden: false });
            await daemon.setSessionHidden({ workspaceId: created.workspaceId, sessionId: session.sessionId, hidden: false });
            unsubscribe();
            assert.deepEqual(events, [
                [created.workspaceId, "workspace/hidden", hidden],
                [created.workspaceId, "workspace/hidden", { id: created.workspaceId, hidden_at: null }],
                [named.workspaceId, "workspace/hidden", namedHidden],
                [created.workspaceId, "session/hidden", sessionHidden],
                [created.workspaceId, "session/hidden", { id: session.sessionId, hidden_at: null, sessionIds: [session.sessionId] }],
            ], "a call that changes nothing announces nothing");
            assert.deepEqual(sessionShown, { id: session.sessionId, hidden_at: null, sessionIds: [session.sessionId] });
        });
    } finally { await rm(folder, { recursive: true, force: true }); }
});

test("{§machine-processes} a hide is refused over a gate the daemon holds; a loop run on a hidden session brings it and its workspace back", async () => {
    const gated = new Mock({ contextWindow: 16384, responses: [
        // A host execution the server reviews: the loop waits on its proposal.
        makeMockResponse("\n````sh\necho pending\n````\n\n````NOTE\nproposed\n````", 10),
    ] });
    await withDaemon(gated, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspaceId = ((await rpcCall(ws, 1, "workspace.create", { name: `gated-${crypto.randomUUID()}` })).result as { id: number }).id;
            const proposals = subscribeNotifications(ws, "loop/proposal");
            const { modelSessionId } = (await rpcCall(ws, 2, "loop.run", { prompt: "go" })).result as { modelSessionId: number };
            await waitFor(() => proposals(), (seen) => seen.length >= 1, { timeoutMs: 10_000 });
            for (const attempt of [
                () => daemon.setSessionHidden({ workspaceId, sessionId: modelSessionId, hidden: true }),
                () => daemon.setWorkspaceHidden({ workspaceId, hidden: true }),
            ]) {
                const problem = await refusal(attempt());
                assert.equal(problem.status, 409);
                assert.equal(problem.proposals, 1, "the pending proposal is named");
                assert.equal(problem.loops, 1, "with the loop that waits on it");
            }
        } finally { ws.close(); }
    });

    const answering = new Mock({ contextWindow: viableWindow(), responses: [makeMockResponse("````SEND [200]\ndone\n````", 50)] });
    await withDaemon(answering, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspaceId = ((await rpcCall(ws, 1, "workspace.create", { name: `returning-${crypto.randomUUID()}` })).result as { id: number }).id;
            const { sessionId } = await daemon.createSession({ workspaceId, name: "returning" });
            await daemon.setSessionHidden({ workspaceId, sessionId, hidden: true });
            await daemon.setWorkspaceHidden({ workspaceId, hidden: true });
            const run = await runLoopToTerminal(ws, 2, { prompt: "go", sessionId });
            assert.equal(run.finalStatus, 200);
            assert.ok((await daemon.listWorkspaces({ hidden: false })).some(({ id }) => id === workspaceId), "the workspace is shown");
            assert.ok((await daemon.listSessions(workspaceId, { hidden: false })).some(({ id }) => id === sessionId), "the session is shown");
        } finally { ws.close(); }
    });
});
});

describe("seam-create-session", () => {
test("{§methods-workspace-create} {§methods-workspace-create}: fresh named session — empty log, runLoop accepts", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("````SEND [200]\nhello from thread-2\n````", 10)] });
    await withDaemon(mock, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "threads" });
            const workspaceId = (created.result as { id: number }).id;

            // A named, empty, model-origin root.
            const fresh = await daemon.createSession({ workspaceId, name: "Thread_2" });
            assert.equal(fresh.sessionName, "Thread_2", "the client's name IS the session name");
            assert.equal((await daemon.readLog({ workspaceId, sessionId: fresh.sessionId })).length, 0, "an EMPTY log — fork copies history, this must not");

            // runLoop accepts it (model-origin), and the full loop settles on that session.
            const terminated: Array<{ loopId: number; result: { status: number } }> = [];
            daemon.subscribeToEvents((_workspaceId, method, params) => {
                if (method === "loop/terminated") terminated.push(params as { loopId: number; result: { status: number } });
            });
            const accepted = await daemon.runLoop({ workspaceId, sessionId: fresh.sessionId, prompt: "start thread 2" });
            assert.ok(accepted.loopId > 0, "runLoop accepts the fresh session");
            await waitFor(
                () => terminated,
                (events) => events.some(({ loopId, result }) => loopId === accepted.loopId && result.status === 200),
                { timeoutMs: 8000 },
            );

            // Name invariants mirror forkSession's: plurnk is an ordinary name; unmintable + taken are legible refusals.
            const plurnk = await daemon.createSession({ workspaceId, name: "plurnk" });
            assert.equal(plurnk.sessionName, "plurnk", "the operator may hold a session named plurnk");
            await assert.rejects(
                () => daemon.createSession({ workspaceId, name: "_plurnk" }),
                (error) => {
                    assert.ok(error instanceof OperationFailureError);
                    assert.equal(error.result.problem.type, "https://problems.plurnk.xyz/daemon/session/name-invalid");
                    assert.equal(error.result.problem.name, "_plurnk");
                    assert.equal(error.result.problem.recovery, "Use 1–63 ASCII letters, digits, '_' or '-', starting with a letter or digit."); // {§operation-results}
                    return true;
                },
            );
            await assert.rejects(
                () => daemon.createSession({ workspaceId, name: "_invalid" }),
                (error) => {
                    assert.ok(error instanceof OperationFailureError);
                    assert.equal(error.result.problem.type, "https://problems.plurnk.xyz/daemon/session/name-invalid");
                    assert.equal(error.result.problem.status, 400);
                    assert.equal(error.result.problem.name, "_invalid");
                    assert.equal(error.result.problem.retryable, false);
                    return true;
                },
            );
            await assert.rejects(
                () => daemon.createSession({ workspaceId, name: "Thread_2" }),
                (error) => {
                    assert.ok(error instanceof OperationFailureError);
                    assert.equal(error.result.problem.type, "https://problems.plurnk.xyz/daemon/session/name-conflict");
                    assert.equal(error.result.problem.workspaceId, workspaceId);
                    assert.equal(error.result.problem.name, "Thread_2");
                    assert.equal(error.result.problem.recovery, "Choose another session name."); // {§operation-results}
                    return true;
                },
            );
            // Omission mints a distinct session with an opaque name.
            const anon = await daemon.createSession({ workspaceId });
            assert.match(anon.sessionName, /^[a-f0-9]{8}$/, "an unnamed session receives the ordinary opaque name");
        } finally { ws.close(); }
    });
});

test("{§execution-output-identity}: concurrent unnamed fresh sessions claim distinct short names", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: `threads-${crypto.randomUUID()}` });
            const workspaceId = (created.result as { id: number }).id;
            const sessions = await Promise.all(Array.from(
                { length: 8 },
                () => daemon.createSession({ workspaceId }),
            ));
            const names = sessions.map(({ sessionName }) => sessionName);

            assert.equal(new Set(names).size, sessions.length, "every fresh session remains individually addressable");
            for (const name of names) assert.match(name, /^[a-f0-9]{8}$/);
        } finally { ws.close(); }
    });
});

test("{§methods-workspace-create}: concurrent requests for one name create it once; the others are refused as name-conflict", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: `contest-${crypto.randomUUID()}` });
            const workspaceId = (created.result as { id: number }).id;
            const parent = await daemon.createSession({ workspaceId, name: "parent" });
            const attempts: Array<[string, () => Promise<unknown>]> = [
                ["create", () => daemon.createSession({ workspaceId, name: "contested" })],
                ["fork", () => daemon.forkSession({ workspaceId, sessionId: parent.sessionId, name: "branched" })],
            ];
            for (const [label, attempt] of attempts) {
                const settled = await Promise.allSettled(Array.from({ length: 4 }, attempt));
                assert.equal(settled.filter(({ status }) => status === "fulfilled").length, 1, `${label}: one request claims the name`);
                for (const outcome of settled) {
                    if (outcome.status === "fulfilled") continue;
                    assert.ok(outcome.reason instanceof OperationFailureError, `${label}: ${String(outcome.reason)}`);
                    assert.equal(outcome.reason.result.problem.type, "https://problems.plurnk.xyz/daemon/session/name-conflict", label);
                    assert.equal(outcome.reason.result.problem.status, 409, label);
                }
            }
        } finally { ws.close(); }
    });
});
});

describe("session-references", () => {
test("{§session-external-reference} concurrent allocation is durable, folderless and independent of names and owners", async () => {
    const path = join(await testArtifactDirectory("session-references"), `identity-${crypto.randomUUID()}.db`);
    const reference = { namespace: "fixture", reference: "customer/分析 #blue?100%" };
    const db = await openMigrated(path);
    const daemon = new Daemon({ db, provider: null });
    let identity: { workspaceId: number; sessionId: number };
    try {
        assert.equal(await daemon.readSessionReference(reference), null);
        assert.deepEqual(await daemon.listWorkspaces(), []);
        const created: unknown[] = [];
        const off = daemon.subscribeToEvents((_scope, event, payload) => {
            if (event === "workspace/created") created.push(payload);
        });
        const identities = await Promise.all(Array.from({ length: 12 }, () => daemon.ensureSessionReference(reference)));
        identity = identities[0]!;
        assert.ok(identities.every((item) => item.workspaceId === identity.workspaceId && item.sessionId === identity.sessionId));
        assert.equal(created.length, 1, "only the allocator publishes workspace creation");
        off();
        const [workspace] = await daemon.listWorkspaces();
        assert.equal((await daemon.listWorkspaces()).length, 1);
        assert.equal(workspace?.project_root, null);
        assert.match(workspace.name, /^(?=.*[A-Za-z])[A-Za-z0-9]{5}$/u);
        const [session] = await daemon.listSessions(identity.workspaceId);
        assert.equal((await daemon.listSessions(identity.workspaceId)).length, 1);
        assert.equal(session?.id, identity.sessionId);
        assert.equal(session?.origin, "model");
        assert.equal(session?.owner, "_plurnk");
        assert.equal(session?.parentSessionId, null);
        assert.match(session.name, /^[0-9a-f]{8}$/u);
        await daemon.renameWorkspace(identity.workspaceId, "Renamed # workspace");
        await daemon.registerSessionOwner(identity.workspaceId, { address: "fixture://owner", tools: [], interactive: false });
        await daemon.claimSessionOwner({ ...identity, owner: "fixture://owner" });
        assert.deepEqual(await daemon.ensureSessionReference(reference), identity);
        assert.deepEqual(await daemon.listSessionReferences({ ...identity, namespace: reference.namespace }), [reference.reference]);
        assert.deepEqual(await daemon.listSessionReferences({ ...identity, namespace: "another" }), []);
        assert.deepEqual(await daemon.listSessionLoops(identity), [], "binding does not start work");
    } finally { await daemon.stop(); await db.close(); }
    const reopened = await openMigrated(path);
    const next = new Daemon({ db: reopened, provider: null });
    try {
        assert.deepEqual(await next.readSessionReference(reference), identity);
        assert.deepEqual(await next.ensureSessionReference(reference), identity);
        assert.deepEqual(await next.listSessionReferences({ ...identity, namespace: reference.namespace }), [reference.reference]);
        assert.equal((await next.listWorkspaces())[0]?.name, "Renamed # workspace");
    } finally { await next.stop(); await reopened.close(); }
});

test("{§session-external-reference} namespaces and exact reference bytes isolate identities", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    try {
        const inputs = [
            { namespace: "one", reference: "" },
            { namespace: "two", reference: "" },
            { namespace: "one", reference: "é" },
            { namespace: "one", reference: "e\u0301" },
            { namespace: "one", reference: "quote'\"; --" },
        ];
        const identities = await Promise.all(inputs.map((input) => daemon.ensureSessionReference(input)));
        assert.equal(new Set(identities.map(({ sessionId }) => sessionId)).size, inputs.length);
        assert.equal((await daemon.listWorkspaces()).length, inputs.length);
        for (const [i, input] of inputs.entries()) assert.deepEqual(await daemon.readSessionReference(input), identities[i]);
    } finally { await daemon.stop(); await db.close(); }
});

test("{§session-external-reference} independent database connections converge without process-local serialization", async () => {
    const path = join(await testArtifactDirectory("session-references"), `concurrent-${crypto.randomUUID()}.db`);
    const firstDb = await openMigrated(path);
    const secondDb = await openMigrated(path);
    const first = new Daemon({ db: firstDb, provider: null });
    const second = new Daemon({ db: secondDb, provider: null });
    const reference = { namespace: "fixture", reference: "parallel" };
    try {
        const [a, b] = await Promise.all([first.ensureSessionReference(reference), second.ensureSessionReference(reference)]);
        assert.deepEqual(a, b);
        assert.equal((await first.listWorkspaces()).length, 1);
        assert.equal((await second.listSessions(a.workspaceId)).length, 1);
    } finally {
        await first.stop(); await second.stop();
        await firstDb.close(); await secondDb.close();
    }
});

test("{§session-external-reference} allocation rolls back on failure and leaves existing names untouched", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    try {
        const input = { namespace: "fixture", reference: "rollback", workspace_name: "NewWs", session_name: "" };
        await assert.rejects(db.session_reference_allocate.get(input), /CHECK constraint failed/u);
        assert.deepEqual(await daemon.listWorkspaces(), [], "failure at session creation rolls back the workspace too");
        assert.equal(await daemon.readSessionReference(input), null);
        const existing = await daemon.createWorkspace({ name: "NewWs" });
        assert.equal(await db.session_reference_allocate.get({ ...input, session_name: "valid" }), undefined);
        assert.deepEqual(await daemon.listSessions(existing.workspaceId), [], "a random name collision never adopts an existing workspace");
        const allocated = await daemon.ensureSessionReference(input);
        assert.notEqual(allocated.workspaceId, existing.workspaceId);
        await db.test_session_reference_delete_session.run({ session_id: allocated.sessionId });
        assert.equal(await daemon.readSessionReference(input), null, "deletion cascades through the association");
    } finally { await daemon.stop(); await db.close(); }
});
});

describe("session-streams", () => {
const held = (release: string, writes: boolean): string =>
    `${writes ? "printf 'live stdout\\n'; " : ""}while [ ! -e ${release} ]; do sleep 0.05; done`;

test("{§methods} a session's open streams: each lifetime, every channel written or not, its opening row, until it ends", { timeout: 120_000 }, async (t) => {
    serverProposals(t, "accept");
    const dir = await mkdtemp(join(tmpdir(), "session-streams-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const release = join(dir, "release");
    const mock = new Mock({ contextWindow: 100_000, responses: [
        makeRawMockResponse([
            `\`\`\`\`sh\n${held(release, true)}\n\`\`\`\``,
            `\`\`\`\`sh [{"lifetime": "turn"}]\n${held(release, false)}\n\`\`\`\``,
            `\`\`\`\`sh [{"lifetime": "detached"}]\n${held(release, false)}\n\`\`\`\``,
            "````WAIT [60]\nWaiting on them.\n````",
        ].join("\n\n"), 10),
        makeRawMockResponse("````SEND [200]\nDone.\n````", 10),
    ] });
    await withDaemon(mock, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "session-streams" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const bystander = await namedModelSession(daemon, workspaceId, "bystander");
        const { workspaceId: elsewhere } = await daemon.createWorkspace({ name: "session-streams-elsewhere" });
        await daemon.runLoop({ workspaceId, sessionId, prompt: "Hold three commands open." });
        const streams = await waitForDb(() => daemon.readStreams({ workspaceId, sessionId }), (open: ApplicationStream[]) => open.length === 3,
            { timeoutMs: 30_000 });

        assert.deepEqual(streams.map(({ lifetime }) => lifetime), ["loop", "turn", "detached"], "in opening order, each as its fence declared it");
        const rows = (await daemon.readLog({ workspaceId, sessionId })).filter(({ op }) => op === "sh");
        for (const stream of streams) {
            assert.match(stream.target, /^sh:\/\/\/[0-9a-f]{8}$/u, "the execution's workspace claim");
            assert.equal(stream.sessionId, sessionId);
            const opened = rows.find(({ attrs }) => (attrs as { stream?: string } | null)?.stream === stream.target);
            assert.ok(opened, `a row announced ${stream.target}`);
            assert.deepEqual([stream.loop_seq, stream.turn_seq, stream.sequence], [opened.loop_seq, opened.turn_seq, opened.sequence],
                "named by the row that opened it");
            assert.deepEqual(stream.channels.map(({ channel, state }) => ({ channel, state })),
                [{ channel: "stderr", state: "active" }, { channel: "stdout", state: "active" }], "every channel, stderr never written");
            for (const { mimetype } of stream.channels) assert.equal(typeof mimetype, "string");
        }

        assert.deepEqual(await daemon.readStreams({ workspaceId, sessionId: bystander }), [], "another session holds none of them");
        await assert.rejects(daemon.readStreams({ workspaceId: elsewhere, sessionId }), (error: unknown) =>
            error instanceof OperationFailureError && error.result.problem.type.endsWith("/workspace-mismatch"), "a session is read in its own workspace");

        await writeFile(release, "");
        await waitForDb(() => daemon.readStreams({ workspaceId, sessionId }), (open: ApplicationStream[]) => open.length === 0,
            { timeoutMs: 30_000 });
    });
});
});

describe("workspace-project-root", () => {
test("{§methods-workspace-create} workspace.create with projectRoot round-trips and persists the column", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.create", {
                name: "with-root", projectRoot: "/home/me/repo/foo",
            });
            const result = response.result as { id: number; name: string; projectRoot: string | null };
            assert.equal(result.name, "with-root");
            assert.equal(result.projectRoot, "/home/me/repo/foo");

            const row = await db.envelope_get_workspace.get<{ project_root: string | null }>({ id: result.id });
            assert.equal(row?.project_root, "/home/me/repo/foo");
        } finally { ws.close(); }
    });
});

test("{§methods-workspace-create} workspace.create without projectRoot leaves the column null (headless)", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.create", { name: "headless" });
            const result = response.result as { id: number; name: string; projectRoot: string | null };
            assert.equal(result.projectRoot, null);

            const row = await db.envelope_get_workspace.get<{ project_root: string | null }>({ id: result.id });
            assert.equal(row?.project_root, null);
        } finally { ws.close(); }
    });
});

test("{§operation-results} workspace.create rejects non-absolute projectRoot", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.create", {
                name: "bad-root", projectRoot: "relative/path",
            });
            const problem = rpcProblem(response);
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/input/project-root-not-absolute");
            assert.equal(problem.value, "relative/path");
            assert.equal(problem.recovery, "Provide an absolute project path."); // {§operation-results}
        } finally { ws.close(); }
    });
});

test("{§notifications} workspace/created notification carries projectRoot", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const notifications = subscribeNotifications(ws, "workspace/created");
            await rpcCall(ws, 1, "workspace.create", {
                name: "with-notif", projectRoot: "/tmp/notif-test",
            });
            const captured = notifications();
            assert.equal(captured.length, 1);
            const params = captured[0] as { id: number; name: string; projectRoot: string | null };
            assert.equal(params.projectRoot, "/tmp/notif-test");
        } finally { ws.close(); }
    });
});
});
