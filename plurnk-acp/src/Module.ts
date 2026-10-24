// {§acp-daemon-client} {§acp-daemon-module} The daemon's ACP v2 client interface, a discovered module: it claims
// `/acp` on the daemon's one listener ({§module-http-mounts}), mounts HTTP, SSE, and WebSocket upgrade
// handlers at start, and owns no socket of its own.
//
// This is the single external client interface:
//   POST /acp — a Run or JSON-RPC 2.0 call; POST /acp/connect — an observer that also waits while idle;
//   WS /acp — bidirectional JSON-RPC 2.0 session transport.
//   A worker streams SSE or session updates. HITL is terminate-resume on Run streams (and server->client
//   requests on WebSocket sessions): a stopped-world presents the call it gates (the operation's own,
//   or a client interaction's) and finishes with an ACP interrupt outcome (the loop stays paused in-engine);
//   the next ACP Run's standard resume entries resolve the durable gate and continue the exact loop.
//   Reads ride STATE_SNAPSHOT on RUN_STARTED; there are no side-channel action
//   or proposal-resolution endpoints.
// A thread resolves to a model worker through {§acp-thread-binding}; core retains
// opaque external references, while this adapter interprets qualified addresses.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import Portal, { type PortalPort } from "./Portal.ts";
import Overview from "./Overview.ts";
import { descendantsState, inboxState, spendState, statusState, actionRunResult, type ActionRequest, type ActionOutcome, type AcpWorkerGauge } from "./AcpPlus.ts";
import { EventType, type AcpEvent, type RunAgentInput } from "./types.ts";
import { ENTRY_ROUTE, HISTORY_ROUTE, acpRouteTemplate, observed } from "./observe.ts";
import {
    APPLICATION_NOTIFICATIONS,
    Problems,
    UNKNOWN_POSITION,
    Validator,
    excerptOf,
    isRecord,
    isSafeInteger,
    lifecycleOfLoopStatus,
    requestOrigin,
    selectWorkerLoop,
    withoutBodies,
    type AcpDiscovery,
    type ApplicationNotificationContract,
    type ClientEnvelope,
    type ClientInteractionProjection,
    type ClientInteractionResolution,
    type ExecStatement,
    type OperationResult,
    type PlurnkStatement,
    type ProblemDetails,
    type ProposalDecision,
    type ProposalProjection,
    type RequestHeaders,
    type TerminatedNotification,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { ACP_BUILTIN_ACTIONS, ACP_NOTIFICATIONS, type AcpActionContract } from "./AcpSurface.ts";
import { resolveModuleOptions, type ModuleOptions, type ResolvedModuleOptions } from "./config.ts";
import { HttpProblemError, actionFailure } from "./action-results.ts";
import BuiltinActions, { type BuiltinActionsPort, type OperationLoopListener } from "./BuiltinActions.ts";
import { credentialRevokedProblem, httpProblem, runErrorEvents, serviceStoppingProblem } from "./run-events.ts";
import RunHandler, { forwardedRefusal, type RunPort, type WorkerBinding } from "./RunHandler.ts";
import ThreadAddress from "./ThreadAddress.ts";
import MessageAddress from "./MessageAddress.ts";
import SessionAddress, { acpProblem } from "./SessionAddress.ts";
import SessionTranslator, { type AcpSessionUpdate } from "./SessionTranslator.ts";
import WebSocketConnection from "./WebSocketConnection.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { MessageScheme } from "@plurnk/plurnk-schemes";
import type { SchemeRegistrationSeam } from "@plurnk/plurnk-schemes";
import type { DaemonModule } from "@plurnk/plurnk-modules";

export type { ModuleOptions } from "./config.ts";

// The creation fields a Run forwards, typed as the daemon's creation contract types them; the daemon judges their sense.
const forwardedProjectRoot = (value: unknown): string | null => {
    if (typeof value !== "string" && value !== null) throw forwardedRefusal("projectRoot", "a string or null");
    return value;
};
const forwardedSettings = (value: unknown): string | Readonly<Record<string, unknown>> => {
    if (typeof value !== "string" && !isRecord(value)) throw forwardedRefusal("settings", "a string or an object");
    return value;
};

// {§module-seam-slices} — the start seam: the calls the module makes itself, and each
// collaborator's slice.
export type AcpPort = Pick<
    ApplicationPort,
    | "attachWorkspace"
    | "configurationNotices"
    | "credentials"
    | "createWorker"
    | "createWorkspace"
    | "workerAccounting"
    | "workerGauge"
    | "httpAddress"
    | "invokeModuleAction"
    | "listClientDisplayCapabilities"
    | "listModuleActions"
    | "listWorkerLoops"
    | "listWorkers"
    | "listWorkspaces"
    | "readEntryChannel"
    | "readInbox"
    | "readStreams"
    | "readWorker"
    | "readWorkerOverview"
    | "readWorkerReference"
    | "ensureWorkerReference"
    | "readWorkerModel"
    | "registerHttpRoute"
    | "workspaceDerivationStatus"
    | "workspacePreparationStatus"
> & Partial<Pick<ApplicationPort, "registerHttpUpgrade">> & PortalPort & BuiltinActionsPort & RunPort;

const writeHttpProblem = (res: ServerResponse, problem: ProblemDetails): void => {
    res.writeHead(problem.status, { "content-type": "application/problem+json" });
    res.end(JSON.stringify(problem));
};

type ActionExecutor = (
    params: Readonly<Record<string, unknown>>,
    input: RunAgentInput,
    env: ClientEnvelope | null,
    boundWorkerId: number | undefined,
    onLoop: OperationLoopListener | undefined,
) => Promise<ActionOutcome>;

interface RegisteredAction extends AcpActionContract {
    readonly execute: ActionExecutor;
}

export type AcpSetupSeam = SchemeRegistrationSeam & Pick<ApplicationPort, "httpAddress">;

interface BoundSession {
    readonly sessionId: string;
    readonly workspaceId: number;
    readonly workerId: number;
    readonly workerName: string;
    readonly translator: SessionTranslator;
}

interface PendingRpcGate {
    readonly kind: "proposal" | "interaction";
    readonly workspaceId: number;
    readonly targetId: number;
}

interface AcpPeer {
    readonly family: string | null;
    readonly origin: string;
    readonly sessions: Map<string, BoundSession>;
    readonly pendingGates: Map<string | number, PendingRpcGate>;
    sendNotification(method: string, params: unknown): void;
    sendRequest(id: string, method: string, params: unknown, gate: PendingRpcGate): void;
    closeWithProblem(problem: ProblemDetails): void;
}

interface LoopWaiter {
    readonly workspaceId: number;
    readonly workerId: number;
    readonly loopId: number;
    readonly resolve: (terminated: TerminatedNotification) => void;
    readonly reject: (problem: ProblemDetails) => void;
}

// {§acp-action-binding} The actions addressed to the thread's worker: those that set its durable
// policy create it, the rest require it, and those that take an explicit `workerId` require it only
// without one. A workspace action that would act on nothing in a workspace it created attaches only.
const WORKER_CREATING_ACTIONS: ReadonlySet<string> = new Set([
    "worker.model.set",
    "worker.child.set",
    "worker.effort.set",
    "worker.env.add",
    "worker.env.replace",
]);
const WORKER_ACTIONS: ReadonlySet<string> = new Set(["loop.inject", "loop.cancel", "run.fork", "worker.model.get", "worker.effort.get"]);
const WORKER_NAMING_ACTIONS: ReadonlySet<string> = new Set([
    "log.read", "entry.read", "workspace.prompts", "workspace.rollback", "worker.loops", "worker.hidden.set",
]);
const WORKSPACE_ATTACHING_ACTIONS: ReadonlySet<string> = new Set(["workspace.hidden.set"]);

export default class Module implements DaemonModule<AcpSetupSeam, AcpPort> {
    // {§module-http-mounts} — the client protocol owns its own prefix.
    readonly mounts: readonly string[] = Object.freeze(["/acp"]);
    #seam!: AcpPort;
    #listener!: AcpSetupSeam["httpAddress"];
    readonly #opts: ResolvedModuleOptions;
    #portal!: Portal;
    #offEvents: (() => void) | null = null;
    #offRevoked: (() => void) | null = null;
    #workspaceEnvelopes = new Map<string, ClientEnvelope>();
    #threadWorkers = new Map<string, Promise<number>>();
    #workspaceAcquisitions = new Map<string, Promise<void>>();
    #actions = new Map<string, RegisteredAction>();
    readonly #peers = new Set<AcpPeer>();
    readonly #loopWaiters = new Set<LoopWaiter>();
    #nextServerRequestId = 1;
    #activated = false;
    #stopped = false;
    // {§acp-shutdown} The requests this module admitted and the work they and its Runs started: each may reach core
    // until it settles.
    readonly #work = new Set<Promise<unknown>>();
    readonly #builtins = new BuiltinActions({ seam: () => this.#seam, capabilities: this.#capabilities.bind(this), namedWorkspace: this.#namedWorkspace.bind(this), threadWorker: this.#threadWorker.bind(this), requireWorkspace: Module.#requireWorkspace, excerptChars: () => this.#opts.excerptChars });
    // {§acp-overview} The worker overview's observations.
    readonly #overview = new Overview({
        seam: () => this.#seam,
        bounds: () => ({ limit: this.#opts.overviewWorkers, excerptChars: this.#opts.excerptChars, heartbeatMs: this.#opts.heartbeatMs }),
        track: this.#track.bind(this),
    });
    readonly #runs = new RunHandler({ seam: () => this.#seam, opts: () => this.#opts, portal: () => this.#portal, stopping: () => this.#stopped, requiresWorkspace: this.#requiresWorkspace.bind(this), controlRun: this.#controlRun.bind(this), envelope: this.#envelope.bind(this), conversation: this.#conversation.bind(this), boundWorker: this.#boundWorker.bind(this), actionBinding: this.#actionBinding.bind(this), workerGauge: this.#workerGauge.bind(this), action: this.#action.bind(this), origin: (req) => this.#origin(req), track: this.#track.bind(this), overview: () => this.#overview });

    private constructor(opts: ModuleOptions) {
        this.#opts = resolveModuleOptions(opts);
    }

    // {§http-request-origin} — the authority's issuer when published, else the origin the request
    // reached this daemon at, else, with no request in hand, the listener's own.
    #origin(req: RequestHeaders = { headers: {} }): string {
        return this.#seam.credentials.face()?.issuer(req) ?? requestOrigin(req, this.#listener());
    }

    // {§acp-configuration} — the module reads its settings from the assembled environment;
    // explicit options override them.
    static create(opts: ModuleOptions = {}): Module {
        return new Module(opts);
    }

    #registerActions(): void {
        for (const [name, contract] of Object.entries(ACP_BUILTIN_ACTIONS)) {
            this.#actions.set(name, {
                ...contract,
                execute: (params, input, env, boundWorkerId, onLoop) =>
                    this.#builtins.executeBuiltin(name, params, input, env, boundWorkerId, onLoop),
            });
        }
        for (const descriptor of this.#seam.listModuleActions()) {
            const { name, scope, inputSchema, outputSchema } = descriptor;
            if (this.#actions.has(name)) throw new Error(`ACP action '${name}' is registered more than once`);
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

    // {§acp-action-binding} An action the module does not register, or whose input its schema refuses, binds
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

    async setup(seam: AcpSetupSeam): Promise<void> {
        await seam.registerScheme("acp", new MessageScheme("acp"));
        this.#listener = () => seam.httpAddress();
    }

    // {§acp-listener-admission} — the host admits traffic after every module has started.
    async start(seam: AcpPort): Promise<void> {
        if (this.#stopped) throw new Error("plurnk-acp: stopped module cannot be activated");
        if (this.#activated) throw new Error("plurnk-acp: module already activated");
        seam.registerHttpRoute("/acp", (req, res) => this.#route(req, res));
        seam.registerHttpUpgrade?.("/acp", (req, socket, head) => this.#track(this.#handleUpgrade(req, socket, head)));
        this.#seam = seam;
        this.#listener = () => seam.httpAddress();
        this.#registerActions();
        this.#portal = new Portal(seam, { loops: this.#opts.historyLoops, chars: this.#opts.historyPageChars }, this.#track.bind(this));
        this.#portal.start();
        this.#overview.start();
        this.#offEvents = seam.subscribeToEvents((workspaceId, method, params) => {
            this.#onDaemonEvent(workspaceId, method, params);
        });
        // {§acp-oauth-revocation} — a revoked family's open Runs end; their loops continue.
        this.#offRevoked = seam.credentials.onRevoked((family) => {
            const problem = credentialRevokedProblem();
            this.#portal.failFamily(family, runErrorEvents(problem));
            this.#overview.failFamily(family, runErrorEvents(problem));
            for (const peer of [...this.#peers]) {
                if (peer.family === family) {
                    peer.closeWithProblem(problem);
                    this.#peers.delete(peer);
                }
            }
        });
        this.#activated = true;
    }

    stop(): void {
        this.#stopped = true;
    }

    // {§acp-shutdown} Every remaining Run ends, then what the module admitted settles: after close the host releases the
    // database, so nothing the module started reaches core afterward.
    async close(): Promise<void> {
        this.stop();
        if (!this.#activated) return;
        this.#activated = false;
        this.#offEvents?.();
        this.#offRevoked?.();
        const stopping = serviceStoppingProblem();
        this.#portal.stop();
        this.#overview.stop(runErrorEvents(stopping));
        for (const waiter of [...this.#loopWaiters]) {
            this.#loopWaiters.delete(waiter);
            waiter.reject(stopping);
        }
        for (const peer of [...this.#peers]) {
            this.#peers.delete(peer);
            peer.closeWithProblem(stopping);
        }
        while (this.#work.size > 0) await Promise.allSettled([...this.#work]);
    }

    #track<T>(work: Promise<T>): Promise<T> {
        this.#work.add(work);
        const settled = (): void => { this.#work.delete(work); };
        void work.then(settled, settled);
        return work;
    }

    // {§acp-http-authorization} — bearer admission for the ACP resource (RFC 6750 §3).
    #admit(req: IncomingMessage, issuer: string, allowQueryToken = false):
        | { readonly ok: true; readonly family: string }
        | { readonly ok: false; readonly problem: ProblemDetails; readonly challenge: string } {
        const header = req.headers.authorization;
        const challenge = (parameters: string): string => `Bearer realm="plurnk"${parameters}, resource_metadata="${issuer}/.well-known/oauth-protected-resource"`;
        let presented = header === undefined ? null : /^Bearer(?:\s+(.*))?$/iu.exec(header);
        if (presented === null && allowQueryToken) {
            const url = new URL(req.url ?? "/acp", "http://listener");
            const queryToken = url.searchParams.get("access_token");
            if (queryToken !== null) presented = /^Bearer(?:\s+(.*))?$/iu.exec(`Bearer ${queryToken}`);
        }
        if (presented === null) {
            return {
                ok: false,
                challenge: challenge(""),
                problem: httpProblem("bearer-token-required", 401, "The request did not provide a bearer token.", {
                    stage: "authorization", recovery: "Present an access token issued by this daemon as `Authorization: Bearer <token>`.", retryable: false,
                }),
            };
        }
        const token = (presented[1] ?? "").trim();
        const claims = this.#seam.credentials.verify(token);
        if (claims === null || claims.kind !== "access") {
            return {
                ok: false,
                challenge: challenge(', error="invalid_token", error_description="The access token is unknown, expired or revoked."'),
                problem: httpProblem("bearer-token-invalid", 401, "The access token is unknown, expired or revoked.", {
                    stage: "authorization", recovery: "Obtain a new access token from this daemon's token endpoint.", retryable: false,
                }),
            };
        }
        if (!claims.scopes.includes("acp")) {
            return {
                ok: false,
                challenge: challenge(', error="insufficient_scope", scope="acp"'),
                problem: httpProblem("bearer-scope-insufficient", 403, "The access token does not carry the scope acp.", {
                    stage: "authorization", scope: "acp", recovery: "Obtain an access token with the scope acp.", retryable: false,
                }),
            };
        }
        return { ok: true, family: claims.family };
    }

    async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (this.#stopped) {
            writeHttpProblem(res, serviceStoppingProblem());
            return;
        }
        return this.#track(observed( // {§observability-boundary} — only a bounded route class leaves the perimeter.
            "acp.http",
            { route: acpRouteTemplate(req.method, req.url) },
            (): Promise<void> => this.#routeSettled(req, res),
        ));
    }

    async #routeSettled(req: IncomingMessage, res: ServerResponse): Promise<void> {
        try {
            // {§acp-cors} — which pages may read a reply is the panel's; none at all when it says nothing.
            if (this.#opts.allowOrigin.length > 0) {
                res.setHeader("access-control-allow-origin", this.#opts.allowOrigin);
                res.setHeader("access-control-allow-headers", "content-type, authorization");
            }
            if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
            // The perimeter ({§acp-http-authorization}): bearer admission before any body read.
            let family: string | null = null;
            const face = this.#seam.credentials.face();
            if (face !== null) {
                const admission = this.#admit(req, face.issuer(req));
                if (!admission.ok) {
                    res.setHeader("www-authenticate", admission.challenge);
                    writeHttpProblem(res, admission.problem);
                    return;
                }
                ({ family } = admission);
            }
            if (req.method === "POST" && req.url === "/acp") {
                let decoded: unknown;
                try {
                    decoded = JSON.parse(await Module.#body(req));
                } catch {
                    throw new HttpProblemError(httpProblem(
                        "invalid-json",
                        400,
                        "The request body is not valid JSON.",
                        { stage: "request-validation", retryable: false },
                    ));
                }
                if (isRecord(decoded) && decoded.jsonrpc === "2.0" && typeof decoded.method === "string") {
                    return await this.#handleRpcHttp(req, res, decoded, family);
                }
                return await this.#runs.runDecoded(req, res, decoded, false, family);
            }
            if (req.method === "POST" && req.url === "/acp/connect") return await this.#runs.run(req, res, true, family);
            const entry = req.method === "GET" && req.url !== undefined ? ENTRY_ROUTE.exec(req.url) : null;
            if (entry !== null) return await this.#entry(res, entry);
            if (req.method === "GET" && (req.url === "/acp/entry" || req.url?.startsWith("/acp/entry?") === true)) {
                return await this.#queryEntry(req, res);
            }
            const history = req.method === "GET" && req.url !== undefined ? HISTORY_ROUTE.exec(req.url) : null;
            if (history !== null) return await this.#historyPage(req, res, history);
            writeHttpProblem(res, httpProblem("route-not-found", 404, "The requested HTTP route does not exist.", {
                method: req.method ?? null,
                path: req.url ?? null,
                stage: "routing",
                retryable: false,
            }));
        } catch (err) {
            const exactProblem = Problems.fromError(err);
            if (exactProblem === null) {
                console.error("ACP request failed:", err);
            }
            const problem = exactProblem ?? httpProblem(
                "request-failed",
                500,
                "The ACP request failed unexpectedly.",
                {
                    stage: "request",
                    retryable: false,
                },
            );
            if (!res.headersSent) {
                writeHttpProblem(res, problem);
                return;
            }
            // {§acp-http-failure} The SSE is already open, so a JSON body is
            // invisible to the event parser. Preserve a contract Problem exactly when
            // one exists; unexpected exceptions become one generic boundary failure.
            for (const event of runErrorEvents(problem)) {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
            }
            res.end();
        }
    }

    // {§acp-entry-route} An address at this daemon: the channel it selects, read from the worker's perspective as a client
    // entry read reads it ({§methods-entry-channel-read}), answered as its media type. The perimeter has admitted the
    // request; the daemon refuses a worker outside the workspace.
    async #entry(res: ServerResponse, [, workspace, worker, rawQuery]: RegExpExecArray): Promise<void> {
        const [workspaceId, workerId] = [workspace, worker].map(Number);
        const target = new URLSearchParams(rawQuery ?? "").get("target");
        if (target === null || target.length === 0) {
            writeHttpProblem(res, httpProblem("entry-target-required", 400, "The request names no address in `target`.", {
                workspaceId, workerId, stage: "request-validation", recovery: "Request `?target=<address>`, the address percent-encoded.", retryable: false,
            }));
            return;
        }
        const read = await this.#seam.readEntryChannel({ workspaceId, workerId, target });
        if (read.entry === null) {
            writeHttpProblem(res, read.problem);
            return;
        }
        for (const { content, mimetype } of Object.values(read.entry.channels)) {
            res.writeHead(200, { "content-type": `${mimetype}; charset=utf-8`, "cache-control": "no-store" });
            res.end(content);
        }
    }

    async #queryEntry(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? "/acp/entry", "http://listener");
        const workspaceId = Number(url.searchParams.get("workspaceId") ?? "");
        const workerId = Number(url.searchParams.get("workerId") ?? "");
        const target = url.searchParams.get("target") ?? "";
        if (!isSafeInteger(workspaceId) || workspaceId < 1 || !isSafeInteger(workerId) || workerId < 1 || target.length === 0) {
            writeHttpProblem(res, httpProblem("entry-query-invalid", 400, "workspaceId, workerId and target are required to read an entry channel.", {
                stage: "request-validation",
                retryable: false,
            }));
            return;
        }
        const read = await this.#seam.readEntryChannel({ workspaceId, workerId, target });
        if (read.entry === null) {
            writeHttpProblem(res, read.problem);
            return;
        }
        for (const { content, mimetype } of Object.values(read.entry.channels)) {
            res.writeHead(200, { "content-type": `${mimetype}; charset=utf-8`, "cache-control": "no-store" });
            res.end(content);
            return;
        }
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        res.end("");
    }

    // {§acp-history-page} A page of a worker's history, as the view its link names holds it: the loop before the cursor,
    // or the newest when it names none. The perimeter has admitted the request; the daemon refuses a worker outside the
    // workspace.
    async #historyPage(req: IncomingMessage, res: ServerResponse, [, workspace, worker, rawQuery]: RegExpExecArray): Promise<void> {
        const [workspaceId, workerId] = [workspace, worker].map(Number);
        const query = new URLSearchParams(rawQuery ?? "");
        const threadId = query.get("thread");
        if (threadId === null || threadId.length === 0) {
            writeHttpProblem(res, httpProblem("history-thread-required", 400, "A history page names the thread whose view it holds.", {
                workspaceId, workerId, stage: "request-validation", recovery: "Follow the `older` link a snapshot or page carries.", retryable: false,
            }));
            return;
        }
        // {§acp-loop-page} A loop by its number, in place of a cursor.
        const loop = query.get("loop");
        if (loop !== null && (!/^[1-9]\d*$/u.test(loop) || query.get("before") !== null)) {
            writeHttpProblem(res, httpProblem("history-loop-invalid", 400, "A loop page names one loop by its number, and no cursor.", {
                workspaceId, workerId, loop, before: query.get("before"), stage: "request-validation", recovery: "Name the loop's number as `loop`, or follow an `older` link.", retryable: false,
            }));
            return;
        }
        // The daemon refuses a worker outside the workspace as it reads the worker's log.
        const entries = await this.#runs.history(workspaceId, workerId);
        const view = {
            workspaceId, workerId, threadId, origin: this.#origin(req), replyThreads: await this.#runs.replyThreads(workspaceId, workerId, threadId),
            descendants: query.get("descendants") === "true", reasoningByLink: query.get("reasoning") === "link",
        };
        const history = (descendant: number) => this.#runs.history(workspaceId, descendant);
        const page = loop === null ? await this.#portal.page(view, query.get("before"), entries, history) : await this.#portal.loopPage(view, Number(loop), entries, history);
        if (page === null && loop !== null) {
            writeHttpProblem(res, httpProblem("history-loop-not-found", 404, "This conversation holds no loop by that number.", {
                workspaceId, workerId, loop: Number(loop), stage: "routing", recovery: "List the worker's loops with `worker.loops`.", retryable: false,
            }));
            return;
        }
        if (page === null) {
            writeHttpProblem(res, httpProblem("history-cursor-not-found", 404, "No message of this conversation holds the page's cursor.", {
                workspaceId, workerId, before: query.get("before"), stage: "routing", recovery: "Follow the `older` link a snapshot or page carries.", retryable: false,
            }));
            return;
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(page));
    }

    // {§acp-thread-binding} Opaque references, qualified IDs, and explicit workspace selection.
    async #envelope(threadId: string, forwarded?: Record<string, unknown>, options: { readonly create?: boolean; readonly worker?: boolean } = {}): Promise<{ env: ClientEnvelope; reattached: boolean }> {
        const qualified = ThreadAddress.parse(threadId);
        if (qualified !== null) return { env: await this.#seam.attachWorkspace(qualified), reattached: true };
        const workspace = forwarded?.workspace;
        if (workspace === undefined) {
            const reference = { namespace: "acp", reference: threadId };
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

    // {§acp-thread-binding} Workspace labels are selected literally, never parsed as thread addresses.
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

    // {§acp-thread-binding} A rename retires name selection; stable thread addresses do not use this cache.
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
            // {§acp-action-binding} — a Run that attaches only addresses a workspace that exists; a name that
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
                ...(Object.hasOwn(opts, "projectRoot") ? { projectRoot: forwardedProjectRoot(opts.projectRoot) } : {}),
                ...(Object.hasOwn(opts, "settings") ? { settings: forwardedSettings(opts.settings) } : {}),
            });
        }
        return { env, reattached };
    }

    // {§acp-thread-binding} {§acp-action-binding} — the threadId names its worker by its immutable name,
    // never compared with the workspace's; only an act addressed to the worker creates it, and every other
    // binding requires it. Cached per workspace identity and threadId: worker names are immutable, so a
    // binding never rots. Durable capability changes use workspace.capabilities.set; approval ownership is
    // durable in Core.
    async #boundWorker(threadId: string, env: ClientEnvelope, binding: "create" | "required", forwarded?: Record<string, unknown>): Promise<number> {
        const qualified = ThreadAddress.parse(threadId);
        if (qualified === null && forwarded?.workspace === undefined) {
            const reference = await this.#seam.readWorkerReference({ namespace: "acp", reference: threadId });
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

    // {§acp-thread-binding} The model worker the thread resolves to, when it exists; reading creates nothing. It is
    // also the worker a person's client operation acts for ({§actor-boundary-client-operations}).
    async #threadWorker(threadId: string, workspaceId: number, forwarded?: Record<string, unknown>): Promise<number | undefined> {
        const qualified = ThreadAddress.parse(threadId);
        if (qualified !== null && qualified.workspaceId !== workspaceId) return undefined;
        if (qualified === null && forwarded?.workspace === undefined) {
            const reference = await this.#seam.readWorkerReference({ namespace: "acp", reference: threadId });
            return reference?.workspaceId === workspaceId ? reference.workerId : undefined;
        }
        return this.#modelWorker(qualified?.workerName ?? threadId, workspaceId);
    }

    async #modelWorker(name: string, workspaceId: number): Promise<number | undefined> {
        const worker = await this.#seam.readWorker({ workspaceId, identity: { name } });
        return worker?.origin === "model" ? worker.id : undefined;
    }

    // {§acp-run-input} Resolve retained identity without creating a conversation or claiming its owner.
    async #conversation(threadId: string, forwarded?: Record<string, unknown>): Promise<{ workspaceId: number; workerId: number } | null> {
        const qualified = ThreadAddress.parse(threadId);
        if (qualified !== null) {
            const workerId = await this.#threadWorker(threadId, qualified.workspaceId, forwarded);
            return workerId === undefined ? null : { workspaceId: qualified.workspaceId, workerId };
        }
        const workspaceName = forwarded?.workspace;
        if (workspaceName === undefined) return this.#seam.readWorkerReference({ namespace: "acp", reference: threadId });
        if (typeof workspaceName !== "string") return null;
        const workspace = (await this.#seam.listWorkspaces()).find(({ name }) => name === workspaceName);
        if (workspace === undefined) return null;
        const workerId = await this.#threadWorker(threadId, workspace.id, forwarded);
        return workerId === undefined ? null : { workspaceId: workspace.id, workerId };
    }

    // {§acp-action-binding} — what an action binds of the thread's worker. Reached only for a registered
    // action whose input its schema admits: any other is answered on the control path.
    #actionBinding({ kind, params }: ActionRequest): WorkerBinding {
        const action = this.#actions.get(kind)!;
        if (WORKER_CREATING_ACTIONS.has(kind)) return "create";
        if (WORKER_NAMING_ACTIONS.has(kind)) return typeof params.workerId === "number" ? "attach" : "required";
        if (WORKER_ACTIONS.has(kind)) return "required";
        if (WORKSPACE_ATTACHING_ACTIONS.has(kind)) return "attach";
        return action.scope === "worker" ? "required" : "none";
    }

    async #workerGauge(workspaceId: number, workerId: number, threadId: string): Promise<AcpWorkerGauge> {
        const [{ model }, loops, workers, proposals, interactions, inbox, streams, budget] = await Promise.all([
            this.#seam.readWorkerModel({ workspaceId, workerId }),
            this.#seam.listWorkerLoops({ workspaceId, workerId }),
            this.#seam.listWorkers(workspaceId),
            this.#seam.pendingProposals(workspaceId),
            this.#seam.pendingClientInteractions(workspaceId),
            this.#seam.readInbox({ workspaceId, workerId }),
            this.#seam.readStreams({ workspaceId, workerId }),
            this.#seam.workerGauge({ workspaceId, workerId }),
        ]);
        const loop = selectWorkerLoop(loops);
        const spend = await this.#seam.workerAccounting({ workspaceId, workerId });
        const descendants = descendantsState(workerId, workers, [...proposals, ...interactions]);
        return { status: statusState(model, loop, spendState(spend), descendants, inboxState(inbox, threadId), streams), budget };
    }

    // A control-plane ACP Run: no workspace bound. Open the SSE, execute the daemon verb, answer on
    // our own stream. No Portal thread, no model worker, and no ephemeral workspace.
    async #controlRun(action: ActionRequest, input: RunAgentInput, res: ServerResponse): Promise<void> {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" });
        const emit = (e: AcpEvent): void => { res.write(`data: ${JSON.stringify(e)}\n\n`); };
        emit({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
        if (action.kind === "discover") {
            for (const notice of this.#seam.configurationNotices()) {
                emit({ type: EventType.CUSTOM, name: "plurnk.notice", value: notice });
            }
        }
        const outcome = await this.#action(action, input, null, undefined, undefined)
            .catch((err: unknown): ActionOutcome => {
                console.error(`ACP action '${action.kind}' failed:`, err);
                const problem = Problems.fromError(err);
                return problem === null
                    ? actionFailure("action-failed", "The action failed unexpectedly.", 500)
                    : { ok: false, problem };
            });
        emit({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId, outcome: { type: "success" }, result: actionRunResult(action.kind, outcome) });
        res.end();
    }

    // Discovery is a projection of the executable registry, not a second inventory.
    async #capabilities(): Promise<AcpDiscovery> {
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
        return Validator.assertAcpDiscovery({
            schemaVersion: 1,
            actions,
            notifications: ACP_NOTIFICATIONS,
            display,
        });
    }

    async #action(a: ActionRequest, input: RunAgentInput, env: ClientEnvelope | null, boundWorkerId: number | undefined, onLoop: OperationLoopListener | undefined): Promise<ActionOutcome> {
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
            const outcome = await action.execute(a.params, input, env, boundWorkerId, onLoop);
            if (!outcome.ok) return outcome;
            const projected = Validator.validateJsonSchemaInstance(action.outputSchema, outcome.result);
            if (!projected.valid) {
                throw new Error(
                    `ACP action '${a.kind}' produced output outside its advertised schema: ${JSON.stringify(projected.errors)}`,
                );
            }
            return outcome;
        } catch (err) {
            const problem = Problems.fromError(err);
            if (problem !== null) return { ok: false, problem };
            console.error(`ACP action '${a.kind}' failed:`, err);
            return actionFailure("action-failed", "The action failed unexpectedly.", 500);
        }
    }

    static #body(req: IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            let data = "";
            req.on("data", (c: Buffer) => { data += c.toString(); });
            req.on("end", () => resolve(data));
            req.on("error", reject);
        });
    }

    #corsHeaders(): Record<string, string> {
        if (this.#opts.allowOrigin.length === 0) return {};
        return {
            "access-control-allow-origin": this.#opts.allowOrigin,
            "access-control-allow-headers": "authorization, content-type, accept",
            "access-control-allow-methods": "GET, POST, OPTIONS",
        };
    }

    static #writeSocketProblem(socket: Duplex, problem: ProblemDetails, extraHeaders: Readonly<Record<string, string>> = {}): void {
        const body = JSON.stringify(problem);
        const headerLines = [
            `HTTP/1.1 ${problem.status} Error`,
            "Content-Type: application/problem+json",
            "Connection: close",
            `Content-Length: ${Buffer.byteLength(body)}`,
            ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
            "\r\n",
        ];
        socket.end(`${headerLines.join("\r\n")}${body}`);
    }

    async #handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
        if (this.#stopped) {
            Module.#writeSocketProblem(socket, serviceStoppingProblem());
            return;
        }
        const url = new URL(req.url ?? "/acp", "http://listener");
        if (url.pathname !== "/acp") {
            Module.#writeSocketProblem(socket, httpProblem("route-not-found", 404, "The requested ACP route does not exist.", {
                stage: "routing",
                retryable: false,
            }));
            return;
        }
        let family: string | null = null;
        const face = this.#seam.credentials.face();
        if (face !== null) {
            const admission = this.#admit(req, face.issuer(req), true);
            if (!admission.ok) {
                Module.#writeSocketProblem(socket, admission.problem, { "WWW-Authenticate": admission.challenge });
                return;
            }
            ({ family } = admission);
        }
        const origin = this.#origin(req);
        const sessions = new Map<string, BoundSession>();
        const pendingGates = new Map<string | number, PendingRpcGate>();
        let ws: WebSocketConnection | null = null;
        const peer: AcpPeer = {
            family,
            origin,
            sessions,
            pendingGates,
            sendNotification: (method, params) => {
                ws?.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
            },
            sendRequest: (id, method, params, gate) => {
                pendingGates.set(id, gate);
                ws?.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
            },
            closeWithProblem: (problem) => {
                ws?.send(JSON.stringify({
                    jsonrpc: "2.0",
                    method: "_plurnk/error",
                    params: { problem },
                }));
                ws?.close(1001, typeof problem.code === "string" ? problem.code : "closed");
            },
        };
        ws = WebSocketConnection.upgrade(req, socket, head, {
            onMessage: (text) => {
                void this.#track(this.#handleWebSocketMessage(peer, ws!, text, req));
            },
            onClose: () => {
                this.#peers.delete(peer);
            },
        }, this.#corsHeaders());
        if (ws === null) {
            Module.#writeSocketProblem(socket, httpProblem("invalid-json", 400, "Invalid WebSocket upgrade handshake.", {
                stage: "transport",
                retryable: false,
            }));
            return;
        }
        this.#peers.add(peer);
    }

    async #handleWebSocketMessage(peer: AcpPeer, ws: WebSocketConnection, text: string, req: IncomingMessage): Promise<void> {
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            ws.send(JSON.stringify({
                jsonrpc: "2.0",
                id: null,
                error: { code: -32700, message: "Parse error" },
            }));
            return;
        }
        if (!isRecord(parsed) || parsed.jsonrpc !== "2.0") {
            ws.send(JSON.stringify({
                jsonrpc: "2.0",
                id: isRecord(parsed) && (typeof parsed.id === "string" || typeof parsed.id === "number") ? parsed.id : null,
                error: { code: -32600, message: "Invalid JSON-RPC 2.0 message" },
            }));
            return;
        }
        if (typeof parsed.method !== "string" && (typeof parsed.id === "string" || typeof parsed.id === "number")) {
            const gate = peer.pendingGates.get(parsed.id);
            if (gate !== undefined) {
                peer.pendingGates.delete(parsed.id);
                await this.#resolveRpcGate(gate, parsed.result, parsed.error);
            }
            return;
        }
        if (typeof parsed.method !== "string") {
            ws.send(JSON.stringify({
                jsonrpc: "2.0",
                id: typeof parsed.id === "string" || typeof parsed.id === "number" ? parsed.id : null,
                error: { code: -32600, message: "Missing JSON-RPC method" },
            }));
            return;
        }
        const id = typeof parsed.id === "string" || typeof parsed.id === "number" ? parsed.id : null;
        const params = isRecord(parsed.params) ? parsed.params : {};
        try {
            const result = await this.#dispatchRpc(peer, parsed.method, params, req);
            if (id !== null) {
                ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
            }
        } catch (err) {
            const problem = err instanceof HttpProblemError
                ? err.problem
                : Problems.fromError(err) ?? acpProblem("action-failed", 500, err instanceof Error ? err.message : "The ACP method failed.", { stage: "execution", retryable: false });
            if (id !== null) {
                ws.send(JSON.stringify({
                    jsonrpc: "2.0",
                    id,
                    error: {
                        code: problem.status === 404 ? -32004 : problem.status === 400 ? -32602 : -32000,
                        message: problem.detail,
                        data: { problem },
                    },
                }));
            }
        }
    }

    async #handleRpcHttp(req: IncomingMessage, res: ServerResponse, body: Readonly<Record<string, unknown>>, family: string | null): Promise<void> {
        const id = typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
        const method = typeof body.method === "string" ? body.method : "";
        const params = isRecord(body.params) ? body.params : {};
        const wantsSse = (req.headers.accept ?? "").includes("text/event-stream")
            && (method === "session/prompt" || method === "session/load" || method === "session/resume");
        const origin = this.#origin(req);
        const sessions = new Map<string, BoundSession>();
        const pendingGates = new Map<string | number, PendingRpcGate>();
        const bufferedNotifications: Array<Record<string, unknown>> = [];

        let heartbeat: ReturnType<typeof setInterval> | null = null;
        if (wantsSse) {
            res.writeHead(200, {
                ...this.#corsHeaders(),
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
            });
            const heartbeatInterval = this.#opts.heartbeatMs;
            if (heartbeatInterval > 0) {
                heartbeat = setInterval(() => {
                    if (!res.writableEnded) res.write(": keepalive\n\n");
                }, heartbeatInterval);
            }
        }

        const peer: AcpPeer = {
            family,
            origin,
            sessions,
            pendingGates,
            sendNotification: (notifMethod, notifParams) => {
                const payload = { jsonrpc: "2.0", method: notifMethod, params: notifParams };
                if (wantsSse && !res.writableEnded) {
                    res.write(`data: ${JSON.stringify(payload)}\n\n`);
                } else {
                    bufferedNotifications.push(payload);
                }
            },
            sendRequest: (reqId, reqMethod, reqParams, gate) => {
                pendingGates.set(reqId, gate);
                const payload = { jsonrpc: "2.0", id: reqId, method: reqMethod, params: reqParams };
                if (wantsSse && !res.writableEnded) {
                    res.write(`data: ${JSON.stringify(payload)}\n\n`);
                } else {
                    bufferedNotifications.push(payload);
                }
            },
            closeWithProblem: (problem) => {
                if (wantsSse && !res.writableEnded) {
                    res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "_plurnk/error", params: { problem } })}\n\n`);
                    res.end();
                }
            },
        };
        this.#peers.add(peer);
        try {
            const result = await this.#dispatchRpc(peer, method, params, req);
            const enrichedResult = !wantsSse && bufferedNotifications.length > 0 && isRecord(result)
                ? { ...result, notifications: bufferedNotifications.map((n) => n.params) }
                : result;
            const rpcResponse = { jsonrpc: "2.0", id, result: enrichedResult };
            if (wantsSse) {
                if (!res.writableEnded) {
                    res.write(`data: ${JSON.stringify(rpcResponse)}\n\n`);
                    res.end();
                }
            } else {
                res.writeHead(200, {
                    ...this.#corsHeaders(),
                    "content-type": "application/json",
                });
                res.end(JSON.stringify(rpcResponse));
            }
        } catch (err) {
            const problem = err instanceof HttpProblemError
                ? err.problem
                : Problems.fromError(err) ?? acpProblem("action-failed", 500, err instanceof Error ? err.message : "The ACP method failed.", { stage: "execution", retryable: false });
            const rpcError = {
                jsonrpc: "2.0",
                id,
                error: {
                    code: problem.status === 404 ? -32004 : problem.status === 400 ? -32602 : -32000,
                    message: problem.detail,
                    data: { problem },
                },
            };
            if (wantsSse) {
                if (!res.writableEnded) {
                    res.write(`data: ${JSON.stringify(rpcError)}\n\n`);
                    res.end();
                }
            } else {
                res.writeHead(200, {
                    ...this.#corsHeaders(),
                    "content-type": "application/json",
                });
                res.end(JSON.stringify(rpcError));
            }
        } finally {
            if (heartbeat !== null) clearInterval(heartbeat);
            this.#peers.delete(peer);
        }
    }

    async #resolveRpcGate(gate: PendingRpcGate, result: unknown, error: unknown): Promise<void> {
        if (gate.kind === "proposal") {
            let decision: ProposalDecision = "cancel";
            let body: string | undefined;
            let outcome: string | undefined;
            if (error === undefined && isRecord(result)) {
                const rawOutcome = isRecord(result.outcome) ? result.outcome : result;
                const optionId = typeof rawOutcome.optionId === "string"
                    ? rawOutcome.optionId
                    : typeof rawOutcome.decision === "string"
                        ? rawOutcome.decision
                        : rawOutcome.outcome === "cancelled"
                            ? "cancel"
                            : "cancel";
                if (optionId === "accept" || optionId === "allow_once" || optionId === "allow_always") decision = "accept";
                else if (optionId === "reject" || optionId === "reject_once" || optionId === "reject_always") decision = "reject";
                else decision = "cancel";
                if (typeof rawOutcome.body === "string") body = rawOutcome.body;
                if (typeof rawOutcome.reason === "string") outcome = rawOutcome.reason;
            }
            await this.#seam.resolveProposal(
                gate.targetId,
                {
                    decision,
                    ...(body === undefined ? {} : { body }),
                    ...(outcome === undefined ? {} : { outcome }),
                },
                { workspaceId: gate.workspaceId, address: MessageAddress.OWNER },
            );
            return;
        }
        const resolution: ClientInteractionResolution = error !== undefined || (isRecord(result) && result.status === "cancelled")
            ? { status: "cancelled" }
            : {
                status: "resolved",
                ...(isRecord(result) && Object.hasOwn(result, "payload") ? { payload: result.payload } : { payload: result }),
            };
        await this.#seam.resolveClientInteraction(
            gate.targetId,
            resolution,
            { workspaceId: gate.workspaceId, address: MessageAddress.OWNER },
        );
    }

    async #resolveSession(
        sessionId: string,
        origin: string,
        allowCreate: boolean = false,
    ): Promise<BoundSession> {
        const qualified = SessionAddress.parse(sessionId);
        if (qualified !== null) {
            const worker = await this.#seam.readWorker({
                workspaceId: qualified.workspaceId,
                identity: { name: qualified.workerName },
            });
            if (worker === null) {
                throw new HttpProblemError(acpProblem(
                    "session-not-found",
                    404,
                    `Session '${sessionId}' does not exist.`,
                    { sessionId, stage: "Lookup", retryable: false },
                ));
            }
            return {
                sessionId: SessionAddress.format(qualified.workspaceId, worker.name),
                workspaceId: qualified.workspaceId,
                workerId: worker.id,
                workerName: worker.name,
                translator: new SessionTranslator({
                    sessionId: SessionAddress.format(qualified.workspaceId, worker.name),
                    workspaceId: qualified.workspaceId,
                    workerId: worker.id,
                    origin,
                    historyPageChars: this.#opts.historyPageChars,
                }),
            };
        }
        const ref = allowCreate
            ? await this.#seam.ensureWorkerReference({ namespace: "acp", reference: sessionId })
            : await this.#seam.readWorkerReference({ namespace: "acp", reference: sessionId });
        if (ref === null) {
            throw new HttpProblemError(acpProblem(
                "session-not-found",
                404,
                `Session '${sessionId}' does not exist.`,
                { sessionId, stage: "lookup", retryable: false },
            ));
        }
        const worker = await this.#seam.readWorker({
            workspaceId: ref.workspaceId,
            identity: { id: ref.workerId },
        });
        const workerName = worker?.name ?? "main";
        return {
            sessionId,
            workspaceId: ref.workspaceId,
            workerId: ref.workerId,
            workerName,
            translator: new SessionTranslator({
                sessionId,
                workspaceId: ref.workspaceId,
                workerId: ref.workerId,
                origin,
                historyPageChars: this.#opts.historyPageChars,
            }),
        };
    }

    async #sessionConfigState(workspaceId: number, workerId: number): Promise<Record<string, unknown>> {
        const [{ model, spawnModel }, effort, capabilities, providers] = await Promise.all([
            this.#seam.readWorkerModel({ workspaceId, workerId }),
            this.#seam.readWorkerEffort({ workspaceId, workerId }),
            this.#seam.readWorkspaceCapabilities({ workspaceId }),
            Promise.resolve(this.#seam.listProviders()),
        ]);
        const currentModelId = model === null ? "" : model.alias ?? `${model.provider}/${model.model}`;
        return {
            modes: {
                currentModeId: "default",
                availableModes: [
                    { id: "default", name: "Default", description: "Workspace capability policy as configured." },
                ],
            },
            models: {
                currentModelId,
                availableModels: providers.aliases.map((alias) => ({
                    modelId: alias.alias,
                    name: `${alias.alias} (${alias.provider}/${alias.model})`,
                    provider: alias.provider,
                    model: alias.model,
                    effort: alias.effort,
                })),
            },
            configOptions: [
                {
                    id: "model",
                    name: "Model",
                    category: "model",
                    type: "select",
                    currentValue: currentModelId,
                    options: providers.aliases.map((alias) => ({
                        value: alias.alias,
                        name: `${alias.alias} (${alias.provider}/${alias.model})`,
                    })),
                },
                {
                    id: "effort",
                    name: "Thinking Effort",
                    category: "thought_level",
                    type: "select",
                    currentValue: effort.effort ?? "off",
                    options: effort.supportedEfforts.map((value) => ({ value, name: value })),
                },
            ],
            _meta: {
                plurnk: {
                    workspaceId,
                    workerId,
                    model,
                    spawnModel,
                    effort,
                    capabilities,
                },
            },
        };
    }

    static #extractPromptText(promptParam: unknown): string {
        if (typeof promptParam === "string") return promptParam;
        if (!Array.isArray(promptParam)) return "";
        const parts: string[] = [];
        for (const block of promptParam) {
            if (!isRecord(block)) continue;
            if (block.type === "text" && typeof block.text === "string") {
                parts.push(block.text);
            } else if (block.type === "resource_link" && typeof block.uri === "string") {
                parts.push(block.uri);
            } else if (block.type === "resource" && isRecord(block.resource)) {
                if (typeof block.resource.text === "string") parts.push(block.resource.text);
                else if (typeof block.resource.uri === "string") parts.push(block.resource.uri);
            }
        }
        return parts.join("\n");
    }

    async #dispatchRpc(
        peer: AcpPeer,
        method: string,
        params: Readonly<Record<string, unknown>>,
        req: IncomingMessage,
    ): Promise<unknown> {
        switch (method) {
            case "initialize": {
                const face = this.#seam.credentials.face();
                const issuer = face?.issuer(req);
                return {
                    protocolVersion: 2,
                    agentInfo: {
                        name: "plurnk",
                        title: "Plurnk Service",
                        version: "1.0.0",
                    },
                    agentCapabilities: {
                        loadSession: true,
                        promptCapabilities: {
                            image: true,
                            audio: true,
                            embeddedContext: true,
                        },
                        sessionCapabilities: {
                            list: {},
                            fork: {},
                            resume: {},
                            close: {},
                        },
                    },
                    authMethods: issuer === undefined ? [] : [{
                        id: "oauth2",
                        name: "Plurnk OAuth 2.1",
                        type: "oauth2",
                        issuer,
                        metadataUrl: `${issuer}/.well-known/oauth-authorization-server`,
                        scope: "acp",
                    }],
                };
            }
            case "session/new": {
                const metaPlurnk = isRecord(params._meta) && isRecord(params._meta.plurnk) ? params._meta.plurnk : {};
                const workspaceIdParam = typeof params.workspaceId === "number" ? params.workspaceId : metaPlurnk.workspaceId;
                const workspaceNameParam = typeof params.workspaceName === "string" ? params.workspaceName : metaPlurnk.workspaceName;
                const cwdParam = typeof params.cwd === "string" && params.cwd.length > 0 ? params.cwd : null;

                let workspace;
                if (typeof workspaceIdParam === "number" && isSafeInteger(workspaceIdParam) && workspaceIdParam > 0) {
                    workspace = await this.#seam.attachWorkspace({ workspaceId: workspaceIdParam });
                } else if (typeof workspaceNameParam === "string" && workspaceNameParam.length > 0) {
                    try {
                        workspace = await this.#seam.attachWorkspace({ name: workspaceNameParam });
                    } catch {
                        workspace = await this.#seam.createWorkspace({ name: workspaceNameParam, projectRoot: cwdParam });
                    }
                } else if (cwdParam !== null) {
                    workspace = await this.#seam.attachWorkspace({ projectRoot: cwdParam });
                } else {
                    workspace = await this.#seam.createWorkspace({ projectRoot: null });
                }
                await this.#seam.registerWorkerOwner(workspace.workspaceId, {
                    address: MessageAddress.OWNER,
                    tools: [],
                    interactive: true,
                });
                const requestedWorkerName = typeof params.workerName === "string" && params.workerName.length > 0
                    ? params.workerName
                    : typeof metaPlurnk.workerName === "string" && metaPlurnk.workerName.length > 0
                        ? metaPlurnk.workerName
                        : undefined;
                let workerId: number;
                let workerName: string;
                if (requestedWorkerName !== undefined) {
                    const existing = await this.#seam.readWorker({
                        workspaceId: workspace.workspaceId,
                        identity: { name: requestedWorkerName },
                    });
                    if (existing !== null) {
                        workerId = existing.id;
                        workerName = existing.name;
                    } else {
                        const created = await this.#seam.createWorker({
                            workspaceId: workspace.workspaceId,
                            name: requestedWorkerName,
                            owner: MessageAddress.OWNER,
                        });
                        workerId = created.workerId;
                        workerName = created.workerName;
                    }
                } else {
                    const created = await this.#seam.createWorker({
                        workspaceId: workspace.workspaceId,
                        owner: MessageAddress.OWNER,
                    });
                    workerId = created.workerId;
                    workerName = created.workerName;
                }
                await this.#seam.claimWorkerOwner({
                    workspaceId: workspace.workspaceId,
                    workerId,
                    owner: MessageAddress.OWNER,
                });
                const sessionId = SessionAddress.format(workspace.workspaceId, workerName);
                const bound: BoundSession = {
                    sessionId,
                    workspaceId: workspace.workspaceId,
                    workerId,
                    workerName,
                    translator: new SessionTranslator({
                        sessionId,
                        workspaceId: workspace.workspaceId,
                        workerId,
                        origin: peer.origin,
                        historyPageChars: this.#opts.historyPageChars,
                    }),
                };
                peer.sessions.set(sessionId, bound);
                return {
                    sessionId,
                    workspaceId: workspace.workspaceId,
                    workerId,
                    workerName,
                    ...(await this.#sessionConfigState(workspace.workspaceId, workerId)),
                };
            }
            case "session/load":
            case "session/resume": {
                if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
                    throw new HttpProblemError(acpProblem(
                        "invalid-action-parameters",
                        400,
                        `${method} requires a non-empty sessionId.`,
                        { field: "sessionId", retryable: false },
                    ));
                }
                const bound = await this.#resolveSession(params.sessionId, peer.origin, params.create === true);
                await this.#seam.registerWorkerOwner(bound.workspaceId, {
                    address: MessageAddress.OWNER,
                    tools: [],
                    interactive: true,
                });
                await this.#seam.claimWorkerOwner({
                    workspaceId: bound.workspaceId,
                    workerId: bound.workerId,
                    owner: MessageAddress.OWNER,
                });
                peer.sessions.set(bound.sessionId, bound);
                const [entries, inbox, proposals, interactions] = await Promise.all([
                    this.#seam.readLog({ workspaceId: bound.workspaceId, workerId: bound.workerId }),
                    this.#seam.readInbox({ workspaceId: bound.workspaceId, workerId: bound.workerId }),
                    this.#seam.pendingProposals(bound.workspaceId),
                    this.#seam.pendingClientInteractions(bound.workspaceId),
                ]);
                const beforeLoopSeq = typeof params.beforeLoopSeq === "number" && isSafeInteger(params.beforeLoopSeq)
                    ? params.beforeLoopSeq
                    : undefined;
                const replayed = SessionTranslator.replay(bound.translator, entries, inbox, {
                    historyLoops: this.#opts.historyLoops,
                    ...(beforeLoopSeq === undefined ? {} : { beforeLoopSeq }),
                });
                for (const update of replayed.updates) {
                    peer.sendNotification("session/update", update);
                }
                for (const proposal of proposals) {
                    if (proposal.workerId === bound.workerId) {
                        this.#emitProposalToPeer(peer, bound, proposal);
                    }
                }
                for (const interaction of interactions) {
                    if (interaction.workerId === bound.workerId) {
                        this.#emitInteractionToPeer(peer, bound, interaction);
                    }
                }
                return {
                    sessionId: bound.sessionId,
                    workspaceId: bound.workspaceId,
                    workerId: bound.workerId,
                    workerName: bound.workerName,
                    hasMore: replayed.hasMore,
                    beforeLoopSeq: replayed.beforeLoopSeq,
                    ...(await this.#sessionConfigState(bound.workspaceId, bound.workerId)),
                };
            }
            case "session/list": {
                const includeHidden = params.includeHidden === true;
                const workspaces = await this.#seam.listWorkspaces(includeHidden ? {} : { hidden: false });
                const sessions: Array<Record<string, unknown>> = [];
                for (const ws of workspaces) {
                    const workers = await this.#seam.listWorkers(ws.id, {
                        origin: "model",
                        ...(includeHidden ? {} : { hidden: false }),
                    });
                    for (const worker of workers) {
                        sessions.push({
                            sessionId: SessionAddress.format(ws.id, worker.name),
                            workspaceId: ws.id,
                            workspaceName: ws.name,
                            cwd: ws.project_root,
                            projectLabel: ws.project_label,
                            workerId: worker.id,
                            workerName: worker.name,
                            kind: worker.kind,
                            lifecycle: worker.lifecycle,
                            updatedAt: worker.created_at,
                            hiddenAt: worker.hidden_at,
                        });
                    }
                }
                return { sessions };
            }
            case "session/fork": {
                if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
                    throw new HttpProblemError(acpProblem(
                        "invalid-action-parameters",
                        400,
                        "session/fork requires a non-empty sessionId.",
                        { field: "sessionId", retryable: false },
                    ));
                }
                const bound = await this.#resolveSession(params.sessionId, peer.origin);
                const forked = await this.#seam.forkWorker({
                    workspaceId: bound.workspaceId,
                    workerId: bound.workerId,
                    ...(typeof params.name === "string" && params.name.length > 0 ? { name: params.name } : {}),
                });
                const forkedName = forked.workerName ?? String(forked.workerId);
                const forkedSessionId = SessionAddress.format(bound.workspaceId, forkedName);
                return {
                    sessionId: forkedSessionId,
                    workspaceId: bound.workspaceId,
                    workerId: forked.workerId,
                    workerName: forked.workerName,
                    parentWorkerId: forked.parentWorkerId,
                };
            }
            case "session/close": {
                if (typeof params.sessionId === "string") {
                    peer.sessions.delete(params.sessionId);
                }
                return { closed: true };
            }
            case "session/prompt": {
                if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
                    throw new HttpProblemError(acpProblem(
                        "invalid-action-parameters",
                        400,
                        "session/prompt requires a non-empty sessionId.",
                        { field: "sessionId", retryable: false },
                    ));
                }
                const promptText = Module.#extractPromptText(params.prompt);
                if (promptText.length === 0) {
                    throw new HttpProblemError(acpProblem(
                        "invalid-action-parameters",
                        400,
                        "session/prompt requires non-empty prompt content.",
                        { field: "prompt", retryable: false },
                    ));
                }
                const bound = peer.sessions.get(params.sessionId)
                    ?? await this.#resolveSession(params.sessionId, peer.origin, true);
                peer.sessions.set(bound.sessionId, bound);
                await this.#seam.registerWorkerOwner(bound.workspaceId, {
                    address: MessageAddress.OWNER,
                    tools: [],
                    interactive: true,
                });
                await this.#seam.claimWorkerOwner({
                    workspaceId: bound.workspaceId,
                    workerId: bound.workerId,
                    owner: MessageAddress.OWNER,
                });
                const messageId = typeof params.messageId === "string" && params.messageId.length > 0
                    ? params.messageId
                    : crypto.randomUUID();
                const submission = MessageAddress.sessionSubmission(bound.sessionId, messageId, promptText);
                const admission = await this.#seam.runLoop({
                    workspaceId: bound.workspaceId,
                    workerId: bound.workerId,
                    prompt: promptText,
                    ...submission,
                    ...(this.#opts.maxTurns === undefined ? {} : { maxTurns: this.#opts.maxTurns }),
                    ...(typeof params.selector === "string" && params.selector.length > 0 ? { selector: params.selector } : {}),
                });
                if (params.wait === false) {
                    return {
                        stopReason: "end_turn",
                        loopId: admission.loopId,
                        action: admission.action,
                    };
                }
                const terminated = await new Promise<TerminatedNotification>((resolve, reject) => {
                    const waiter: LoopWaiter = {
                        workspaceId: bound.workspaceId,
                        workerId: bound.workerId,
                        loopId: admission.loopId,
                        resolve: (notification) => {
                            this.#loopWaiters.delete(waiter);
                            resolve(notification);
                        },
                        reject: (problem) => {
                            this.#loopWaiters.delete(waiter);
                            reject(new HttpProblemError(problem));
                        },
                    };
                    this.#loopWaiters.add(waiter);
                });
                const stopReason = terminated.hitMaxTurns || terminated.result.status === 429
                    ? "max_turn_requests"
                    : terminated.result.status === 499
                        ? "cancelled"
                        : terminated.result.status >= 400
                            ? "refusal"
                            : "end_turn";
                return {
                    stopReason,
                    loopId: terminated.loopId,
                    loopSeq: terminated.loopSeq,
                    result: terminated.result,
                    usage: terminated.usage,
                };
            }
            case "session/cancel": {
                if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
                    throw new HttpProblemError(acpProblem(
                        "invalid-action-parameters",
                        400,
                        "session/cancel requires a non-empty sessionId.",
                        { field: "sessionId", retryable: false },
                    ));
                }
                const bound = peer.sessions.get(params.sessionId) ?? await this.#resolveSession(params.sessionId, peer.origin);
                const cancelled = this.#seam.cancelDrain(
                    bound.workerId,
                    typeof params.reason === "string" && params.reason.length > 0 ? params.reason : "user_cancelled",
                );
                return { cancelled };
            }
            case "session/set_config_option":
            case "session/set_mode": {
                if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
                    throw new HttpProblemError(acpProblem(
                        "invalid-action-parameters",
                        400,
                        `${method} requires a non-empty sessionId.`,
                        { field: "sessionId", retryable: false },
                    ));
                }
                const bound = peer.sessions.get(params.sessionId) ?? await this.#resolveSession(params.sessionId, peer.origin);
                const configId = method === "session/set_mode"
                    ? "mode"
                    : typeof params.configId === "string"
                        ? params.configId
                        : "";
                const value = method === "session/set_mode" ? params.modeId : params.value;
                if (configId === "model") {
                    if (typeof value !== "string" || value.length === 0) {
                        throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "Model selector must be a non-empty string."));
                    }
                    await this.#seam.setWorkerModel({
                        workspaceId: bound.workspaceId,
                        workerId: bound.workerId,
                        selector: value,
                    });
                } else if (configId === "effort") {
                    await this.#seam.setWorkerEffort({
                        workspaceId: bound.workspaceId,
                        workerId: bound.workerId,
                        effort: value,
                    });
                } else if (configId === "spawn_model") {
                    if (value !== null && typeof value !== "string") {
                        throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "spawn_model must be a string or null."));
                    }
                    await this.#seam.setWorkerSpawnModel({
                        workspaceId: bound.workspaceId,
                        workerId: bound.workerId,
                        selector: value,
                    });
                } else if (configId === "mode" && isRecord(params.policy)) {
                    await this.#seam.setWorkspaceCapabilities({
                        workspaceId: bound.workspaceId,
                        policy: Validator.assertCapabilityPolicy(params.policy),
                    });
                }
                return await this.#sessionConfigState(bound.workspaceId, bound.workerId);
            }
            case "session/resolve_permission": {
                const logEntryId = typeof params.logEntryId === "number" ? params.logEntryId : Number(params.toolCallId);
                const workspaceId = typeof params.workspaceId === "number"
                    ? params.workspaceId
                    : typeof params.sessionId === "string"
                        ? (await this.#resolveSession(params.sessionId, peer.origin)).workspaceId
                        : 0;
                if (!isSafeInteger(logEntryId) || logEntryId < 1 || !isSafeInteger(workspaceId) || workspaceId < 1) {
                    throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "session/resolve_permission requires workspaceId (or sessionId) and logEntryId."));
                }
                const rawDecision = typeof params.decision === "string" ? params.decision : params.optionId;
                const decision: ProposalDecision = rawDecision === "accept" || rawDecision === "allow_once" || rawDecision === "allow_always"
                    ? "accept"
                    : rawDecision === "reject" || rawDecision === "reject_once" || rawDecision === "reject_always"
                        ? "reject"
                        : "cancel";
                await this.#seam.resolveProposal(
                    logEntryId,
                    {
                        decision,
                        ...(typeof params.body === "string" ? { body: params.body } : {}),
                        ...(typeof params.outcome === "string" ? { outcome: params.outcome } : {}),
                    },
                    { workspaceId, address: MessageAddress.OWNER },
                );
                return { resolved: true };
            }
            case "_plurnk/interaction.resolve": {
                const interactionId = Number(params.interactionId);
                const workspaceId = typeof params.workspaceId === "number"
                    ? params.workspaceId
                    : typeof params.sessionId === "string"
                        ? (await this.#resolveSession(params.sessionId, peer.origin)).workspaceId
                        : 0;
                if (!isSafeInteger(interactionId) || interactionId < 1 || !isSafeInteger(workspaceId) || workspaceId < 1) {
                    throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "_plurnk/interaction.resolve requires workspaceId (or sessionId) and interactionId."));
                }
                const resolution: ClientInteractionResolution = params.status === "cancelled"
                    ? { status: "cancelled" }
                    : { status: "resolved", ...(Object.hasOwn(params, "payload") ? { payload: params.payload } : {}) };
                await this.#seam.resolveClientInteraction(
                    interactionId,
                    resolution,
                    { workspaceId, address: MessageAddress.OWNER },
                );
                return { resolved: true };
            }
            case "_plurnk/discover": {
                const display = await this.#seam.listClientDisplayCapabilities();
                const moduleActions = Object.fromEntries(
                    this.#seam.listModuleActions().map((a) => [a.name, { scope: a.scope, inputSchema: a.inputSchema, outputSchema: a.outputSchema }]),
                );
                return {
                    protocolVersion: 2,
                    actions: moduleActions,
                    notifications: APPLICATION_NOTIFICATIONS,
                    display,
                    configurationNotices: this.#seam.configurationNotices(),
                };
            }
            case "_plurnk/overview": {
                const workspaceId = typeof params.workspaceId === "number" && isSafeInteger(params.workspaceId) && params.workspaceId > 0
                    ? params.workspaceId
                    : undefined;
                return await this.#seam.readWorkerOverview({
                    ...(workspaceId === undefined ? {} : { workspaceId }),
                    limit: this.#opts.overviewWorkers,
                    excerptChars: this.#opts.excerptChars,
                });
            }
            case "_plurnk/action": {
                const kind = typeof params.kind === "string" ? params.kind : "";
                const actionParams = isRecord(params.params) ? params.params : {};
                if (kind.length === 0) {
                    throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "_plurnk/action requires a non-empty action kind."));
                }
                const bound = typeof params.sessionId === "string" && params.sessionId.length > 0
                    ? peer.sessions.get(params.sessionId) ?? await this.#resolveSession(params.sessionId, peer.origin)
                    : undefined;
                const workspaceId = typeof params.workspaceId === "number" && isSafeInteger(params.workspaceId) && params.workspaceId > 0
                    ? params.workspaceId
                    : bound?.workspaceId;
                const workerId = typeof params.workerId === "number" && isSafeInteger(params.workerId) && params.workerId > 0
                    ? params.workerId
                    : bound?.workerId;
                return await this.#executeRpcAction(kind, actionParams, workspaceId, workerId);
            }
            default:
                throw new HttpProblemError(acpProblem(
                    "route-not-found",
                    404,
                    `Unknown ACP method '${method}'.`,
                    { method, stage: "routing", retryable: false },
                ));
        }
    }

    async #executeRpcAction(
        kind: string,
        p: Readonly<Record<string, unknown>>,
        workspaceId?: number,
        workerId?: number,
    ): Promise<unknown> {
        switch (kind) {
            case "ping":
                return {};
            case "providers.list":
                return this.#seam.listProviders();
            case "models.list":
                return this.#seam.listModels(Validator.assertModelCatalogQuery(p));
            case "workspace.list":
                return { workspaces: await this.#seam.listWorkspaces(p.includeHidden === true ? {} : { hidden: false }) };
            case "workspace.create": {
                const created = await this.#seam.createWorkspace({
                    ...(typeof p.name === "string" ? { name: p.name } : {}),
                    ...(typeof p.projectRoot === "string" || p.projectRoot === null ? { projectRoot: p.projectRoot } : {}),
                    ...(typeof p.settings === "string" || isRecord(p.settings) ? { settings: p.settings } : {}),
                });
                return { id: created.workspaceId, name: created.workspaceName };
            }
            case "workspace.attach": {
                const selector = typeof p.id === "number" ? { workspaceId: p.id }
                    : typeof p.name === "string" ? { name: p.name }
                        : typeof p.projectRoot === "string" ? { projectRoot: p.projectRoot } : null;
                if (selector === null) {
                    throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "workspace.attach requires id, name or projectRoot."));
                }
                const attached = await this.#seam.attachWorkspace(selector);
                return { id: attached.workspaceId, name: attached.workspaceName };
            }
        }
        const moduleAction = this.#seam.listModuleActions().find((a) => a.name === kind);
        if (moduleAction !== undefined) {
            if (moduleAction.scope === "daemon") {
                return await this.#seam.invokeModuleAction(kind, p, { scope: "daemon" });
            }
            if (workspaceId === undefined) {
                throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, `Action '${kind}' requires a workspaceId or sessionId.`));
            }
            if (moduleAction.scope === "workspace") {
                return await this.#seam.invokeModuleAction(kind, p, { scope: "workspace", workspaceId });
            }
            if (workerId === undefined) {
                throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, `Action '${kind}' requires a workerId or sessionId.`));
            }
            return await this.#seam.invokeModuleAction(kind, p, { scope: "worker", workspaceId, workerId });
        }
        if (workspaceId === undefined) {
            throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, `Action '${kind}' requires a workspaceId or sessionId.`));
        }
        switch (kind) {
            case "workspace.workers":
                return {
                    workers: await this.#seam.listWorkers(
                        typeof p.id === "number" ? p.id : workspaceId,
                        p.includeHidden === true ? {} : { hidden: false },
                    ),
                };
            case "workspace.rename": {
                if (typeof p.name !== "string" || p.name.length === 0) {
                    throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "workspace.rename requires a non-empty name."));
                }
                return await this.#seam.renameWorkspace(workspaceId, p.name);
            }
            case "workspace.share": {
                if (typeof p.folder !== "string" || p.folder.length === 0) {
                    throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "workspace.share requires a non-empty folder."));
                }
                return await this.#seam.shareWorkspace({ workspaceId, folder: p.folder });
            }
            case "workspace.hidden.set":
                return await this.#seam.setWorkspaceHidden({ workspaceId, hidden: p.hidden === true });
            case "worker.hidden.set": {
                const targetWorkerId = typeof p.workerId === "number" ? p.workerId : workerId;
                if (targetWorkerId === undefined) {
                    throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "worker.hidden.set requires workerId."));
                }
                return await this.#seam.setWorkerHidden({ workspaceId, workerId: targetWorkerId, hidden: p.hidden === true });
            }
            case "workspace.rollback": {
                const targetWorkerId = typeof p.workerId === "number" ? p.workerId : workerId;
                if (targetWorkerId === undefined || typeof p.to !== "string" || p.to.length === 0) {
                    throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "workspace.rollback requires workerId and coordinate 'to'."));
                }
                return await this.#seam.rollback({
                    workspaceId,
                    workerId: targetWorkerId,
                    actor: MessageAddress.OWNER,
                    to: p.to,
                });
            }
            case "workspace.prompts": {
                const targetWorkerId = typeof p.workerId === "number" ? p.workerId : workerId;
                return {
                    prompts: await this.#seam.listPrompts(
                        workspaceId,
                        typeof p.limit === "number" ? p.limit : undefined,
                        targetWorkerId,
                    ),
                };
            }
            case "worker.loops": {
                const targetWorkerId = typeof p.workerId === "number" ? p.workerId : workerId;
                if (targetWorkerId === undefined) {
                    throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "worker.loops requires workerId."));
                }
                const loops = await this.#seam.listWorkerLoops({ workspaceId, workerId: targetWorkerId });
                return {
                    loops: loops.map((loop) => {
                        const { excerpt: opening, continued } = excerptOf(loop.prompt, this.#opts.excerptChars);
                        return {
                            id: loop.id,
                            sequence: loop.sequence,
                            lifecycle: lifecycleOfLoopStatus(loop.status),
                            source: loop.promptSource,
                            opening,
                            continued,
                        };
                    }),
                };
            }
            case "log.read": {
                const targetWorkerId = typeof p.workerId === "number" ? p.workerId : workerId;
                if (targetWorkerId === undefined) {
                    throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "log.read requires workerId."));
                }
                return {
                    entries: await this.#seam.readLog({
                        workspaceId,
                        workerId: targetWorkerId,
                        ...(typeof p.limit === "number" ? { limit: p.limit } : {}),
                        ...(typeof p.sinceId === "number" ? { sinceId: p.sinceId } : {}),
                        ...(typeof p.loopId === "number" ? { loopId: p.loopId } : {}),
                        ...(typeof p.turnId === "number" ? { turnId: p.turnId } : {}),
                        ...(typeof p.loopSeq === "number" ? { loopSeq: p.loopSeq } : {}),
                        ...(typeof p.turnSeq === "number" ? { turnSeq: p.turnSeq } : {}),
                        ...(typeof p.sequence === "number" ? { sequence: p.sequence } : {}),
                    }),
                };
            }
            case "entry.read": {
                const targetWorkerId = typeof p.workerId === "number" ? p.workerId : workerId;
                if (targetWorkerId === undefined || typeof p.target !== "string" || p.target.length === 0) {
                    throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "entry.read requires workerId and target."));
                }
                return await this.#seam.readEntry({
                    workspaceId,
                    workerId: targetWorkerId,
                    target: p.target,
                    ...(typeof p.channel === "string" ? { channel: p.channel } : {}),
                    ...(typeof p.offset === "number" ? { offset: p.offset } : {}),
                });
            }
            case "op.exec": {
                if (typeof p.command !== "string" || p.command.length === 0) {
                    throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "op.exec requires a non-empty command."));
                }
                const statement: ExecStatement = {
                    runtime: "sh",
                    aside: null,
                    target: null,
                    metadata: p.env === undefined ? null : [JSON.stringify({ env: p.env })],
                    lineMarker: null,
                    body: p.command,
                    position: UNKNOWN_POSITION,
                };
                const [result] = await this.#seam.dispatchClientAction({
                    workspaceId,
                    actor: MessageAddress.OWNER,
                    ...(workerId === undefined ? {} : { contextWorkerId: workerId }),
                    statements: [statement],
                });
                return result;
            }
            case "op.parse": {
                if (typeof p.text !== "string" || p.text.length === 0) {
                    throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "op.parse requires non-empty PLURNK text."));
                }
                const parsed = PlurnkParser.parseStatements(p.text, { executors: this.#seam.executorTags(workspaceId) });
                const results: Array<OperationResult | null> = [];
                const statements: PlurnkStatement[] = [];
                for (const item of parsed.items) {
                    if (item.kind === "error") {
                        results.push({
                            status: 400,
                            problem: acpProblem("parse-failed", 400, item.error.message, {
                                line: item.error.line,
                                column: item.error.column,
                                source: item.error.source,
                                severity: item.error.severity,
                                stage: "parsing",
                                retryable: false,
                            }),
                        });
                        continue;
                    }
                    if (item.kind === "statement") {
                        statements.push(item.statement);
                        results.push(null);
                    }
                }
                if (parsed.unparsedTail !== undefined) {
                    results.push({
                        status: 400,
                        problem: acpProblem("parse-failed", 400, parsed.unparsedTail.reason, {
                            line: parsed.unparsedTail.from.line,
                            column: parsed.unparsedTail.from.column,
                            source: "grammar",
                            severity: "error",
                            stage: "parsing",
                            retryable: false,
                        }),
                    });
                }
                const dispatched = statements.length === 0
                    ? []
                    : await this.#seam.dispatchClientAction({
                        workspaceId,
                        actor: MessageAddress.OWNER,
                        ...(workerId === undefined ? {} : { contextWorkerId: workerId }),
                        statements,
                    });
                let idx = 0;
                for (let i = 0; i < results.length; i++) {
                    if (results[i] === null) results[i] = dispatched[idx++]!;
                }
                return { results };
            }
            case "workspace.capabilities.get":
                return await this.#seam.readWorkspaceCapabilities({ workspaceId });
            case "workspace.capabilities.set":
                return await this.#seam.setWorkspaceCapabilities({
                    workspaceId,
                    policy: Validator.assertCapabilityPolicy(p.policy),
                });
            default:
                throw new HttpProblemError(acpProblem("route-not-found", 404, `Unknown action '${kind}'.`));
        }
    }

    #emitProposalToPeer(peer: AcpPeer, bound: BoundSession, proposal: ProposalProjection): void {
        const reqId = `perm:${this.#nextServerRequestId++}`;
        const leanProposal = { ...proposal, attrs: withoutBodies(proposal.attrs) };
        const targetText = [proposal.target.scheme, proposal.target.authority, proposal.target.pathname]
            .filter((part): part is string => typeof part === "string" && part.length > 0)
            .join("");
        peer.sendRequest(
            reqId,
            "session/request_permission",
            {
                sessionId: bound.sessionId,
                toolCall: {
                    toolCallId: String(proposal.logEntryId),
                    title: `${proposal.op} (${targetText})`,
                    kind: SessionTranslator.toolKindOf(proposal.op, null),
                    status: "pending",
                    rawInput: { body: proposal.body, target: proposal.target },
                    _meta: { plurnk: { proposal: leanProposal } },
                },
                options: [
                    { optionId: "accept", name: "Accept", kind: "allow_once" },
                    { optionId: "reject", name: "Reject", kind: "reject_once" },
                    { optionId: "cancel", name: "Cancel", kind: "reject_once" },
                ],
                _meta: { plurnk: { proposal: leanProposal } },
            },
            { kind: "proposal", workspaceId: bound.workspaceId, targetId: proposal.logEntryId },
        );
    }

    #emitInteractionToPeer(peer: AcpPeer, bound: BoundSession, interaction: ClientInteractionProjection): void {
        const reqId = `int:${this.#nextServerRequestId++}`;
        peer.sendRequest(
            reqId,
            "_plurnk/question",
            {
                sessionId: bound.sessionId,
                interactionId: interaction.interactionId,
                toolName: interaction.request.toolName,
                message: interaction.request.message ?? "Provide the requested input.",
                arguments: interaction.request.arguments,
                responseSchema: interaction.request.responseSchema,
                _meta: { plurnk: { interaction } },
            },
            { kind: "interaction", workspaceId: bound.workspaceId, targetId: interaction.interactionId },
        );
    }

    static #readNotification<T>(method: string, contract: ApplicationNotificationContract<T>, params: unknown): T {
        Validator.assertJsonSchemaInstance(`${method} notification`, contract.payloadSchema, params);
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the payload schema just proved the shape the table names
        return params as T;
    }

    #onDaemonEvent(workspaceId: number | null, method: string, params: unknown): void {
        if (workspaceId === null || (this.#peers.size === 0 && this.#loopWaiters.size === 0)) return;
        const contracts: Readonly<Record<string, ApplicationNotificationContract>> = APPLICATION_NOTIFICATIONS;
        const contract = contracts[method];
        if (contract !== undefined) {
            Module.#readNotification(method, contract, params);
        }

        if (method === "loop/terminated") {
            const terminated = Module.#readNotification(method, APPLICATION_NOTIFICATIONS["loop/terminated"], params);
            for (const waiter of [...this.#loopWaiters]) {
                if (waiter.workspaceId === workspaceId && waiter.workerId === terminated.workerId && waiter.loopId === terminated.loopId) {
                    waiter.resolve(terminated);
                }
            }
        }

        for (const peer of this.#peers) {
            for (const bound of peer.sessions.values()) {
                if (bound.workspaceId !== workspaceId) continue;
                let updates: AcpSessionUpdate[] = [];
                switch (method) {
                    case "log/entry":
                        updates = bound.translator.logEntry(Module.#readNotification(method, APPLICATION_NOTIFICATIONS["log/entry"], params));
                        break;
                    case "reasoning/event":
                        updates = bound.translator.reasoning(Module.#readNotification(method, APPLICATION_NOTIFICATIONS["reasoning/event"], params));
                        break;
                    case "outside/event":
                        updates = bound.translator.outside(Module.#readNotification(method, APPLICATION_NOTIFICATIONS["outside/event"], params));
                        break;
                    case "loop/packet":
                        updates = bound.translator.packet(Module.#readNotification(method, APPLICATION_NOTIFICATIONS["loop/packet"], params));
                        break;
                    case "loop/terminated":
                        updates = bound.translator.terminated(Module.#readNotification(method, APPLICATION_NOTIFICATIONS["loop/terminated"], params));
                        break;
                    case "loop/proposal": {
                        const proposal = Module.#readNotification(method, APPLICATION_NOTIFICATIONS["loop/proposal"], params);
                        if (proposal.workerId === bound.workerId) {
                            this.#emitProposalToPeer(peer, bound, proposal);
                        }
                        break;
                    }
                    case "loop/interaction": {
                        const interaction = Module.#readNotification(method, APPLICATION_NOTIFICATIONS["loop/interaction"], params);
                        if (interaction.workerId === bound.workerId) {
                            this.#emitInteractionToPeer(peer, bound, interaction);
                        }
                        break;
                    }
                    case "notice/event":
                        updates = [{
                            sessionId: bound.sessionId,
                            update: {
                                sessionUpdate: "_plurnk/notice",
                                ...(isRecord(params) ? params : {}),
                            },
                        }];
                        break;
                    case "stream/event":
                    case "stream/concluded":
                        updates = [{
                            sessionId: bound.sessionId,
                            update: {
                                sessionUpdate: "_plurnk/stream",
                                event: method,
                                ...(isRecord(params) ? params : {}),
                            },
                        }];
                        break;
                    case "workspace/preparation":
                        updates = [{
                            sessionId: bound.sessionId,
                            update: {
                                sessionUpdate: "_plurnk/workspace/preparation",
                                ...(isRecord(params) ? params : {}),
                            },
                        }];
                        break;
                }
                for (const update of updates) {
                    peer.sendNotification("session/update", update);
                }
            }
        }
    }
}
