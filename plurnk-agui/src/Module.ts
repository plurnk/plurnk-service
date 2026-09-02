// {§agui-daemon-client} The in-process transport module owns the AG-UI+ HTTP/SSE
// listener. Production binds it before durable-state admission, then the daemon's
// boot plug-point activates it with the ApplicationPort handle.
//
// This is the single external client interface:
//   POST /  — the only endpoint. A worker streams SSE. HITL is terminate-resume: a
//   stopped-world emits a request_approval/request_user_input TOOL_CALL and finishes
//   with an AG-UI interrupt outcome (the loop stays paused in-engine); the next AG-UI Run's
//   standard resume entries resolve the durable proposal and continue the exact loop.
//   Reads ride STATE_SNAPSHOT on RUN_STARTED; there are no side-channel action
//   or proposal-resolution endpoints.
// An AG-UI threadId names one conversation worker inside the explicitly forwarded
// workspace ({§agui-thread-binding}); no prefix or inferred workspace is minted.

import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";
import Portal from "./Portal.ts";
import { derivationActivity, statusState, actionResult, type ActionRequest, type ActionOutcome, type AguiStatusState } from "./AguiPlus.ts";
import { EventType, type AguiEvent, type RunAgentInput } from "./types.ts";
import { aguiRouteTemplate, observed } from "./observe.ts";
import { Validator, type AguiDiscovery, type ApplicationPort, type ClientEnvelope, type ProblemDetails } from "@plurnk/plurnk-contracts";
import { AGUI_BUILTIN_ACTIONS, AGUI_NOTIFICATIONS, type AguiActionContract } from "./AguiSurface.ts";
import { resolveModuleOptions, type ModuleOptions, type ResolvedModuleOptions } from "./config.ts";
import { HttpProblemError, actionFailure, problemFromError } from "./action-results.ts";
import BuiltinActions from "./BuiltinActions.ts";
import { httpProblem, runErrorEvents } from "./run-events.ts";
import RunHandler from "./RunHandler.ts";

export type { ModuleOptions } from "./config.ts";

export interface ModuleRegistration {
    start(seam: ApplicationPort): Promise<Module>;
}



const writeHttpProblem = (res: ServerResponse, problem: ProblemDetails): void => {
    res.writeHead(problem.status, { "content-type": "application/problem+json" });
    res.end(JSON.stringify(problem));
};

type ActionExecutor = (
    params: Readonly<Record<string, unknown>>,
    env: ClientEnvelope | null,
    conversationWorkerId?: number,
) => Promise<ActionOutcome>;

interface RegisteredAction extends AguiActionContract {
    readonly execute: ActionExecutor;
}

export default class Module {
    #seam!: ApplicationPort;
    #opts: ResolvedModuleOptions;
    #portal!: Portal;
    #http: HttpServer;
    #threadEnvelopes = new Map<string, ClientEnvelope>(); // [workspace, threadId] → envelope
    #threadWorkers = new Map<string, number>();           // [workspace, threadId] → conversation workerId
    #actions = new Map<string, RegisteredAction>();
    #listening = false;
    #activated = false;
    readonly #builtins = new BuiltinActions({ seam: () => this.#seam, capabilities: this.#capabilities.bind(this), envelope: this.#envelope.bind(this), requireWorkspace: Module.#requireWorkspace });
    readonly #runs = new RunHandler({ seam: () => this.#seam, opts: () => this.#opts, portal: () => this.#portal, requiresWorkspace: this.#requiresWorkspace.bind(this), controlRun: this.#controlRun.bind(this), envelope: this.#envelope.bind(this), conversationWorker: this.#conversationWorker.bind(this), workerStatus: this.#workerStatus.bind(this), action: this.#action.bind(this) });
    #closing: Promise<void> | null = null;

    private constructor(opts: ModuleOptions) {
        this.#opts = resolveModuleOptions(opts);
        this.#http = createServer((req, res) => { void this.#route(req, res); });
    }

    #registerActions(): void {
        for (const [name, contract] of Object.entries(AGUI_BUILTIN_ACTIONS)) {
            this.#actions.set(name, {
                ...contract,
                execute: (params, env, conversationWorkerId) =>
                    this.#builtins.executeBuiltin(name, params, env, conversationWorkerId),
            });
        }
        for (const descriptor of this.#seam.listModuleActions()) {
            const { name, scope, inputSchema, outputSchema } = descriptor;
            if (this.#actions.has(name)) throw new Error(`AG-UI action '${name}' is registered more than once`);
            if (scope !== "worldless" && scope !== "workspace" && scope !== "worker") {
                throw new Error(`module action '${name}' has invalid scope '${String(scope)}'`);
            }
            this.#actions.set(name, {
                scope,
                inputSchema,
                outputSchema,
                execute: async (params, env, conversationWorkerId) => {
                    if (scope === "worldless") {
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
                    const workerId = conversationWorkerId ?? await this.#seam.ensureModelWorker(workspaceId);
                    return {
                        ok: true,
                        result: await this.#seam.invokeModuleAction(name, params, { scope, workspaceId, workerId }),
                    };
                },
            });
        }
    }

    #requiresWorkspace(kind: string): boolean {
        return this.#actions.get(kind)?.scope !== "worldless";
    }

    static #requireWorkspace(kind: string, env: ClientEnvelope | null): ClientEnvelope {
        if (env === null) throw new Error(`action '${kind}' operates within a workspace, but none is bound`);
        return env;
    }

    static #threadKey(workspace: string, threadId: string): string {
        return JSON.stringify([workspace, threadId]);
    }

    static init(opts: ModuleOptions): ModuleRegistration {
        return {
            start: async (seam) => {
                const module = await Module.bind(opts);
                try { return await module.start(seam); }
                catch (cause) {
                    await module.close();
                    throw cause;
                }
            },
        };
    }

    // {§agui-listener-admission} Bind the process's client identity without
    // admitting any durable state. Until start() installs the ApplicationPort,
    // requests receive a transient 503 and cannot enter Core.
    static async bind(opts: ModuleOptions): Promise<Module> {
        const module = new Module(opts);
        await module.listen();
        return module;
    }

    async listen(): Promise<{ host: string; port: number }> {
        if (this.#listening) throw new Error("plurnk-agui: listener already bound");
        await new Promise<void>((resolve, reject) => {
            const onError = (cause: Error): void => {
                this.#http.off("listening", onListening);
                reject(cause);
            };
            const onListening = (): void => {
                this.#http.off("error", onError);
                resolve();
            };
            this.#http.once("error", onError);
            this.#http.once("listening", onListening);
            this.#http.listen(this.#opts.port, this.#opts.host);
        });
        this.#listening = true;
        const addr = this.#http.address();
        if (addr === null || typeof addr === "string") throw new Error("plurnk-agui: listener bound no TCP address");
        return { host: this.#opts.host, port: addr.port };
    }

    async start(seam: ApplicationPort): Promise<Module> {
        if (!this.#listening) throw new Error("plurnk-agui: listener must be bound before activation");
        if (this.#activated) throw new Error("plurnk-agui: module already activated");
        this.#seam = seam;
        this.#registerActions();
        this.#portal = new Portal(seam);
        this.#portal.start();
        this.#activated = true;
        return this;
    }

    address(): { host: string; port: number } {
        const addr = this.#http.address();
        if (addr === null || typeof addr === "string") throw new Error("plurnk-agui: not listening");
        return { host: this.#opts.host, port: addr.port };
    }

    async close(): Promise<void> {
        if (this.#activated) {
            this.#activated = false;
            this.#portal.stop();
        }
        if (!this.#listening) return;
        this.#closing ??= new Promise<void>((resolve, reject) => this.#http.close((e) => (e ? reject(e) : resolve())));
        await this.#closing;
        this.#listening = false;
    }

    async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!this.#activated) {
            writeHttpProblem(res, httpProblem(
                "service-starting",
                503,
                "The PLURNK service owns this listener but has not completed durable recovery.",
                { stage: "startup", retryable: true },
            ));
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
            res.setHeader("access-control-allow-origin", "*");
            res.setHeader("access-control-allow-headers", "content-type, authorization");
            if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
            // The perimeter ({§agui-http-authorization}): bearer check before any body read.
            const token = this.#opts.token ?? "";
            if (token.length > 0 && req.headers.authorization !== `Bearer ${token}`) {
                writeHttpProblem(res, httpProblem(
                    "bearer-token-required",
                    401,
                    "The request did not provide the required bearer token.",
                    {
                        stage: "authorization",
                        recovery: "Provide the configured bearer token.",
                        retryable: false,
                    },
                ));
                return;
            }
            if (req.method === "POST" && (req.url === "/" || req.url === "/agui")) return await this.#runs.run(req, res);
            writeHttpProblem(res, httpProblem("route-not-found", 404, "The requested HTTP route does not exist.", {
                method: req.method ?? null,
                path: req.url ?? null,
                stage: "routing",
                retryable: false,
            }));
        } catch (err) {
            const exactProblem = problemFromError(err);
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

    // The name is the identity, verbatim. The workspace is the world
    // ({§agui-thread-binding}) — selected by name via
    // `forwardedProps.plurnk.workspace`; attach it if it exists, create it with EXACTLY that
    // name if it doesn't. No prefixes, no forged names, no dual lookup. The workspace is
    // REQUIRED: a worker has no existence without a world, so its absence is a contract
    // violation the client must fix — never a workspace forged from the threadId.
    // The threadId is the CONVERSATION over that world — resolved to a worker by
    // #conversationWorker ({§agui-thread-binding}: the three doors are ensureModelWorker, forkWorker,
    // createConversationWorker).
    async #envelope(threadId: string, forwarded?: Record<string, unknown>): Promise<{ env: ClientEnvelope; reattached: boolean }> {
        const workspace = forwarded?.workspace;
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
        const key = Module.#threadKey(workspace, threadId);
        const cached = this.#threadEnvelopes.get(key);
        if (cached !== undefined) return { env: cached, reattached: true };
        const known = (await this.#seam.listWorkspaces()).find((s) => s.name === workspace);
        let env: ClientEnvelope;
        let reattached = false;
        if (known !== undefined) {
            env = await this.#seam.attachWorkspace({ workspaceId: known.id });
            reattached = true;
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
        this.#threadEnvelopes.set(key, env);
        return { env, reattached };
    }

    // Resolve the thread's conversation worker within its world. Cached per
    // workspace + threadId; worker names are immutable so the binding cannot rot. Durable
    // capability changes use worker.capabilities.set; per-run attenuation belongs
    // to the loop policy forwarded below.
    async #conversationWorker(threadId: string, env: ClientEnvelope): Promise<number> {
        const key = Module.#threadKey(env.workspaceName, threadId);
        const cached = this.#threadWorkers.get(key);
        if (cached !== undefined) return cached;
        const workerId = threadId === env.workspaceName
            ? await this.#seam.ensureModelWorker(env.workspaceId)
            : (await this.#seam.listWorkers(env.workspaceId)).find((r) => r.name === threadId)?.id
                ?? (await this.#seam.createConversationWorker({ workspaceId: env.workspaceId, name: threadId })).workerId;
        this.#threadWorkers.set(key, workerId);
        return workerId;
    }

    async #workerStatus(workspaceId: number, workerId: number): Promise<AguiStatusState> {
        const [{ model }, loops] = await Promise.all([
            this.#seam.readWorkerModel({ workspaceId, workerId }),
            this.#seam.listWorkerLoops({ workspaceId, workerId }),
        ]);
        return statusState(
            model,
            loops.at(-1) ?? null,
            derivationActivity(this.#seam.workspaceDerivationStatus(workspaceId)),
        );
    }

    // A control-plane AG-UI Run: no world bound. Open the SSE, execute the worldless verb, answer on
    // our own stream. No Portal thread, no model worker, and no ephemeral workspace.
    async #controlRun(action: ActionRequest, input: RunAgentInput, res: ServerResponse): Promise<void> {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" });
        const emit = (e: AguiEvent): void => { res.write(`data: ${JSON.stringify(e)}\n\n`); };
        emit({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
        const outcome = await this.#action(action, null)
            .catch((err: unknown): ActionOutcome => {
                console.error(`AG-UI action '${action.kind}' failed:`, err);
                const problem = problemFromError(err);
                return problem === null
                    ? actionFailure("action-failed", "The action failed unexpectedly.", 500)
                    : { ok: false, problem };
            });
        emit(actionResult(action.kind, outcome));
        emit({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId, outcome: { type: "success" } });
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

    async #action(a: ActionRequest, env: ClientEnvelope | null, conversationWorkerId?: number): Promise<ActionOutcome> {
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
            return actionFailure(
                "invalid-action-parameters",
                `Action '${a.kind}' received parameters outside its advertised input schema.`,
                400,
                {
                    issues: admitted.errors,
                    recovery: "Conform the action parameters to discover.actions[<name>].inputSchema.",
                },
            );
        }
        try {
            if (action.scope !== "worldless") Module.#requireWorkspace(a.kind, env);
            const outcome = await action.execute(a.params, env, conversationWorkerId);
            if (!outcome.ok) return outcome;
            const projected = Validator.validateJsonSchemaInstance(action.outputSchema, outcome.result);
            if (!projected.valid) {
                throw new Error(
                    `AG-UI action '${a.kind}' produced output outside its advertised schema: ${JSON.stringify(projected.errors)}`,
                );
            }
            return outcome;
        } catch (err) {
            const problem = problemFromError(err);
            if (problem !== null) return { ok: false, problem };
            console.error(`AG-UI action '${a.kind}' failed:`, err);
            return actionFailure("action-failed", "The action failed unexpectedly.", 500);
        }
    }

}
