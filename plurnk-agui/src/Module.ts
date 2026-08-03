// The in-process transport module (plurnk-agui#2) — what the daemon's boot plug-point
// activates: registerModule(aguiModule(opts)) hands this the CoreSeam handle; it opens
// the AG-UI+ HTTP/SSE listener and owns the client interface from there.
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
import { stateSnapshot, parseAction, actionResult, type ActionRequest, type ActionOutcome } from "./AguiPlus.ts";
import type { DaemonSeam, ClientEnvelope, PlurnkStatement } from "./DaemonSeam.ts";
import { PlurnkParser, UNKNOWN_POSITION } from "@plurnk/plurnk-contracts";
import { EventType, type AguiEvent, type RunAgentInput } from "./types.ts";
import { RunAgentInputSchema, type Interrupt } from "@ag-ui/core";
import { logEntryIdFromToolCallId, proposalInterrupt } from "./AguiPlus.ts";
import { Problems, Validator, type ExecStatement, type OperationResult, type ProblemDetails } from "@plurnk/plurnk-contracts";

export interface ModuleOptions {
    host: string;
    port: number;                 // 0 = ephemeral
    token?: string;               // empty/undefined = local trust (loopback bind is the boundary)
    maxTurns?: number;
    heartbeatMs?: number;         // SSE comment-frame cadence (agui#3); default 15s, 0 disables
}

export interface ModuleRegistration {
    start(seam: DaemonSeam): Promise<Module>;
}

const actionFailure = (
    code: string,
    detail: string,
    status: number = 400,
    extensions: Readonly<Record<string, unknown>> = {},
): ActionOutcome => ({
    ok: false,
    problem: Problems.create("agui:action", code, status, detail, {
        stage: status < 500 ? "action-validation" : "action-execution",
        retryable: false,
        ...extensions,
    }),
});

const httpProblem = (
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
): ProblemDetails => Problems.create("agui:http", code, status, detail, extensions);

class HttpProblemError extends Error {
    readonly problem: ProblemDetails;

    constructor(problem: ProblemDetails) {
        super(problem.detail);
        this.name = "HttpProblemError";
        this.problem = problem;
    }
}

const problemFromError = (error: unknown): ProblemDetails | null => {
    if (error instanceof HttpProblemError) return error.problem;
    if (typeof error !== "object" || error === null) return null;
    const result = (error as { result?: unknown }).result;
    if (result !== undefined) {
        try {
            return Validator.assertOperationResult(result as OperationResult).problem ?? null;
        } catch {
            return null;
        }
    }
    const problem = (error as { problem?: unknown }).problem;
    if (problem !== undefined) {
        try {
            return Validator.assertProblemDetails(problem as ProblemDetails);
        } catch {
            return null;
        }
    }
    return null;
};

const operationOutcome = (result: OperationResult): ActionOutcome => {
    const exact = Validator.assertOperationResult(result);
    return exact.problem === undefined
        ? { ok: true, result: exact }
        : { ok: false, problem: exact.problem };
};

const parseFailureResult = ({
    detail,
    line,
    column,
    source,
    severity,
}: {
    detail: string;
    line: number;
    column: number;
    source: string;
    severity: "error" | "warning";
}): OperationResult => ({
    status: 400,
    problem: Problems.create(
        "agui:action",
        "parse-failed",
        400,
        detail,
        {
            line,
            column,
            source,
            severity,
            stage: "parsing",
            retryable: false,
        },
    ),
});

const writeHttpProblem = (res: ServerResponse, problem: ProblemDetails): void => {
    res.writeHead(problem.status, { "content-type": "application/problem+json" });
    res.end(JSON.stringify(problem));
};

const runErrorEvents = (problem: ProblemDetails): AguiEvent[] => [
    { type: EventType.CUSTOM, name: "plurnk.problem", value: problem },
    { type: EventType.RUN_ERROR, message: problem.detail, code: problem.type },
];

export default class Module {
    #seam: DaemonSeam;
    #opts: ModuleOptions;
    #portal: Portal;
    #http: HttpServer;
    #threads = new Map<string, ClientEnvelope>(); // threadId → envelope
    #threadWorkers = new Map<string, number>();   // threadId → conversation workerId

    static #CONTROL_ACTIONS = Object.freeze([
        "ping", "discover", "providers.list", "workspace.list", "workspace.create", "workspace.attach",
    ]);

    // The control plane vs the world. An AG-UI Run lives in a world (a conversation, or an action
    // that reads/writes a workspace's log); a control-plane action (list/create/attach/discover/
    // auth) does NOT — so it must not bind or forge a workspace (operator ruling 2026-07-10:
    // "every worker/thread requires a world, not everything"). Only these kinds bind a workspace.
    static #WORLD_SCOPED = Object.freeze(new Set([
        "workspace.workers", "log.read", "loop.inject", "loop.cancel", "workspace.prompts", "workspace.rename",
        "workspace.constrain", "workspace.unconstrain", "workspace.constraints", "entry.read",
        "workspace.derivation", "op.exec", "op.parse", "workspace.members", "op.look", "run.fork",
    ]));
    static #BUILTIN_ACTIONS = Object.freeze(new Set([
        ...this.#CONTROL_ACTIONS,
        ...this.#WORLD_SCOPED,
    ]));
    static #NOTIFICATIONS = Object.freeze([
        "log/entry", "loop/terminated", "loop/proposal", "notice/event",
        "stream/event", "stream/concluded", "workspace/branch-batch",
    ]);

    constructor(seam: DaemonSeam, opts: ModuleOptions) {
        this.#seam = seam;
        this.#opts = opts;
        this.#moduleActionNames();
        this.#portal = new Portal(seam);
        this.#http = createServer((req, res) => { void this.#route(req, res); });
    }

    #moduleActionNames(): string[] {
        const names = this.#seam.listModuleActions();
        const seen = new Set<string>();
        for (const name of names) {
            if (Module.#BUILTIN_ACTIONS.has(name)) {
                throw new Error(`module action '${name}' collides with AG-UI built-in action`);
            }
            if (seen.has(name)) throw new Error(`module action '${name}' is registered more than once`);
            seen.add(name);
        }
        return names;
    }

    static init(opts: ModuleOptions): ModuleRegistration {
        return {
            start: async (seam) => {
                const module = new Module(seam, opts);
                await module.listen();
                return module;
            },
        };
    }

    async listen(): Promise<{ host: string; port: number }> {
        this.#portal.start();
        await new Promise<void>((resolve) => this.#http.listen(this.#opts.port, this.#opts.host, resolve));
        const addr = this.#http.address();
        if (addr === null || typeof addr === "string") throw new Error("plurnk-agui: listener bound no TCP address");
        return { host: this.#opts.host, port: addr.port };
    }

    address(): { host: string; port: number } {
        const addr = this.#http.address();
        if (addr === null || typeof addr === "string") throw new Error("plurnk-agui: not listening");
        return { host: this.#opts.host, port: addr.port };
    }

    async close(): Promise<void> {
        this.#portal.stop();
        await new Promise<void>((resolve, reject) => this.#http.close((e) => (e ? reject(e) : resolve())));
    }

    async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
            // Post-headers throw (svc#480): the SSE is already open, so a JSON body is
            // invisible to the event parser. Preserve a contract Problem exactly when
            // one exists; unexpected exceptions become one generic boundary failure.
            for (const event of runErrorEvents(problem)) {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
            }
            res.end();
        }
    }

    // THE PLURNK PARADIGM (operator ruling 2026-07-10): the name IS the identity,
    // verbatim. The workspace is the world ({§agui-thread-binding}) — selected by name via
    // `forwardedProps.plurnk.workspace`; attach it if it exists, create it with EXACTLY that
    // name if it doesn't. No prefixes, no forged names, no dual lookup. The workspace is
    // REQUIRED: a worker has no existence without a world, so its absence is a contract
    // violation the client must fix — never a workspace forged from the threadId.
    // The threadId is the CONVERSATION over that world — resolved to a worker by
    // #conversationWorker (svc#366 landed: the three doors are ensureModelWorker, forkWorker,
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

    // Resolve the thread's conversation worker within its world. Cached per threadId;
    // worker names are immutable so the binding can't rot.
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
        if (action !== null && !Module.#WORLD_SCOPED.has(action.kind)) return await this.#controlRun(action, input, res);

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
        // AG-UI thread ↔ worker (svc#366): the threadId is the conversation over the
        // world. threadId == workspace name binds the model worker (the default conversation);
        // a distinct threadId names its own worker: found by name, else minted via
        // createConversationWorker. The name is the identity at BOTH levels.
        const workerId = await this.#conversationWorker(input.threadId, env);

        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" });
        let finished = false;
        const interrupts: Interrupt[] = [];
        // The heartbeat (agui#3): a long model generation emits NO events, and consumer
        // stacks kill silent bodies (undici's default 300s bodyTimeout — bench's
        // 'terminated' deaths at 371s/711s = last event + 300s). An SSE comment frame
        // every few seconds keeps every consumer fed; parsers skip comments by spec.
        const cadence = this.#opts.heartbeatMs ?? 15_000;
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
                // Terminate-resume, the terminate half: a proposal tool-call ENDS this
                // AG-UI Run (the loop stays paused in-engine awaiting the resume Run).
                if (e.type === "TOOL_CALL_END") {
                    const logEntryId = logEntryIdFromToolCallId((e as { toolCallId: string }).toolCallId);
                    if (logEntryId !== null) interrupts.push(proposalInterrupt(logEntryId));
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
        const boundRun = this.#portal.openThread({ workspaceId, workerId: lifecycleWorkerId, threadId: input.threadId, emit, modelWorkerId: workerId, inputRunId: input.runId });
        emit([
            { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
            stateSnapshot({ providers: this.#seam.listProviders().aliases, workspace: { id: workspaceId, name: env.workspaceName, projectRoot: env.projectRoot } }),
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
                this.#portal.finishRun(workspaceId, events);
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
        await this.#portal.run(boundRun, {
            workspaceId, workerId, prompt,
            ...(forwarded !== undefined && Object.hasOwn(forwarded, "maxTurns")
                ? { maxTurns: forwarded.maxTurns as number }
                : this.#opts.maxTurns !== undefined ? { maxTurns: this.#opts.maxTurns } : {}),
            ...(forwarded !== undefined && Object.hasOwn(forwarded, "flags")
                ? { flags: forwarded.flags as { auto?: boolean } }
                : {}),
            ...(forwarded !== undefined && Object.hasOwn(forwarded, "openPaths")
                ? { openPaths: forwarded.openPaths as string[] }
                : {}),
            // #414 — per-loop model selection: the client sends alias+model on every loop
            // (model = client-resolved <provider>/<model>, #90); forward both, the daemon's
            // runLoop applies precedence (model wins) and resolves the provider per loop.
            ...(forwarded !== undefined && Object.hasOwn(forwarded, "alias")
                ? { alias: forwarded.alias as string }
                : {}),
            ...(forwarded !== undefined && Object.hasOwn(forwarded, "model")
                ? { model: forwarded.model as string }
                : {}),
        });
        // A dropped SSE on a live AG-UI Run cancels the loop (hangup is the abort). A stream we
        // finished ourselves — terminal event or proposal-terminate — leaves the engine
        // alone (the paused loop is exactly what the resume AG-UI Run needs).
        res.on("close", () => {
            if (finished) return;
            this.#seam.cancelDrain(workerId, "client_disconnected");
            finish();
        });
        } catch (err) {
            // Post-headers throw inside the AG-UI Run (svc#480, completed): the frame alone is
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
    // our own stream. No Portal thread, no model worker — nothing to forge (operator ruling:
    // workspace-plane actions must not spin an ephemeral workspace).
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

    // The capability manifest a client probes (`discover`) for exact action/event membership.
    // The built-ins come from the same inventories routing uses; extension names come from core.
    #capabilities(): { methods: Record<string, true>; notifications: Record<string, true> } {
        const methods: Record<string, true> = {};
        for (const k of [
            ...Module.#CONTROL_ACTIONS,
            ...Module.#WORLD_SCOPED,
            ...this.#moduleActionNames(),
        ]) {
            if (methods[k]) throw new Error(`AG-UI action '${k}' is registered more than once`);
            methods[k] = true;
        }
        const notifications: Record<string, true> = {};
        for (const n of Module.#NOTIFICATIONS) notifications[n] = true;
        return { methods, notifications };
    }

    // The action executor — the verb surface. The control plane runs worldless; everything
    // below the guard operates within a bound workspace. An unknown kind is an honest error,
    // never a silent pass-through. loop.inject rides here too (§4): the seam's unified
    // runLoop folds a prompt into the active drain; the steered effect streams on the SSE.
    async #action(a: ActionRequest, env: ClientEnvelope | null, conversationWorkerId?: number): Promise<ActionOutcome> {
        const p = a.params;
        const moduleActions = this.#moduleActionNames();
        try {
            // The control plane — worldless verbs (no bound workspace; #WORLD_SCOPED gates this).
            switch (a.kind) {
                case "ping": return { ok: true, result: {} };
                case "discover": return { ok: true, result: this.#capabilities() };
                case "providers.list": return { ok: true, result: this.#seam.listProviders() };
                case "workspace.list": return { ok: true, result: { workspaces: await this.#seam.listWorkspaces() } };
                case "workspace.create": {
                    // The name IS the identity: an explicit name creates/attaches EXACTLY
                    // that workspace; no name = the daemon names it and the real name binds.
                    if (Object.hasOwn(p, "name") && (typeof p.name !== "string" || p.name.length === 0)) {
                        return actionFailure(
                            "invalid-action-parameters",
                            "workspace.create name is not a non-empty string.",
                            400,
                            { field: "name", recovery: "Provide a non-empty workspace name or omit it." },
                        );
                    }
                    if (typeof p.name === "string") {
                        // The name IS the world here — feed it as the workspace so #envelope
                        // creates/attaches exactly it (p carries no `workspace` of its own).
                        const { env: created } = await this.#envelope(p.name, { ...p, workspace: p.name });
                        return { ok: true, result: { id: created.workspaceId, name: created.workspaceName, workerId: created.workerId } };
                    }
                    const created = await this.#seam.createWorkspace({
                        ...(Object.hasOwn(p, "projectRoot")
                            ? { projectRoot: p.projectRoot as string | null }
                            : {}),
                        ...(Object.hasOwn(p, "constraints")
                            ? { constraints: p.constraints as Array<{ effect: string; glob: string }> }
                            : {}),
                        ...(Object.hasOwn(p, "settings")
                            ? { settings: p.settings as string | object }
                            : {}),
                    });
                    this.#threads.set(created.workspaceName, created);
                    return { ok: true, result: { id: created.workspaceId, name: created.workspaceName, workerId: created.workerId } };
                }
                case "workspace.attach": {
                    // A REAL attach: rebind the thread map to the chosen workspace and hand
                    // back its envelope — the picker does what it says (the unwired kind +
                    // a nil-masking fallback produced the 2026-07-10 front-door disaster).
                    if (typeof p.id !== "number") {
                        return actionFailure(
                            "invalid-action-parameters",
                            "workspace.attach requires a numeric workspace id.",
                            400,
                            {
                                field: "id",
                                recovery: "Provide a workspace id returned by workspace.list.",
                            },
                        );
                    }
                    const att = await this.#seam.attachWorkspace({ workspaceId: p.id, ...(typeof p.workerId === "number" ? { workerId: p.workerId } : {}) });
                    this.#threads.set(att.workspaceName, att);
                    return { ok: true, result: { id: att.workspaceId, name: att.workspaceName, workerId: att.workerId } };
                }
            }
            if (moduleActions.includes(a.kind)) {
                return { ok: true, result: await this.#seam.invokeModuleAction(a.kind, p) };
            }
            // Below this line lives IN a world. An unknown kind is no worker at all; a
            // world-scoped kind with no bound workspace is a routing bug — both surface plainly.
            if (!Module.#WORLD_SCOPED.has(a.kind)) {
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
            if (env === null) throw new Error(`action '${a.kind}' operates within a workspace, but none is bound`);
            switch (a.kind) {
                case "workspace.workers": return { ok: true, result: { workers: await this.#seam.listWorkers(typeof p.id === "number" ? p.id : env.workspaceId) } };
                case "log.read": {
                    // Default worker: the conversation; p.workerId pins another.
                    const readWorkerId = typeof p.workerId === "number" ? p.workerId : conversationWorkerId ?? await this.#seam.ensureModelWorker(env.workspaceId);
                    const entries = await this.#seam.readLog({
                        workspaceId: env.workspaceId,
                        workerId: readWorkerId,
                        ...(Object.hasOwn(p, "limit") ? { limit: p.limit as number } : {}),
                        ...(Object.hasOwn(p, "sinceId") ? { sinceId: p.sinceId as number } : {}),
                        ...(Object.hasOwn(p, "loopId") ? { loopId: p.loopId as number } : {}),
                        ...(Object.hasOwn(p, "turnId") ? { turnId: p.turnId as number } : {}),
                        ...(Object.hasOwn(p, "loopSeq") ? { loopSeq: p.loopSeq as number } : {}),
                        ...(Object.hasOwn(p, "turnSeq") ? { turnSeq: p.turnSeq as number } : {}),
                        ...(Object.hasOwn(p, "sequence") ? { sequence: p.sequence as number } : {}),
                    });
                    return { ok: true, result: { entries } };
                }
                case "loop.inject": {
                    if (typeof p.prompt !== "string" || p.prompt.length === 0) {
                        return actionFailure(
                            "invalid-action-parameters",
                            "loop.inject requires a non-empty prompt.",
                            400,
                            { field: "prompt", recovery: "Provide the prompt to inject." },
                        );
                    }
                    const ack = await this.#seam.runLoop({ workspaceId: env.workspaceId, workerId: conversationWorkerId ?? await this.#seam.ensureModelWorker(env.workspaceId), prompt: p.prompt });
                    return operationOutcome(ack);
                }
                // The stop button (TUI /stop + Ctrl-C, nvim :PlurnkStop): abort the model
                // worker's active drain. Mirrors the SSE-hangup abort, addressable as a verb.
                case "loop.cancel": return { ok: true, result: { cancelled: this.#seam.cancelDrain(conversationWorkerId ?? await this.#seam.ensureModelWorker(env.workspaceId)) } };
                case "workspace.prompts": return {
                    ok: true,
                    result: {
                        prompts: await this.#seam.listPrompts(
                            env.workspaceId,
                            Object.hasOwn(p, "limit") ? p.limit as number : undefined,
                        ),
                    },
                };
                case "workspace.rename": {
                    if (typeof p.name !== "string" || p.name.length === 0) {
                        return actionFailure(
                            "invalid-action-parameters",
                            "workspace.rename requires a non-empty name.",
                            400,
                            { field: "name", recovery: "Provide the new workspace name." },
                        );
                    }
                    return { ok: true, result: await this.#seam.renameWorkspace(env.workspaceId, p.name) };
                }
                case "workspace.constrain": {
                    if (typeof p.effect !== "string" || typeof p.glob !== "string") {
                        return actionFailure(
                            "invalid-action-parameters",
                            "workspace.constrain requires string effect and glob parameters.",
                            400,
                            { fields: ["effect", "glob"], recovery: "Provide both constraint parameters." },
                        );
                    }
                    return { ok: true, result: await this.#seam.constrain(env.workspaceId, p.effect, p.glob) };
                }
                case "workspace.unconstrain": {
                    if (typeof p.effect !== "string" || typeof p.glob !== "string") {
                        return actionFailure(
                            "invalid-action-parameters",
                            "workspace.unconstrain requires string effect and glob parameters.",
                            400,
                            { fields: ["effect", "glob"], recovery: "Provide both constraint parameters." },
                        );
                    }
                    return { ok: true, result: await this.#seam.unconstrain(env.workspaceId, p.effect, p.glob) };
                }
                case "workspace.constraints": return { ok: true, result: { constraints: await this.#seam.listConstraints(env.workspaceId) } };
                case "workspace.derivation": return { ok: true, result: { status: this.#seam.workspaceDerivationStatus(env.workspaceId) } };
                case "entry.read": {
                    if (typeof p.target !== "string") {
                        return actionFailure(
                            "invalid-action-parameters",
                            "entry.read requires a string target.",
                            400,
                            { field: "target", recovery: "Provide an entry URI." },
                        );
                    }
                    return operationOutcome(await this.#seam.readEntry({
                        workspaceId: env.workspaceId,
                        target: p.target,
                        ...(Object.hasOwn(p, "channel") ? { channel: p.channel as string } : {}),
                        ...(Object.hasOwn(p, "offset") ? { offset: p.offset as number } : {}),
                    }));
                }
                case "op.exec": {
                    // EXEC constructed structurally (no DSL text): the model-facing shape,
                    // proposal-gated by the engine like any client op.
                    if (typeof p.command !== "string" || p.command.length === 0) {
                        return actionFailure(
                            "invalid-action-parameters",
                            "op.exec requires a non-empty command.",
                            400,
                            { field: "command", recovery: "Provide the command to execute." },
                        );
                    }
                    const statement: ExecStatement = {
                        op: "EXEC", suffix: "", signal: null, target: null,
                        lineMarker: null, body: p.command, position: UNKNOWN_POSITION,
                    };
                    // Client ops journal as client-origin turns in the client worker (worker split:
                    // only LOOPS live in the model worker).
                    const [result] = await this.#seam.dispatchClientAction({ workspaceId: env.workspaceId, workerId: env.workerId, statements: [statement] });
                    if (result === undefined) throw new Error("op.exec dispatch returned no operation result");
                    return operationOutcome(result);
                }
                case "op.parse": {
                    // Raw DSL is parsed at the module's edge; statements and parser facts project
                    // through one ordered result contract. {§agui-op-parse}
                    if (typeof p.text !== "string" || p.text.length === 0) {
                        return actionFailure(
                            "invalid-action-parameters",
                            "op.parse requires non-empty PLURNK text.",
                            400,
                            { field: "text", recovery: "Provide PLURNK statements to parse." },
                        );
                    }
                    const parsed = PlurnkParser.parseClient(p.text);
                    const results: Array<OperationResult | null> = [];
                    const statements: PlurnkStatement[] = [];
                    for (const item of parsed.items) {
                        if (item.kind === "error") {
                            results.push(parseFailureResult({
                                detail: item.error.message,
                                line: item.error.line,
                                column: item.error.column,
                                source: item.error.source,
                                severity: item.error.severity,
                            }));
                            continue;
                        }
                        if (item.kind !== "statement") continue; // interstitial text isn't dispatchable
                        statements.push(item.statement as unknown as PlurnkStatement);
                        results.push(null);
                    }
                    if (parsed.unparsedTail !== undefined) {
                        results.push(parseFailureResult({
                            detail: parsed.unparsedTail.reason,
                            line: parsed.unparsedTail.from.line,
                            column: parsed.unparsedTail.from.column,
                            source: "grammar",
                            severity: "error",
                        }));
                    }
                    const dispatched = statements.length === 0
                        ? []
                        : await this.#seam.dispatchClientAction({ workspaceId: env.workspaceId, workerId: env.workerId, statements });
                    let index = 0;
                    for (let i = 0; i < results.length; i++) {
                        if (results[i] === null) results[i] = dispatched[index++];
                    }
                    return { ok: true, result: { results } };
                }
                case "workspace.members": return { ok: true, result: await this.#seam.listMembers(env.workspaceId) };
                case "op.look": {
                    // {§agui-op-look}
                    if (typeof p.text !== "string" || p.text.length === 0) {
                        return actionFailure(
                            "invalid-action-parameters",
                            "op.look requires non-empty PLURNK text.",
                            400,
                            { field: "text", recovery: "Provide one PLURNK statement to observe." },
                        );
                    }
                    const parsed = PlurnkParser.parseClient(p.text);
                    const diagnostic = parsed.items.find((item) => item.kind === "error");
                    if (diagnostic !== undefined && diagnostic.kind === "error") {
                        return operationOutcome(parseFailureResult({
                            detail: diagnostic.error.message,
                            line: diagnostic.error.line,
                            column: diagnostic.error.column,
                            source: diagnostic.error.source,
                            severity: diagnostic.error.severity,
                        }));
                    }
                    if (parsed.unparsedTail !== undefined) {
                        return operationOutcome(parseFailureResult({
                            detail: parsed.unparsedTail.reason,
                            line: parsed.unparsedTail.from.line,
                            column: parsed.unparsedTail.from.column,
                            source: "grammar",
                            severity: "error",
                        }));
                    }
                    const textItem = parsed.items.find((item) => item.kind === "text");
                    if (textItem !== undefined && textItem.kind === "text") {
                        return actionFailure(
                            "invalid-action-parameters",
                            "op.look parsed text outside the statement; only surrounding whitespace is allowed.",
                            400,
                            {
                                field: "text",
                                line: textItem.position.line,
                                column: textItem.position.column,
                                recovery: "Remove text outside the LOOK statement.",
                            },
                        );
                    }
                    const statements = parsed.items.filter((item) => item.kind === "statement");
                    if (statements.length !== 1) {
                        return actionFailure(
                            "invalid-action-parameters",
                            `op.look parsed ${statements.length} statements; exactly one LOOK statement is required.`,
                            400,
                            { field: "text", recovery: "Provide exactly one valid LOOK statement." },
                        );
                    }
                    const [item] = statements;
                    if (item.statement.op !== "LOOK") {
                        return actionFailure(
                            "invalid-action-parameters",
                            `op.look parsed ${item.statement.op}; the single statement must be LOOK.`,
                            400,
                            { field: "text", recovery: "Use LOOK as the observation operation." },
                        );
                    }
                    const statement = { ...(item.statement as unknown as Record<string, unknown>), op: "READ" } as unknown as PlurnkStatement;
                    return operationOutcome(await this.#seam.look({ workspaceId: env.workspaceId, workerId: env.workerId, statement }));
                }
                case "run.fork": return { ok: true, result: await this.#seam.forkWorker({ workspaceId: env.workspaceId, workerId: conversationWorkerId ?? await this.#seam.ensureModelWorker(env.workspaceId), ...(typeof p.name === "string" ? { name: p.name } : {}) }) };
                default: return actionFailure(
                    "unknown-action",
                    `Action '${a.kind}' is not registered.`,
                    404,
                    {
                        requestedAction: a.kind,
                        recovery: "Use an action advertised by discover.",
                    },
                );
            }
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
