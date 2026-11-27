import { after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { access, rm } from "node:fs/promises";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
    McpServer,
    createMcpHandler,
    type McpHttpHandler,
} from "@modelcontextprotocol/server";
import type { RuntimeAvailability, RuntimeDecl } from "@plurnk/plurnk-execs";
import type { FunctionalityPreparation, McpServerDefinition, ProblemDetails } from "@plurnk/plurnk-contracts";
import { z } from "zod/v4";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { serveOAuthMcp } from "./oauth-fixture.ts";
import { httpServer } from "./definitions.ts";
import type McpExecutor from "../src/McpExecutor.ts";
import type { OAuthGrantSummary } from "../src/oauth.ts";
import Module from "../src/Module.ts";

const floor = {
    PLURNK_MCP_ENABLED: "1",
    PLURNK_MCP_CONNECT_TIMEOUT_MS: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT_MS: "30000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
    PLURNK_MCP_REGISTRY_URL: "", PLURNK_MCP_REGISTRY_LIMIT: "5",
    PLURNK_MCP_WORKSPACE_TRANSPORTS: "stdio,streamable-http", PLURNK_MCP_PUBLIC_ONLY: "0",
};

interface RuntimeRegistration {
    readonly namespaceOwner: string;
    readonly decl: RuntimeDecl;
    readonly executor: McpExecutor;
    readonly availability: RuntimeAvailability;
    readonly scheme?: object;
}

type Outcome =
    | { state: "active"; detail?: { tools?: string[]; protocolVersion?: string; grant?: OAuthGrantSummary } }
    | { state: "unavailable"; problem: ProblemDetails }
    | { state: "authorization-required"; authorization: { url?: string } };

export interface Prepared {
    readonly runtimes: readonly RuntimeRegistration[];
    readonly outcomes: ReadonlyMap<string, Outcome>;
    readonly snapshot: unknown;
    publish(): (() => void) | undefined;
    commit(): Promise<void>;
    abort(): Promise<void>;
}

interface Adapter {
    readonly family: string;
    readonly namespaceOwner: string;
    available(identity: { workspaceId: number } | { scope: "service" }): Promise<readonly { alias: string; definition: object; enabled: boolean }[]>;
    readonly example?: { readonly alias: string; readonly definition: object };
    readonly discovery?: { readonly inputs: readonly string[]; readonly required?: readonly string[]; readonly emptyListsAll?: boolean; readonly details?: string };
    discover?(
        query: { query?: string; source?: string; configuration?: object; cursor?: string; limit?: number },
        identity: { workspaceId: number } | { scope: "service" },
    ): Promise<
        | readonly { alias?: string; summary?: string; definition: object; provenance: object }[]
        | { readonly candidates: readonly { alias?: string; summary?: string; definition: object; provenance: object }[]; readonly total?: number; readonly nextCursor?: string }
    >;
    admit(input: unknown, identity: { workspaceId: number } | { scope: "service" }): Promise<{ alias: string; definition: object }>;
    assertOperationAllowed?(
        verb: "add" | "replace" | "enable" | "disable" | "remove",
        alias: string,
        current: { readonly origin: "host" | "service" | "workspace" | "session"; readonly definition: object; readonly enabled: boolean } | undefined,
        identity: { workspaceId: number } | { scope: "service" },
    ): Promise<void> | void;
    refreshIfChanged(identity: { workspaceId: number }): Promise<void>;
    prepare(preparation: FunctionalityPreparation): Promise<Prepared>;
    teardown(snapshot: unknown, identity: { workspaceId: number }): Promise<void>;
    forget?(source: { alias: string; definition: object }, identity: { workspaceId: number }): Promise<void>;
    policy?(): object | undefined;
}

interface ActionRegistration {
    readonly name: string;
    readonly handler: (params: Readonly<Record<string, unknown>>, context: { scope: "workspace"; workspaceId: number } | { scope: "daemon" }) => unknown;
}

interface ModuleHarness {
    readonly module: ReturnType<typeof Module.init>;
    readonly stateRoot: string;
    readonly seam: {
        servicePaths: () => { home: string; workspaceName: string; projectRoot: null; configurationRoots: never[] };
        serviceStateDirectory: (owner: string) => Promise<string>;
        workspacePaths: (workspaceId: number) => Promise<{ home: string; workspaceName: string; projectRoot: null; configurationRoots: never[] }>;
        workspaceStateDirectory: (workspaceId: number, owner: string) => Promise<string>;
        readWorkspaceEnvironment: () => Promise<(ambient?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv>;
        operatorEnvironment: (source?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
        registerModuleAction: (registration: ActionRegistration) => void;
        registerFunctionalityAdapter: (candidate: Adapter) => {
            invoke: (verb: string, params: unknown, id: { workspaceId: number } | { scope: "service" }) => Promise<{ status: number; body: unknown }>;
            refresh: (id: { workspaceId: number }, options?: unknown) => Promise<void>;
            refreshAll: (options?: unknown) => Promise<void>;
        };
    };
    readonly actions: Map<string, ActionRegistration>;
    readonly serviceDefinitions: Map<string, { readonly origin: "host" | "service"; readonly definition: object; readonly enabled?: boolean }>;
    readonly snapshots: Map<number, { enabled: Map<string, object>; origins?: ReadonlyMap<string, "host" | "service" | "workspace">; prepared: Prepared | null }>;
    readonly leases: () => number;
    readonly setup: () => Promise<void>;
    readonly environment: Record<string, string>;
    readonly stateDirectory: (workspaceId: number, owner: string) => string;
    readonly serviceDirectory: (owner: string) => string;
    readonly refreshes: () => number;
    readonly refreshOptions: () => unknown[];
    readonly settleRefreshes: () => Promise<void[]>;
    readonly hooks: { between: () => Promise<void> };
    readonly adapter: () => Adapter;
    readonly identity: (workspaceId: number) => { workspaceId: number };
    readonly lane: (workspaceId: number, enabled: Map<string, object>, options?: { failure?: "publish-unavailable" | "reject"; force?: string; signal?: AbortSignal; origins?: ReadonlyMap<string, "host" | "service" | "workspace"> }) => Promise<Prepared>;
    readonly teardown: (workspaceId: number) => Promise<void>;
    readonly action: (workspaceId: number, name: string, params: Readonly<Record<string, unknown>>) => Promise<unknown>;
    readonly serviceAction: (name: string, params: Readonly<Record<string, unknown>>) => Promise<unknown>;
    readonly inService: (workspaceId: number) => string[];
    readonly unavailable: (workspaceId: number) => Array<{ name: string; detail: string | undefined }>;
}

// A harness that stands where the coordinator stands: it holds each workspace's
// enabled set and committed snapshot and calls the adapter's two phases. It
// decides nothing about lifecycle semantics — tests choose the enabled set.
export const harness = (
    env: Record<string, string> = {},
    beforeRefresh: () => Promise<void> = async () => {},
    harnessOptions: { stateRoot?: string } = {},
): ModuleHarness => {
    const environment: Record<string, string> = { ...floor, ...env };
    const module = Module.init({ env: environment });
    const ownsStateRoot = harnessOptions.stateRoot === undefined;
    const stateRoot = harnessOptions.stateRoot ?? mkdtempSync(join(tmpdir(), "plurnk-mcp-state-"));
    const stateDirectory = (workspaceId: number, owner: string): string => join(stateRoot, String(workspaceId), encodeURIComponent(owner));
    const serviceDirectory = (owner: string): string => join(stateRoot, "service", encodeURIComponent(owner));
    after(async () => {
        await module.stop();
        if (ownsStateRoot) await rm(stateRoot, { recursive: true, force: true });
    });
    let refreshes = 0;
    const refreshOptions: unknown[] = [];
    const pendingRefreshes: Promise<void>[] = [];
    const actions = new Map<string, ActionRegistration>();
    const serviceDefinitions = new Map<string, { readonly origin: "host" | "service"; readonly definition: object; readonly enabled?: boolean }>();
    const snapshots = new Map<number, { enabled: Map<string, object>; origins?: ReadonlyMap<string, "host" | "service" | "workspace">; prepared: Prepared | null }>();
    let adapter: Adapter | undefined;
    let leases = 0;
    const retain = () => { leases++; let released = false; return () => { if (released) return; released = true; leases--; }; };
    const identity = (workspaceId: number) => ({ workspaceId });
    // Runs between a candidate's publish and its commit: the instant the coordinator's registry commit has
    // adopted the candidate but its settlement has not run.
    const hooks = { between: async (): Promise<void> => {} };
    const lane = async (workspaceId: number, enabled: Map<string, object>, options: { failure?: "publish-unavailable" | "reject"; force?: string; signal?: AbortSignal; origins?: ReadonlyMap<string, "host" | "service" | "workspace"> } = {}): Promise<Prepared> => {
        if (adapter === undefined) throw new Error("adapter not registered");
        const current = snapshots.get(workspaceId);
        const origins = options.origins ?? current?.origins;
        const prepared = await adapter.prepare({
            signal: options.signal ?? new AbortController().signal,
            ...identity(workspaceId),
            enabled: new Map([...enabled].map(([alias, definition]) => {
                const origin = origins?.get(alias) ?? serviceDefinitions.get(alias)?.origin;
                return [alias, origin === undefined ? { definition } : { definition, origin }];
            })),
            previous: current?.prepared?.snapshot ?? null,
            failure: options.failure ?? "publish-unavailable", ...(options.force ? { force: options.force } : {}), admissions: [], retain,
            progress: () => undefined,
        });
        prepared.publish();
        await hooks.between();
        await prepared.commit();
        snapshots.set(workspaceId, { enabled, ...(origins === undefined ? {} : { origins }), prepared });
        return prepared;
    };
    const seam = {
        servicePaths: () => ({
            home: stateRoot,
            workspaceName: "service",
            projectRoot: null,
            configurationRoots: [],
        }),
        serviceStateDirectory: async (owner: string) => {
            const directory = serviceDirectory(owner);
            mkdirSync(directory, { recursive: true });
            return directory;
        },
        workspacePaths: async (workspaceId: number) => ({
            home: stateRoot,
            workspaceName: `workspace-${workspaceId}`,
            projectRoot: null,
            configurationRoots: [],
        }),
        workspaceStateDirectory: async (workspaceId: number, owner: string) => {
            const directory = stateDirectory(workspaceId, owner);
            mkdirSync(directory, { recursive: true });
            return directory;
        },
        readServiceEnvironment: async () => (ambient: NodeJS.ProcessEnv = getDefaultEnvironment()) => ({ ...ambient }),
        readWorkspaceEnvironment: async () => (ambient: NodeJS.ProcessEnv = getDefaultEnvironment()) => ({ ...ambient }),
        operatorEnvironment: (source?: NodeJS.ProcessEnv) => {
            const sanitized: Record<string, string> = {};
            for (const [key, value] of Object.entries(source ?? env)) {
                if (value === undefined || key.startsWith("PLURNK_")) continue;
                sanitized[key] = value;
            }
            return { ...getDefaultEnvironment(), ...sanitized };
        },
        registerModuleAction: (registration: ActionRegistration): void => { actions.set(registration.name, registration); },
        registerFunctionalityAdapter: (candidate: Adapter) => {
            adapter = candidate;
            return {
                invoke: async (verb: string, params: unknown, id: { workspaceId: number } | { scope: "service" }) => {
                    if (!("workspaceId" in id)) {
                        if (verb !== "list") throw new Error(`harness does not emulate service ${verb}`);
                        const definitions = [...serviceDefinitions].map(([alias, entry]) => ({
                            alias,
                            origin: entry.origin,
                            state: entry.enabled === false ? "disabled" : "dormant",
                            definition: entry.definition,
                        }));
                        return { status: 200, body: { family: "mcp", definitions, offset: 0, total: definitions.length } };
                    }
                    const current = snapshots.get(id.workspaceId);
                    if (current?.prepared == null) throw new Error("session not prepared");
                    if (verb === "list") {
                        const definitions = [...current.prepared.outcomes].map(([alias, outcome]) => ({
                            alias,
                            origin: current.origins?.get(alias) ?? serviceDefinitions.get(alias)?.origin ?? "workspace",
                            definition: current.enabled.get(alias),
                            ...outcome,
                        }));
                        return { status: 200, body: { family: "mcp", definitions, offset: 0, total: definitions.length } };
                    }
                    if (verb !== "enable") throw new Error(`harness does not emulate ${verb}`);
                    const alias = (params as { alias: string }).alias;
                    const prepared = await lane(id.workspaceId, current.enabled, { force: alias });
                    const outcome = prepared.outcomes.get(alias);
                    const status = outcome?.state === "authorization-required" ? 202 : 200;
                    return { status, body: { status, family: "mcp", alias, definition: { alias, origin: "workspace", ...outcome } } };
                },
                refresh: (id: { workspaceId: number }, options?: unknown) => {
                    refreshes++;
                    refreshOptions.push(options);
                    const pending = (async () => {
                        await beforeRefresh();
                        const current = snapshots.get(id.workspaceId);
                        if (current === undefined) return;
                        await lane(id.workspaceId, current.enabled, current.origins ? { origins: current.origins } : {});
                    })();
                    pendingRefreshes.push(pending);
                    return pending;
                },
                refreshAll: (options?: unknown) => {
                    const work = [...snapshots.keys()].map((workspaceId) => {
                        refreshes++;
                        refreshOptions.push(options);
                        const pending = (async () => {
                            await beforeRefresh();
                            const current = snapshots.get(workspaceId);
                            if (current === undefined) return;
                            await lane(workspaceId, current.enabled, current.origins ? { origins: current.origins } : {});
                        })();
                        pendingRefreshes.push(pending);
                        return pending;
                    });
                    return Promise.all(work).then(() => undefined);
                },
            };
        },
    };
    return {
        module,
        stateRoot,
        seam,
        actions,
        serviceDefinitions,
        snapshots,
        leases: (): number => leases,
        setup: (): Promise<void> => module.setup(seam as never),
        environment,
        stateDirectory,
        serviceDirectory,
        refreshes: (): number => refreshes,
        refreshOptions: (): unknown[] => refreshOptions,
        settleRefreshes: (): Promise<void[]> => Promise.all(pendingRefreshes),
        hooks,
        adapter: (): Adapter => { if (adapter === undefined) throw new Error("adapter not registered"); return adapter; },
        identity,
        lane,
        // As the coordinator does: a family is torn down only with the snapshot its preparation committed.
        teardown: async (workspaceId: number): Promise<void> => {
            const prepared = snapshots.get(workspaceId)?.prepared;
            if (prepared !== undefined && prepared !== null) await adapter!.teardown(prepared.snapshot, identity(workspaceId));
            snapshots.delete(workspaceId);
        },
        action: async (workspaceId: number, name: string, params: Readonly<Record<string, unknown>>): Promise<unknown> => {
            const registration = actions.get(name);
            if (registration === undefined) throw new Error(`missing action ${name}`);
            return registration.handler(params, { scope: "workspace", ...identity(workspaceId) });
        },
        serviceAction: async (name: string, params: Readonly<Record<string, unknown>>): Promise<unknown> => {
            const registration = actions.get(name);
            if (registration === undefined) throw new Error(`missing action ${name}`);
            return registration.handler(params, { scope: "daemon" });
        },
        // The runtimes in service, by name.
        inService: (workspaceId: number): string[] => (snapshots.get(workspaceId)?.prepared?.runtimes ?? [])
            .filter(({ availability }) => availability.available).map(({ decl }) => decl.name),
        // {§mcp-configuration} The enabled servers registered out of service, each with the reason a call is refused.
        unavailable: (workspaceId: number): Array<{ name: string; detail: string | undefined }> => (snapshots.get(workspaceId)?.prepared?.runtimes ?? [])
            .filter(({ availability }) => !availability.available).map(({ decl, availability }) => ({ name: decl.name, detail: availability.detail })),
    };
};

export const waitForFile = async (pathname: string): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        try { await access(pathname); return; } catch { await delay(10); }
    }
    await access(pathname);
};

export const rejectsManagementProblem = async (run: () => Promise<unknown>, code: string, status: number): Promise<void> => {
    await assert.rejects(run, (error: unknown) => {
        const problem = (error as { problem?: Record<string, unknown> }).problem;
        assert.equal(problem?.type, `https://problems.plurnk.xyz/mcp/management/${code}`);
        assert.equal(problem?.status, status);
        return true;
    });
};

export const httpHandler = (): McpHttpHandler => createMcpHandler(() => {
    const server = new McpServer({ name: "workspace-oauth-fixture", version: "1.0.0" });
    server.registerTool(
        "echo",
        { description: "Echo one message.", inputSchema: z.object({ message: z.string() }) },
        async ({ message }) => ({ content: [{ type: "text", text: message }] }),
    );
    return server;
}, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 });

export const interactiveOAuthFixture = (
    t: TestContext,
): ReturnType<typeof serveOAuthMcp> => serveOAuthMcp(t, httpHandler());

export const oauthDefinition = (served: { url: string }): McpServerDefinition => ({
    ...httpServer("oauth", served.url),
    authorization: {
        type: "oauth",
        redirectUrl: `${new URL(served.url).origin}/callback`,
        clientMetadataUrl: "https://client.example.test/oauth/metadata.json",
        scope: "mcp:read",
    },
});
