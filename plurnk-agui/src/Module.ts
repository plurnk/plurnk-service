// {§agui-daemon-client} The daemon's AG-UI+ client interface, a discovered module: it claims
// `/agui` on the daemon's one listener ({§module-http-mounts}), mounts it at start, and
// owns no socket.
//
// This is the single external client interface:
//   POST /agui — a Run; POST /agui/connect — an observer that also waits while idle.
//   A worker streams SSE. HITL is terminate-resume: a stopped-world presents the call it
//   gates (the operation's own, or a client interaction's) and finishes with an AG-UI
//   interrupt outcome (the loop stays paused in-engine); the next AG-UI Run's standard
//   resume entries resolve the durable gate and continue the exact loop.
//   Reads ride STATE_SNAPSHOT on RUN_STARTED; there are no side-channel action
//   or proposal-resolution endpoints.
// A thread resolves to a model worker through {§agui-thread-binding}; core retains
// opaque external references, while this adapter interprets qualified addresses.

import type { IncomingMessage, ServerResponse } from "node:http";
import Portal, { type PortalPort } from "./Portal.ts";
import { aliveChildren, spendState, statusState, actionRunResult, type ActionRequest, type ActionOutcome, type AguiStatusState } from "./AguiPlus.ts";
import { EventType, type AguiEvent, type RunAgentInput } from "./types.ts";
import { aguiRouteTemplate, observed } from "./observe.ts";
import { Problems, Validator, requestOrigin, selectWorkerLoop, type AguiDiscovery, type ClientEnvelope, type ProblemDetails, type RequestHeaders } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { AGUI_BUILTIN_ACTIONS, AGUI_NOTIFICATIONS, type AguiActionContract } from "./AguiSurface.ts";
import { resolveModuleOptions, type ModuleOptions, type ResolvedModuleOptions } from "./config.ts";
import { HttpProblemError, actionFailure } from "./action-results.ts";
import BuiltinActions, { type BuiltinActionsPort, type OperationLoopListener } from "./BuiltinActions.ts";
import { credentialRevokedProblem, httpProblem, runErrorEvents, serviceStoppingProblem } from "./run-events.ts";
import OAuthServer from "./OAuthServer.ts";
import RunHandler, { type RunPort, type WorkerBinding } from "./RunHandler.ts";
import ThreadAddress from "./ThreadAddress.ts";
import { MessageScheme } from "@plurnk/plurnk-schemes";
import type { SchemeRegistrationSeam } from "@plurnk/plurnk-schemes";
import type { DaemonModule } from "@plurnk/plurnk-modules";

export type { ModuleOptions } from "./config.ts";

// {§module-seam-slices} — the start seam: the calls the module makes itself, and each
// collaborator's slice.
export type AguiPort = Pick<
    ApplicationPort,
    | "attachWorkspace"
    | "configurationNotices"
    | "credentials"
    | "createWorker"
    | "createWorkspace"
    | "workerAccounting"
    | "httpAddress"
    | "invokeModuleAction"
    | "listClientDisplayCapabilities"
    | "listModuleActions"
    | "listWorkerLoops"
    | "listWorkers"
    | "listWorkspaces"
    | "readWorker"
    | "readWorkerReference"
    | "ensureWorkerReference"
    | "readWorkerModel"
    | "registerHttpRoute"
    | "workspaceDerivationStatus"
    | "workspacePreparationStatus"
> & PortalPort & BuiltinActionsPort & RunPort;

const writeHttpProblem = (res: ServerResponse, problem: ProblemDetails): void => {
    res.writeHead(problem.status, { "content-type": "application/problem+json" });
    res.end(JSON.stringify(problem));
};

type ActionExecutor = (
    params: Readonly<Record<string, unknown>>,
    input: RunAgentInput,
    env: ClientEnvelope | null,
    boundWorkerId: number | undefined,
    principal: string,
    onLoop: OperationLoopListener | undefined,
) => Promise<ActionOutcome>;

interface RegisteredAction extends AguiActionContract {
    readonly execute: ActionExecutor;
}

// {§credential-authority} — at setup the module publishes the authority's issuing face, before any
// start, and takes the listener's address so the face answers its issuer from then on ({§http-host}).
export type AguiSetupSeam = SchemeRegistrationSeam & Pick<ApplicationPort, "credentials" | "httpAddress">;

// {§agui-action-binding} The builtin actions addressed to the thread's worker: those that set its durable
// policy create it, the rest require it, and the readers that take an explicit `workerId` require it only
// without one.
const WORKER_CREATING_ACTIONS: ReadonlySet<string> = new Set(["worker.model.set", "worker.child.set", "worker.effort.set"]);
const WORKER_ACTIONS: ReadonlySet<string> = new Set(["loop.inject", "loop.cancel", "run.fork", "worker.model.get", "worker.effort.get"]);
const WORKER_READING_ACTIONS: ReadonlySet<string> = new Set(["log.read", "entry.read", "workspace.prompts", "workspace.rollback"]);

export default class Module implements DaemonModule<AguiSetupSeam, AguiPort> {
    // {§module-http-mounts} — the client protocol owns its own prefix and, when it authenticates, the
    // authorization server's ({§agui-oauth-endpoints}).
    readonly mounts: readonly string[];
    #seam!: AguiPort;
    #listener!: AguiSetupSeam["httpAddress"];
    readonly #opts: ResolvedModuleOptions;
    #portal!: Portal;
    #oauth: OAuthServer | null = null;
    #offRevoked: (() => void) | null = null;
    #workspaceEnvelopes = new Map<string, ClientEnvelope>();
    #threadWorkers = new Map<string, Promise<number>>();
    #workspaceAcquisitions = new Map<string, Promise<void>>();
    #actions = new Map<string, RegisteredAction>();
    #activated = false;
    #stopped = false;
    readonly #builtins = new BuiltinActions({ seam: () => this.#seam, capabilities: this.#capabilities.bind(this), namedWorkspace: this.#namedWorkspace.bind(this), threadWorker: this.#threadWorker.bind(this), requireWorkspace: Module.#requireWorkspace });
    readonly #runs = new RunHandler({ seam: () => this.#seam, opts: () => this.#opts, portal: () => this.#portal, requiresWorkspace: this.#requiresWorkspace.bind(this), controlRun: this.#controlRun.bind(this), envelope: this.#envelope.bind(this), conversation: this.#conversation.bind(this), boundWorker: this.#boundWorker.bind(this), actionBinding: this.#actionBinding.bind(this), workerStatus: this.#workerStatus.bind(this), action: this.#action.bind(this) });

    private constructor(opts: ModuleOptions) {
        this.#opts = resolveModuleOptions(opts);
        this.mounts = Object.freeze(this.#opts.authenticates
            ? ["/agui", "/oauth", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"]
            : ["/agui"]);
    }

    // {§agui-oauth-endpoints} — the issuer: the configured public origin, else the origin the request
    // reached this daemon at, else, with no request in hand, the listener's own ({§http-request-origin}).
    // The host binds its listener before any module sets up ({§http-host}), so the face published at
    // setup answers from publication.
    #issuer(req: RequestHeaders = { headers: {} }): string {
        return this.#opts.issuer.length > 0 ? this.#opts.issuer : requestOrigin(req, this.#listener());
    }

    // {§agui-configuration} — the module reads its settings from the assembled environment;
    // explicit options override them.
    static create(opts: ModuleOptions = {}): Module {
        return new Module(opts);
    }

    #registerActions(): void {
        for (const [name, contract] of Object.entries(AGUI_BUILTIN_ACTIONS)) {
            this.#actions.set(name, {
                ...contract,
                execute: (params, input, env, boundWorkerId, principal, onLoop) =>
                    this.#builtins.executeBuiltin(name, params, input, env, boundWorkerId, principal, onLoop),
            });
        }
        for (const descriptor of this.#seam.listModuleActions()) {
            const { name, scope, inputSchema, outputSchema } = descriptor;
            if (this.#actions.has(name)) throw new Error(`AG-UI action '${name}' is registered more than once`);
            if (scope !== "daemon" && scope !== "workspace" && scope !== "worker") {
                throw new Error(`module action '${name}' has invalid scope '${String(scope)}'`);
            }
            this.#actions.set(name, {
                scope,
                inputSchema,
                outputSchema,
                execute: async (params, _input, env, boundWorkerId) => {
                    if (scope === "daemon") {
                        return {
                            ok: true,
                            result: await this.#seam.invokeModuleAction(name, params, { scope }),
                        };
                    }
                    const { workspaceId } = Module.#requireWorkspace(name, env);
                    if (scope === "workspace") {
                        return {
                            ok: true,
                            result: await this.#seam.invokeModuleAction(name, params, { scope, workspaceId }),
                        };
                    }
                    if (boundWorkerId === undefined) throw new Error(`worker action '${name}' reached execution without its worker`);
                    return {
                        ok: true,
                        result: await this.#seam.invokeModuleAction(name, params, { scope, workspaceId, workerId: boundWorkerId }),
                    };
                },
            });
        }
    }

    // {§agui-action-binding} An action the module does not register, or whose input its schema refuses, binds
    // nothing and creates nothing: like a daemon one, it is answered on the control path.
    #requiresWorkspace({ kind, params }: ActionRequest): boolean {
        const action = this.#actions.get(kind);
        return action !== undefined && action.scope !== "daemon"
            && Validator.validateJsonSchemaInstance(action.inputSchema, params).valid;
    }

    static #requireWorkspace(kind: string, env: ClientEnvelope | null): ClientEnvelope {
        if (env === null) throw new Error(`action '${kind}' operates within a workspace, but none is bound`);
        return env;
    }

    async setup(seam: AguiSetupSeam): Promise<void> {
        await seam.registerScheme("agui", new MessageScheme("agui"));
        this.#listener = () => seam.httpAddress();
        // {§agui-oauth} — under PLURNK_AUTH=1 the face says so to every mounted resource before any
        // module starts ({§module-phases}); the daemon refuses to run authenticating without one.
        if (this.#opts.authenticates) seam.credentials.publish({ issuer: (req) => this.#issuer(req) });
    }

    // {§agui-listener-admission} — the host admits traffic after every module has started.
    async start(seam: AguiPort): Promise<void> {
        if (this.#stopped) throw new Error("plurnk-agui: stopped module cannot be activated");
        if (this.#activated) throw new Error("plurnk-agui: module already activated");
        seam.registerHttpRoute("/agui", (req, res) => this.#route(req, res));
        this.#seam = seam;
        this.#listener = () => seam.httpAddress();
        this.#registerActions();
        this.#portal = new Portal(seam);
        this.#portal.start();
        if (this.#opts.authenticates) {
            // {§agui-oauth} — the authority's issuing face mounts beside the resource it protects.
            this.#oauth = new OAuthServer({ credentials: seam.credentials, opts: this.#opts, issuer: (req) => this.#issuer(req) });
            for (const prefix of this.mounts) {
                if (prefix !== "/agui") seam.registerHttpRoute(prefix, (req, res) => this.#oauthRoute(req, res));
            }
            // {§agui-oauth-revocation} — a revoked family's open Runs end; their loops continue.
            this.#offRevoked = seam.credentials.onRevoked((family) =>
                this.#portal.failFamily(family, runErrorEvents(credentialRevokedProblem())));
        }
        this.#activated = true;
    }

    stop(): void {
        this.#stopped = true;
    }

    close(): void {
        this.stop();
        if (!this.#activated) return;
        this.#activated = false;
        this.#offRevoked?.();
        this.#portal.stop();
    }

    async #oauthRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (this.#stopped) {
            writeHttpProblem(res, serviceStoppingProblem());
            return;
        }
        if (this.#opts.allowOrigin.length > 0) {
            res.setHeader("access-control-allow-origin", this.#opts.allowOrigin);
            res.setHeader("access-control-allow-headers", "content-type, authorization");
        }
        if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
        if (this.#oauth === null || !(await this.#oauth.handle(req, res))) {
            writeHttpProblem(res, httpProblem("route-not-found", 404, "The requested HTTP route does not exist.", {
                method: req.method ?? null, path: req.url ?? null, stage: "routing", retryable: false,
            }));
        }
    }

    async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (this.#stopped) {
            writeHttpProblem(res, serviceStoppingProblem());
            return;
        }
        return observed( // {§observability-boundary} — only a bounded route class leaves the perimeter.
            "agui.http",
            { route: aguiRouteTemplate(req.method, req.url) },
            (): Promise<void> => this.#routeSettled(req, res),
        );
    }

    async #routeSettled(req: IncomingMessage, res: ServerResponse): Promise<void> {
        try {
            // {§agui-cors} — which pages may read a reply is the panel's; none at all when it says nothing.
            if (this.#opts.allowOrigin.length > 0) {
                res.setHeader("access-control-allow-origin", this.#opts.allowOrigin);
                res.setHeader("access-control-allow-headers", "content-type, authorization");
            }
            if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
            // The perimeter ({§agui-http-authorization}): bearer admission before any body read.
            let principal = "anonymous";
            let family: string | null = null;
            if (this.#oauth !== null) {
                const admission = this.#oauth.admit(req, "agui");
                if (!admission.ok) {
                    res.setHeader("www-authenticate", admission.challenge);
                    writeHttpProblem(res, admission.problem);
                    return;
                }
                ({ principal, family } = admission);
            }
            if (req.method === "POST" && req.url === "/agui") return await this.#runs.run(req, res, false, principal, family);
            if (req.method === "POST" && req.url === "/agui/connect") return await this.#runs.run(req, res, true, principal, family);
            writeHttpProblem(res, httpProblem("route-not-found", 404, "The requested HTTP route does not exist.", {
                method: req.method ?? null,
                path: req.url ?? null,
                stage: "routing",
                retryable: false,
            }));
        } catch (err) {
            const exactProblem = Problems.fromError(err);
            if (exactProblem === null) {
                console.error("AG-UI request failed:", err);
            }
            const problem = exactProblem ?? httpProblem(
                "request-failed",
                500,
                "The AG-UI request failed unexpectedly.",
                {
                    stage: "request",
                    retryable: false,
                },
            );
            if (!res.headersSent) {
                writeHttpProblem(res, problem);
                return;
            }
            // {§agui-http-failure} The SSE is already open, so a JSON body is
            // invisible to the event parser. Preserve a contract Problem exactly when
            // one exists; unexpected exceptions become one generic boundary failure.
            for (const event of runErrorEvents(problem)) {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
            }
            res.end();
        }
    }

    // {§agui-thread-binding} Opaque references, qualified IDs, and explicit workspace selection.
    async #envelope(threadId: string, forwarded?: Record<string, unknown>, options: { readonly create?: boolean; readonly worker?: boolean } = {}): Promise<{ env: ClientEnvelope; reattached: boolean }> {
        const qualified = ThreadAddress.parse(threadId);
        if (qualified !== null) return { env: await this.#seam.attachWorkspace(qualified), reattached: true };
        const workspace = forwarded?.workspace;
        if (workspace === undefined) {
            const reference = { namespace: "agui", reference: threadId };
            const binding = options.worker === true
                ? await this.#seam.ensureWorkerReference(reference)
                : await this.#seam.readWorkerReference(reference);
            if (binding === null) throw new HttpProblemError(httpProblem("thread-not-found", 404,
                "The thread has no conversation.", { threadId, stage: "request-validation", retryable: false }));
            return { env: await this.#seam.attachWorkspace(binding), reattached: true };
        }
        if (typeof workspace !== "string" || workspace.length === 0) {
            throw new HttpProblemError(httpProblem(
                "workspace-required",
                400,
                "forwardedProps.plurnk.workspace must name a workspace.",
                {
                    stage: "request-validation",
                    recovery: "Provide a non-empty workspace name.",
                    retryable: false,
                },
            ));
        }
        return await this.#namedWorkspace(workspace, forwarded, options);
    }

    // {§agui-thread-binding} Workspace labels are selected literally, never parsed as thread addresses.
    async #namedWorkspace(workspace: string, forwarded?: Readonly<Record<string, unknown>>, options: { readonly create?: boolean } = {}): Promise<{ env: ClientEnvelope; reattached: boolean }> {
        const cached = await this.#currentEnvelope(workspace);
        if (cached !== undefined) return { env: cached, reattached: true };
        const previous = this.#workspaceAcquisitions.get(workspace);
        const acquisition = Promise.withResolvers<void>();
        this.#workspaceAcquisitions.set(workspace, acquisition.promise);
        try {
            await previous;
            const acquired = await this.#currentEnvelope(workspace);
            if (acquired !== undefined) return { env: acquired, reattached: true };
            const result = await this.#openWorkspace(workspace, forwarded, options);
            this.#workspaceEnvelopes.set(workspace, result.env);
            return result;
        } finally {
            acquisition.resolve();
            if (this.#workspaceAcquisitions.get(workspace) === acquisition.promise) this.#workspaceAcquisitions.delete(workspace);
        }
    }

    // {§agui-thread-binding} A rename retires name selection; stable thread addresses do not use this cache.
    async #currentEnvelope(workspace: string): Promise<ClientEnvelope | undefined> {
        const cached = this.#workspaceEnvelopes.get(workspace);
        if (cached === undefined) return undefined;
        const current = (await this.#seam.listWorkspaces()).find(({ id }) => id === cached.workspaceId);
        if (current?.name === workspace) return cached;
        this.#workspaceEnvelopes.delete(workspace);
        return undefined;
    }

    async #openWorkspace(workspace: string, forwarded: Readonly<Record<string, unknown>> | undefined, options: { readonly create?: boolean }): Promise<{ env: ClientEnvelope; reattached: boolean }> {
        const known = (await this.#seam.listWorkspaces()).find((s) => s.name === workspace);
        let env: ClientEnvelope;
        let reattached = false;
        if (known !== undefined) {
            env = await this.#seam.attachWorkspace({ workspaceId: known.id });
            reattached = true;
        } else if (options.create === false) {
            // {§agui-action-binding} — a Run that attaches only addresses a workspace that exists; a name that
            // does not is the client's error, never a workspace minted on its behalf.
            throw new HttpProblemError(httpProblem(
                "workspace-not-found",
                404,
                `No workspace named ${JSON.stringify(workspace)} exists.`,
                {
                    stage: "request-validation",
                    workspace,
                    recovery: "Name the existing workspace in forwardedProps.plurnk.workspace, or create it with workspace.create or a message Run.",
                    retryable: false,
                },
            ));
        } else {
            const opts = forwarded ?? {};
            env = await this.#seam.createWorkspace({
                name: workspace,
                ...(Object.hasOwn(opts, "projectRoot")
                    ? { projectRoot: opts.projectRoot as string | null }
                    : {}),
                ...(Object.hasOwn(opts, "constraints")
                    ? { constraints: opts.constraints as Array<{ effect: string; glob: string }> }
                    : {}),
                ...(Object.hasOwn(opts, "settings")
                    ? { settings: opts.settings as string | object }
                    : {}),
            });
        }
        return { env, reattached };
    }

    // {§agui-thread-binding} {§agui-action-binding} — the threadId names its worker by its immutable name,
    // never compared with the workspace's; only an act addressed to the worker creates it, and every other
    // binding requires it. Cached per workspace identity and threadId: worker names are immutable, so a
    // binding never rots. Durable capability changes use workspace.capabilities.set; approval ownership is
    // durable in Core.
    async #boundWorker(threadId: string, env: ClientEnvelope, binding: "create" | "required", forwarded?: Record<string, unknown>): Promise<number> {
        const qualified = ThreadAddress.parse(threadId);
        if (qualified === null && forwarded?.workspace === undefined) {
            const reference = await this.#seam.readWorkerReference({ namespace: "agui", reference: threadId });
            if (reference === null || reference.workspaceId !== env.workspaceId) throw new Error("Thread reference is absent from its resolved workspace.");
            return reference.workerId;
        }
        const workerName = qualified?.workerName ?? threadId;
        const key = JSON.stringify([env.workspaceId, workerName]);
        const cached = this.#threadWorkers.get(key);
        if (cached !== undefined) return await cached;
        if (binding === "required") {
            const id = await this.#modelWorker(workerName, env.workspaceId);
            if (id === undefined) {
                throw new HttpProblemError(httpProblem("worker-not-found", 404,
                    `No model worker named ${JSON.stringify(workerName)} exists in workspace ${JSON.stringify(env.workspaceName)}.`, {
                        stage: "request-validation", workspace: env.workspaceName, worker: threadId,
                        recovery: "Name an existing model worker, or create one by sending it a message.", retryable: false,
                    }));
            }
            this.#threadWorkers.set(key, Promise.resolve(id));
            return id;
        }
        const pending = (async () => await this.#modelWorker(workerName, env.workspaceId)
            ?? (await this.#seam.createWorker({ workspaceId: env.workspaceId, name: workerName })).workerId)();
        this.#threadWorkers.set(key, pending);
        try { return await pending; }
        catch (cause) {
            this.#threadWorkers.delete(key);
            throw cause;
        }
    }

    // {§agui-thread-binding} The model worker the thread resolves to, when it exists; reading creates nothing. It is
    // also the worker a person's client operation acts for ({§actor-boundary-client-operations}).
    async #threadWorker(threadId: string, workspaceId: number, forwarded?: Record<string, unknown>): Promise<number | undefined> {
        const qualified = ThreadAddress.parse(threadId);
        if (qualified !== null && qualified.workspaceId !== workspaceId) return undefined;
        if (qualified === null && forwarded?.workspace === undefined) {
            const reference = await this.#seam.readWorkerReference({ namespace: "agui", reference: threadId });
            return reference?.workspaceId === workspaceId ? reference.workerId : undefined;
        }
        return this.#modelWorker(qualified?.workerName ?? threadId, workspaceId);
    }

    async #modelWorker(name: string, workspaceId: number): Promise<number | undefined> {
        const worker = await this.#seam.readWorker({ workspaceId, identity: { name } });
        return worker?.origin === "model" ? worker.id : undefined;
    }

    // {§agui-run-input} Resolve retained identity without creating a conversation or claiming its owner.
    async #conversation(threadId: string, forwarded?: Record<string, unknown>): Promise<{ workspaceId: number; workerId: number } | null> {
        const qualified = ThreadAddress.parse(threadId);
        if (qualified !== null) {
            const workerId = await this.#threadWorker(threadId, qualified.workspaceId, forwarded);
            return workerId === undefined ? null : { workspaceId: qualified.workspaceId, workerId };
        }
        const workspaceName = forwarded?.workspace;
        if (workspaceName === undefined) return this.#seam.readWorkerReference({ namespace: "agui", reference: threadId });
        if (typeof workspaceName !== "string") return null;
        const workspace = (await this.#seam.listWorkspaces()).find(({ name }) => name === workspaceName);
        if (workspace === undefined) return null;
        const workerId = await this.#threadWorker(threadId, workspace.id, forwarded);
        return workerId === undefined ? null : { workspaceId: workspace.id, workerId };
    }

    // {§agui-action-binding} — what an action binds of the thread's worker. Reached only for a registered
    // action whose input its schema admits: any other is answered on the control path.
    #actionBinding({ kind, params }: ActionRequest): WorkerBinding {
        const action = this.#actions.get(kind)!;
        if (WORKER_CREATING_ACTIONS.has(kind)) return "create";
        if (WORKER_READING_ACTIONS.has(kind)) return typeof params.workerId === "number" ? "attach" : "required";
        if (WORKER_ACTIONS.has(kind)) return "required";
        return action.scope === "worker" ? "required" : "none";
    }

    async #workerStatus(workspaceId: number, workerId: number): Promise<AguiStatusState> {
        const [{ model }, loops, children] = await Promise.all([
            this.#seam.readWorkerModel({ workspaceId, workerId }),
            this.#seam.listWorkerLoops({ workspaceId, workerId }),
            this.#seam.listWorkers(workspaceId, { parentWorkerId: workerId }),
        ]);
        const loop = selectWorkerLoop(loops);
        const spend = await this.#seam.workerAccounting({ workspaceId, workerId });
        return statusState(model, loop, spendState(spend), aliveChildren(children));
    }

    // A control-plane AG-UI Run: no workspace bound. Open the SSE, execute the daemon verb, answer on
    // our own stream. No Portal thread, no model worker, and no ephemeral workspace.
    async #controlRun(action: ActionRequest, input: RunAgentInput, res: ServerResponse, principal: string): Promise<void> {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" });
        const emit = (e: AguiEvent): void => { res.write(`data: ${JSON.stringify(e)}\n\n`); };
        emit({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
        if (action.kind === "discover") {
            for (const notice of this.#seam.configurationNotices()) {
                emit({ type: EventType.CUSTOM, name: "plurnk.notice", value: notice });
            }
        }
        const outcome = await this.#action(action, input, null, undefined, principal, undefined)
            .catch((err: unknown): ActionOutcome => {
                console.error(`AG-UI action '${action.kind}' failed:`, err);
                const problem = Problems.fromError(err);
                return problem === null
                    ? actionFailure("action-failed", "The action failed unexpectedly.", 500)
                    : { ok: false, problem };
            });
        emit({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId, outcome: { type: "success" }, result: actionRunResult(action.kind, outcome) });
        res.end();
    }

    // Discovery is a projection of the executable registry, not a second inventory.
    async #capabilities(): Promise<AguiDiscovery> {
        const actions = Object.fromEntries([...this.#actions].map(([name, action]) => [
            name,
            {
                scope: action.scope,
                inputSchema: action.inputSchema,
                outputSchema: action.outputSchema,
            },
        ]));
        const display = Validator.assertClientDisplayCapabilities(
            await this.#seam.listClientDisplayCapabilities(),
        );
        return Validator.assertAguiDiscovery({
            schemaVersion: 1,
            actions,
            notifications: AGUI_NOTIFICATIONS,
            display,
        });
    }

    async #action(a: ActionRequest, input: RunAgentInput, env: ClientEnvelope | null, boundWorkerId: number | undefined, principal: string, onLoop: OperationLoopListener | undefined): Promise<ActionOutcome> {
        const action = this.#actions.get(a.kind);
        if (action === undefined) {
            return actionFailure(
                "unknown-action",
                `Action '${a.kind}' is not registered.`,
                404,
                {
                    requestedAction: a.kind,
                    recovery: "Use an action advertised by discover.",
                },
            );
        }
        const admitted = Validator.validateJsonSchemaInstance(action.inputSchema, a.params);
        if (!admitted.valid) {
            const details = admitted.errors
                .filter((error) => !admitted.errors.some((other) => other.keywordLocation.startsWith(`${error.keywordLocation}/`)))
                .map(({ instanceLocation, error }) => `${instanceLocation}: ${error}`)
                .join(" ");
            return actionFailure(
                "invalid-action-parameters",
                `Action '${a.kind}' rejected parameters. ${details}`,
                400,
                {
                    issues: admitted.errors,
                },
            );
        }
        try {
            if (action.scope !== "daemon") Module.#requireWorkspace(a.kind, env);
            const outcome = await action.execute(a.params, input, env, boundWorkerId, principal, onLoop);
            if (!outcome.ok) return outcome;
            const projected = Validator.validateJsonSchemaInstance(action.outputSchema, outcome.result);
            if (!projected.valid) {
                throw new Error(
                    `AG-UI action '${a.kind}' produced output outside its advertised schema: ${JSON.stringify(projected.errors)}`,
                );
            }
            return outcome;
        } catch (err) {
            const problem = Problems.fromError(err);
            if (problem !== null) return { ok: false, problem };
            console.error(`AG-UI action '${a.kind}' failed:`, err);
            return actionFailure("action-failed", "The action failed unexpectedly.", 500);
        }
    }

}
