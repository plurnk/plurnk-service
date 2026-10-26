// The daemon's modules: the ones the service composes and the ones discovery adds, their HTTP mount claims,
// their setup/start/stop/close phases, and the actions they register. Split out of Daemon, which keeps the
// delegating seam entry points and the boot sequence that runs each phase in its place.
import type { DaemonModule, ModuleActionContext, ModuleActionDescriptor, ModuleActionRegistration, StartedModule } from "@plurnk/plurnk-modules";
import type { ApplicationPort, HttpRouteHandler, HttpUpgradeHandler } from "@plurnk/plurnk-contracts/port";
import { Validator } from "@plurnk/plurnk-contracts";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import type { Db } from "../core/Db.ts";
import type HostPaths from "../core/HostPaths.ts";
import type WorkspaceGate from "../core/WorkspaceGate.ts";
import ClientInput from "./client-input.ts";
import type ConfigurationDiagnostics from "./ConfigurationDiagnostics.ts";
import { daemonFailure } from "./daemon-results.ts";
import HttpListener from "./HttpListener.ts";
import type { HostSetupSeam } from "./ModuleHost.ts";
import { discoverDaemonModules } from "./module-discovery.ts";
import type { WorkspaceCapabilityRelease } from "./WorkspaceCapabilities.ts";
import type WorkspaceResidency from "./WorkspaceResidency.ts";

// {§module-discovery} — a registered module and its owner, the package it came from.
interface RegisteredModule {
    readonly module: DaemonModule<HostSetupSeam>;
    readonly owner: string;
}

export default class DaemonModules {
    readonly #db: Db;
    readonly #http: HttpListener | null;
    readonly #configuration: ConfigurationDiagnostics;
    readonly #residency: WorkspaceResidency;
    readonly #workspaceGate: WorkspaceGate;
    #modules: RegisteredModule[] = [];
    // {§module-http-mounts} — each claimed prefix's owner, and the claims mounted at start.
    readonly #mountClaims = new Map<string, string>();
    readonly #mounted = new Set<string>();
    #lifetimes: StartedModule[] = [];
    readonly #actions = new Map<string, ModuleActionRegistration>();

    constructor({ db, http, configuration, residency, workspaceGate }: {
        db: Db;
        http: HttpListener | null;
        configuration: ConfigurationDiagnostics;
        residency: WorkspaceResidency;
        workspaceGate: WorkspaceGate;
    }) {
        this.#db = db;
        this.#http = http;
        this.#configuration = configuration;
        this.#residency = residency;
        this.#workspaceGate = workspaceGate;
    }

    // {§module-discovery} — `owner` is the module's package name; diagnostics name it.
    register(module: DaemonModule<HostSetupSeam>, owner: string): void {
        this.#modules.push({ module, owner });
    }

    // {§module-discovery} {§module-lifecycle} Discovery composes beside the explicit modules; a daemon without a
    // listener leaves out every module that mounts and says so; what a module contained is its diagnostic; every
    // prefix is claimed; then each module sets up against the seam.
    async setup(seam: HostSetupSeam, discovery: { cwd: string; hostPaths: HostPaths }): Promise<void> {
        // {§module-discovery} — third-party daemon-module composition: trusted
        // packages declaring `plurnk.kind: "module"` register beside the
        // service's explicit composition before any module setup runs.
        const discoveredModules = await discoverDaemonModules({
            cwd: discovery.cwd, hostPaths: discovery.hostPaths, registered: new Set(this.#modules.map(({ owner }) => owner)),
        });
        for (const { owner, cause } of discoveredModules.configurationErrors) this.#configuration.record(owner, cause);
        this.#configuration.pluginReports(discoveredModules.reports);
        for (const packageName of discoveredModules.skipped) {
            console.warn(`module discovery: '${packageName}' is discovered but untrusted (PLURNK_EXTENSIONS_TRUSTED_ONLY); not registered`);
        }
        for (const { module, owner } of discoveredModules.modules) {
            this.#modules.push({ module, owner });
        }
        // {§module-http-mounts} — a daemon without a listener has nothing to serve a mount on: it
        // leaves out every module that declares one, and says so.
        if (this.#http === null) {
            this.#modules = this.#modules.filter(({ module, owner }) => {
                const mounts = module.mounts ?? [];
                if (mounts.length === 0) return true;
                this.#configuration.leftOut(`module:${owner}`, `module '${owner}' mounts ${mounts.map((prefix) => `'${prefix}'`).join(", ")} and this daemon has no HTTP listener: left out`);
                return false;
            });
        }
        // {§module-contained-configuration} — what a module contained is its own configuration diagnostic.
        for (const { module, owner } of this.#modules) {
            for (const { key, message } of module.contained ?? []) this.#configuration.record(`module:${owner}`, new ConfigurationError(key, message));
        }
        this.#claimMounts();
        for (const { module } of this.#modules) {
            if (module.stop !== undefined || module.close !== undefined) this.#lifetimes.push(module);
            await module.setup?.(seam);
        }
    }

    // {§module-lifecycle} — modules start only after capability publication and durable lifecycle recovery; a
    // start that returns a lifetime joins the ones setup recorded.
    async start(seam: ApplicationPort): Promise<void> {
        for (const { module } of this.#modules) {
            const started = await module.start?.(seam);
            if (started !== undefined && !this.#lifetimes.includes(started)) {
                this.#lifetimes.push(started);
            }
        }
    }

    // {§module-http-mounts} — every prefix is claimed before any module sets up: one owner per
    // prefix, including the optional root mount.
    #claimMounts(): void {
        for (const { module, owner } of this.#modules) {
            for (const prefix of module.mounts ?? []) {
                if (!HttpListener.isPrefix(prefix)) {
                    throw new Error(`module '${owner}' declares HTTP mount '${prefix}', which is not an absolute pathname prefix`);
                }
                const holder = this.#mountClaims.get(prefix);
                if (holder !== undefined) throw new Error(`HTTP mount '${prefix}' is claimed by both '${holder}' and '${owner}'`);
                this.#mountClaims.set(prefix, owner);
            }
        }
    }

    // {§module-http-mounts} — the listener is admitted once every module has started and every
    // claim is mounted, so readiness never depends on registration order.
    admitMounts(): void {
        if (this.#http === null) return;
        for (const [prefix, owner] of this.#mountClaims) {
            if (!this.#mounted.has(prefix)) throw new Error(`module '${owner}' claimed HTTP mount '${prefix}' but did not mount it at start`);
        }
        this.#http.admit();
    }

    // {§http-host} — exterior adapters mount on the daemon's one listener at start(); the
    // daemon never opens a second transport, and a daemon without a listener says so.
    registerHttpRoute(prefix: string, handler: HttpRouteHandler): void {
        if (this.#http === null) throw new Error(`registerHttpRoute: this daemon has no HTTP listener to mount '${prefix}' on`);
        // {§module-http-mounts} — a module mounts exactly what it claimed.
        if (!this.#mountClaims.has(prefix)) throw new Error(`registerHttpRoute: no module declared '${prefix}' among its mounts`);
        this.#http.registerHttpRoute(prefix, handler);
        this.#mounted.add(prefix);
    }

    registerHttpUpgrade(prefix: string, handler: HttpUpgradeHandler): void {
        if (this.#http === null) throw new Error(`registerHttpUpgrade: this daemon has no HTTP listener to mount '${prefix}' on`);
        // {§module-http-mounts} — a module mounts exactly what it claimed.
        if (!this.#mountClaims.has(prefix)) throw new Error(`registerHttpUpgrade: no module declared '${prefix}' among its mounts`);
        this.#http.registerHttpUpgrade(prefix, handler);
        this.#mounted.add(prefix);
    }

    httpAddress(): { readonly host: string; readonly port: number } {
        if (this.#http === null) throw new Error("httpAddress: this daemon has no HTTP listener");
        return this.#http.httpAddress();
    }

    registerAction(registration: ModuleActionRegistration): void {
        const { name, scope, inputSchema, outputSchema, handler } = registration;
        if (name.length === 0) throw new Error("registerModuleAction: action name must not be empty");
        if (scope !== "daemon" && scope !== "workspace" && scope !== "session") {
            throw new Error(`module action '${name}' has invalid scope '${String(scope)}'`);
        }
        if (inputSchema === null || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
            throw new Error(`module action '${name}' has no input schema`);
        }
        if (outputSchema === null || typeof outputSchema !== "object" || Array.isArray(outputSchema)) {
            throw new Error(`module action '${name}' has no output schema`);
        }
        for (const [role, schema] of [["input", inputSchema], ["output", outputSchema]] as const) {
            try {
                Validator.validateJsonSchemaInstance(schema, {});
            } catch (cause) {
                throw new Error(`module action '${name}' has an invalid ${role} schema`, { cause });
            }
        }
        if (typeof handler !== "function") throw new Error(`module action '${name}' has no handler`);
        if (registration.residency !== "required" && registration.residency !== "none") {
            throw new Error(`module action '${name}' must declare its residency requirement`);
        }
        if (scope === "daemon" && registration.residency !== "none") {
            throw new Error(`daemon module action '${name}' cannot require workspace residency`);
        }
        if (this.#actions.has(name)) throw new Error(`module action '${name}' is already registered`);
        this.#actions.set(name, registration);
    }

    listActions(): ModuleActionDescriptor[] {
        return [...this.#actions.values()]
            .map(({ name, scope, inputSchema, outputSchema }) => ({
                name,
                scope,
                inputSchema,
                outputSchema }))
            .toSorted((left, right) => left.name.localeCompare(right.name));
    }

    async invokeAction(
        name: string,
        params: Readonly<Record<string, unknown>>,
        context: ModuleActionContext,
    ): Promise<unknown> {
        const registration = this.#actions.get(name);
        if (registration === undefined) throw new Error(`module action '${name}' is not registered`);
        if (registration.scope !== context.scope) {
            throw new Error(
                `module action '${name}' requires ${registration.scope} context, not ${context.scope}`,
            );
        }
        let releaseCapabilities: WorkspaceCapabilityRelease | undefined;
        if (context.scope === "session") {
            const workspaceId = ClientInput.assertId(`module action '${name}'`, "workspaceId", context.workspaceId);
            const sessionId = ClientInput.assertId(`module action '${name}'`, "sessionId", context.sessionId);
            const session = await this.#db.envelope_get_session_by_id.get<{ workspace_id: number }>({ id: sessionId });
            if (session === undefined || session.workspace_id !== workspaceId) {
                throw daemonFailure(
                    "daemon:module-action",
                    "session-not-found",
                    404,
                    `Session ${sessionId} does not exist in workspace ${workspaceId}.`,
                    { workspaceId, sessionId, retryable: false },
                );
            }
        }
        if (registration.residency === "required" && context.scope !== "daemon") {
            releaseCapabilities = await this.#residency.acquire(context.workspaceId);
        } else if (context.scope === "workspace") {
            await this.#residency.identity(context.workspaceId);
        }
        try {
            if (registration.residency === "required" && context.scope === "session") {
                const release = await this.#workspaceGate.acquireTurn(context.workspaceId, context.sessionId);
                try {
                    await this.#residency.reconcile(context.workspaceId);
                } finally {
                    release();
                }
            }
            return await registration.handler(params, context);
        } finally {
            releaseCapabilities?.();
        }
    }

    // {§module-shutdown-order} The lifetimes in reverse order, taken once: each phase runs them all and reports every
    // failure together.
    beginStop(): { stop: () => Promise<void>; close: () => Promise<void> } {
        const modules = this.#lifetimes.toReversed();
        this.#lifetimes = [];
        const phase = async (name: "stop" | "close"): Promise<void> => {
            const results = await Promise.allSettled(modules.map((module) => Promise.resolve().then(() => module[name]?.())));
            const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(({ reason }) => reason);
            if (errors.length > 0) throw new AggregateError(errors, `module ${name} failed`);
        };
        return { stop: () => phase("stop"), close: () => phase("close") };
    }
}
