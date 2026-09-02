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
import { derivationActivity, stateDelta, stateSnapshot, statusState, parseAction, actionResult, type ActionRequest, type ActionOutcome, type AguiStatusState } from "./AguiPlus.ts";
import { EventType, type AguiEvent, type RunAgentInput } from "./types.ts";
import { aguiRouteTemplate, observed } from "./observe.ts";
import { RunAgentInputSchema, type Interrupt } from "@ag-ui/core";
import { Problems, Validator, type AguiDiscovery, type ApplicationPort, type ClientEnvelope, type ProblemDetails } from "@plurnk/plurnk-contracts";
import { AGUI_BUILTIN_ACTIONS, AGUI_NOTIFICATIONS, type AguiActionContract } from "./AguiSurface.ts";
import { resolveModuleOptions, type ModuleOptions, type ResolvedModuleOptions } from "./config.ts";
import { HttpProblemError, actionFailure, problemFromError } from "./action-results.ts";
import BuiltinActions from "./BuiltinActions.ts";

export type { ModuleOptions } from "./config.ts";

export interface ModuleRegistration {
    start(seam: ApplicationPort): Promise<Module>;
}

const httpProblem = (
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
): ProblemDetails => Problems.create("agui:http", code, status, detail, extensions);



const writeHttpProblem = (res: ServerResponse, problem: ProblemDetails): void => {
    res.writeHead(problem.status, { "content-type": "application/problem+json" });
    res.end(JSON.stringify(problem));
};

const runErrorEvents = (problem: ProblemDetails): AguiEvent[] => [
    { type: EventType.CUSTOM, name: "plurnk.problem", value: problem },
    { type: EventType.RUN_ERROR, message: problem.detail, code: problem.type },
];

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
    #threads = new Map<string, ClientEnvelope>(); // threadId → envelope
    #threadWorkers = new Map<string, number>();   // threadId → conversation workerId
    #actions = new Map<string, RegisteredAction>();
    #listening = false;
    #activated = false;
    readonly #builtins = new BuiltinActions({ threads: this.#threads, seam: () => this.#seam, capabilities: this.#capabilities.bind(this), envelope: this.#envelope.bind(this), requireWorkspace: Module.#requireWorkspace });
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
            if (req.method === "POST" && (req.url === "/" || req.url === "/agui")) return await this.#run(req, res);
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
        const cached = this.#threads.get(threadId);
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
        this.#threads.set(threadId, env);
        return { env, reattached };
    }

    // Resolve the thread's conversation worker within its world. Cached per
    // threadId; worker names are immutable so the binding cannot rot. Durable
    // capability changes use worker.capabilities.set; per-run attenuation belongs
    // to the loop policy forwarded below.
    async #conversationWorker(threadId: string, env: ClientEnvelope): Promise<number> {
        const cached = this.#threadWorkers.get(threadId);
        if (cached !== undefined) return cached;
        const workerId = threadId === env.workspaceName
            ? await this.#seam.ensureModelWorker(env.workspaceId)
            : (await this.#seam.listWorkers(env.workspaceId)).find((r) => r.name === threadId)?.id
                ?? (await this.#seam.createConversationWorker({ workspaceId: env.workspaceId, name: threadId })).workerId;
        this.#threadWorkers.set(threadId, workerId);
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

    async #run(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
        const parsed = RunAgentInputSchema.safeParse(decoded);
        if (!parsed.success) {
            throw new HttpProblemError(httpProblem(
                "invalid-run-input",
                400,
                "The request body does not satisfy the AG-UI RunAgentInput contract.",
                {
                    stage: "request-validation",
                    issues: parsed.error.issues,
                    retryable: false,
                },
            ));
        }
        const input: RunAgentInput = parsed.data;
        const forwarded = (input.forwardedProps as { plurnk?: Record<string, unknown> } | undefined)?.plurnk;

        // Control plane FIRST: a management action that doesn't live in a world (and an
        // unknown kind, which is no worker at all) answers without binding — or forging — a
        // workspace. Only world-scoped actions and conversations reach #envelope below.
        const action = parseAction(input.forwardedProps);
        if (action !== null && !this.#requiresWorkspace(action.kind)) {
            return await this.#controlRun(action, input, res);
        }

        let prompt: string | null = null;
        if (action === null && input.resume === undefined) {
            const lastUser = [...input.messages].reverse().find((message) => message.role === "user");
            if (lastUser === undefined || typeof lastUser.content !== "string" || lastUser.content.length === 0) {
                throw new HttpProblemError(httpProblem(
                    "user-message-required",
                    400,
                    "A new AG-UI Run requires a non-empty textual user message.",
                    {
                        stage: "request-validation",
                        recovery: "Provide a non-empty user message.",
                        retryable: false,
                    },
                ));
            }
            prompt = lastUser.content;
        }

        const { env, reattached } = await this.#envelope(input.threadId, forwarded);
        const workspaceId = env.workspaceId;
        // {§agui-thread-binding} The threadId is the conversation over the
        // world. threadId == workspace name binds the model worker (the default conversation);
        // a distinct threadId names its own worker: found by name, else minted via
        // createConversationWorker. The name is the identity at BOTH levels.
        const workerId = await this.#conversationWorker(input.threadId, env);

        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" });
        let finished = false;
        const interrupts: Interrupt[] = [];
        // {§agui-configuration}: long generations can emit no events; SSE comments keep
        // consumers fed without adding protocol events.
        const cadence = this.#opts.heartbeatMs;
        const heartbeat = cadence > 0 ? setInterval(() => { res.write(": hb\n\n"); }, cadence) : null;
        const finish = (): void => {
            if (finished) return;
            finished = true;
            if (heartbeat !== null) clearInterval(heartbeat);
            this.#portal.closeRun(workspaceId, boundRun);
            res.end();
        };
        const emit = (events: AguiEvent[]): void => {
            for (const e of events) {
                res.write(`data: ${JSON.stringify(e)}\n\n`);
                // Terminate-resume, the terminate half: a stopped-world tool call
                // ends this AG-UI Run while its core owner remains paused.
                if (e.type === "TOOL_CALL_END") {
                    const interrupt = this.#portal.interruptForToolCall(
                        (e as { toolCallId: string }).toolCallId,
                    );
                    if (interrupt !== null) interrupts.push(interrupt);
                }
                if (e.type === "RUN_FINISHED" || e.type === "RUN_ERROR") finish();
            }
            if (interrupts.length > 0 && !finished) {
                res.write(`data: ${JSON.stringify({
                    type: EventType.RUN_FINISHED,
                    threadId: input.threadId,
                    runId: input.runId,
                    outcome: { type: "interrupt", interrupts: interrupts.splice(0) },
                })}\n\n`);
                finish();
            }
        };

        const lifecycleWorkerId = action?.kind === "op.exec" || action?.kind === "op.parse" ? env.workerId : workerId;
        const notificationScope = action === null
            ? "conversation"
            : action.kind === "op.exec" || action.kind === "op.parse"
                ? "operation"
                : "result";
        const boundRun = this.#portal.openThread({
            workspaceId,
            workerId: lifecycleWorkerId,
            threadId: input.threadId,
            notificationScope,
            emit,
            modelWorkerId: workerId,
            inputRunId: input.runId,
            ...(input.resume === undefined ? {} : { resume: input.resume }),
        });
        const status = await this.#workerStatus(workspaceId, workerId);
        emit([
            { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
            stateSnapshot({ providers: this.#seam.listProviders().aliases, workspace: { id: workspaceId, name: env.workspaceName, projectRoot: env.projectRoot }, status }),
        ]);
        if (finished) return;

        try {
        // §3 — a management-action AG-UI Run (forwardedProps.plurnk.action): execute via the
        // seam; the outcome rides the workspace's CURRENT thread binding (Portal.finishRun),
        // never this closure — a proposal-gated action (op.exec → 202) terminates THIS
        // AG-UI Run and completes after the resume AG-UI Run rebinds the stream.
        if (action !== null) {
            const finishAction = (outcome: ActionOutcome): void => {
                const events = [actionResult(action.kind, outcome)];
                // Plain action (stream still open): answer on OUR OWN stream — concurrent
                // actions share a workspace, and the workspace binding is whoever bound last
                // (results would cross streams). Only a proposal-pause (this stream already
                // terminated) hands off to the workspace binding, which the resume AG-UI Run rebinds.
                if (!finished) {
                    this.#portal.finishThread(boundRun, events);
                    return;
                }
                this.#portal.finishRun(workspaceId, lifecycleWorkerId, input.threadId, events);
            };
            void this.#action(action, env, workerId)
                // One queue barrier: a dispatch's channel notifies are enqueued but not yet
                // delivered when its promise resolves — drain them so Portal's stream
                // bookkeeping arms BEFORE the finish decision (then stream/concluded,
                // not a timer, releases any deferral).
                .then(async (outcome) => { await new Promise((r) => setImmediate(r)); finishAction(outcome); })
                .catch((err: unknown) => {
                    console.error(`AG-UI action '${action.kind}' failed:`, err);
                    const problem = problemFromError(err);
                    finishAction(problem === null
                        ? actionFailure("action-failed", "The action failed unexpectedly.", 500)
                        : { ok: false, problem });
                });
            res.on("close", () => {
                if (finished) return;
                this.#seam.cancelDrain(lifecycleWorkerId, "client_disconnected");
                finish();
            });
            return;
        }

        // AG-UI interrupt resume: this is a new AG-UI Run on the same thread. Bind it
        // to the durable continuation before releasing the proposal.
        if (input.resume !== undefined) {
            await this.#portal.resolve(workspaceId, boundRun, input.resume);
            res.on("close", finish); // client hangup on a resume just detaches; the loop is already active
            return;
        }

        if (prompt === null) throw new Error("conversation AG-UI Run reached dispatch without a validated prompt");

        if (reattached) {
            const history = await this.#seam.readLog({ workspaceId, workerId, limit: 1000 }).catch(() => null);
            if (history !== null) emit(this.#portal.replay(boundRun, history));
        }
        const started = await this.#portal.run(boundRun, {
            workspaceId, workerId, prompt,
            ...(forwarded !== undefined && Object.hasOwn(forwarded, "maxTurns")
                ? { maxTurns: forwarded.maxTurns as number }
                : this.#opts.maxTurns !== undefined ? { maxTurns: this.#opts.maxTurns } : {}),
            ...(forwarded !== undefined && Object.hasOwn(forwarded, "policy")
                ? { policy: forwarded.policy as Parameters<ApplicationPort["runLoop"]>[0]["policy"] }
                : {}),
            ...(forwarded !== undefined && Object.hasOwn(forwarded, "openPaths")
                ? { openPaths: forwarded.openPaths as string[] }
                : {}),
            // {§methods-loop-run-model} The client may still forward one explicit
            // alias-or-provider/model selector. The daemon
            // persists an explicit selection onto the worker and snapshots it on the
            // loop; an omitted selector continues the worker's durable model.
            ...(forwarded !== undefined && Object.hasOwn(forwarded, "selector")
                ? { selector: forwarded.selector as string }
                : {}),
            ...(forwarded !== undefined && Object.hasOwn(forwarded, "childSelector")
                ? { childSelector: forwarded.childSelector as string | null }
                : {}),
        });
        if (started !== null && !finished) {
            const currentStatus = await this.#workerStatus(workspaceId, workerId);
            if (!finished) {
                emit([stateDelta([{
                    op: "replace",
                    path: "/plurnk/status",
                    value: currentStatus,
                }])]);
            }
        }
        // A dropped SSE on a live AG-UI Run cancels the loop (hangup is the abort). A stream we
        // finished ourselves — terminal event or proposal-terminate — leaves the engine
        // alone (the paused loop is exactly what the resume AG-UI Run needs).
        res.on("close", () => {
            if (finished) return;
            this.#seam.cancelDrain(workerId, "client_disconnected");
            finish();
        });
        } catch (err) {
            // {§agui-http-failure} After headers, the frame alone is
            // not enough — the heartbeat interval and the Portal binding are live, and a
            // throw that escapes past finish() leaks them forever (the drill-hang). emit()
            // writes the terminal frame AND finish()es on RUN_ERROR — one door out.
            const exactProblem = problemFromError(err);
            if (exactProblem === null) console.error("AG-UI Run failed:", err);
            const problem = exactProblem ?? httpProblem(
                "run-failed",
                500,
                "The AG-UI Run failed unexpectedly.",
                {
                    stage: "run",
                    retryable: false,
                },
            );
            emit(runErrorEvents(problem));
        }
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

    static #body(req: IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            let data = "";
            req.on("data", (c: Buffer) => { data += c.toString(); });
            req.on("end", () => resolve(data));
            req.on("error", reject);
        });
    }
}
