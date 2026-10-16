import { Problems } from "@plurnk/plurnk-contracts";
// The AG-UI Run endpoint: one client run resolved to its worker, streamed, and settled. Split out of the module, which keeps the delegating entry point.
import { type IncomingMessage, type ServerResponse } from "node:http";
import Portal from "./Portal.ts";
import Translator from "./Translator.ts";
import MessageAddress from "./MessageAddress.ts";
import { stateSnapshot, parseAction, actionResult, derivationActivity, type ActionRequest, type ActionOutcome, type AguiStatusState } from "./AguiPlus.ts";
import { EventType, type AguiEvent, type RunAgentInput, type UserMessage } from "./types.ts";
import { type Interrupt } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { type ClientEnvelope } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { type ResolvedModuleOptions } from "./config.ts";
import { type OperationLoopListener } from "./BuiltinActions.ts";
import { HttpProblemError, actionFailure } from "./action-results.ts";
import { httpProblem, runErrorEvents } from "./run-events.ts";

// {§agui-action-binding} What a Run binds of the worker its thread names: it may create it (and its world), it
// requires it, it binds none and creates nothing (`attach`), or it binds none and may bring the world into being.
export type WorkerBinding = "create" | "required" | "attach" | "none";

// {§module-seam-slices} — the calls a Run makes outside its Portal thread.
export type RunPort = Pick<ApplicationPort, "configurationNotices" | "listProviders" | "readLog" | "registerWorkerOwner" | "claimWorkerOwner" | "activateWorkspace" | "workspacePreparationStatus" | "workspaceDerivationStatus">;

export default class RunHandler {
    readonly #seam: () => RunPort;
    readonly #opts: () => ResolvedModuleOptions;
    readonly #portal: () => Portal;
    readonly #requiresWorkspace: (action: ActionRequest) => boolean;
    readonly #controlRun: (action: ActionRequest, input: RunAgentInput, res: ServerResponse, principal: string) => Promise<void>;
    readonly #envelope: (threadId: string, forwarded?: Record<string, unknown>, options?: { readonly create?: boolean }) => Promise<{ env: ClientEnvelope; reattached: boolean }>;
    readonly #boundWorker: (threadId: string, env: ClientEnvelope, binding: "create" | "required") => Promise<number>;
    readonly #actionBinding: (action: ActionRequest) => WorkerBinding;
    readonly #workerStatus: (workspaceId: number, workerId: number) => Promise<AguiStatusState>;
    readonly #action: (a: ActionRequest, input: RunAgentInput, env: ClientEnvelope | null, boundWorkerId: number | undefined, principal: string, onLoop: OperationLoopListener | undefined) => Promise<ActionOutcome>;

    constructor({ seam, opts, portal, requiresWorkspace, controlRun, envelope, boundWorker, actionBinding, workerStatus, action }: {
        seam: () => RunPort;
        opts: () => ResolvedModuleOptions;
        portal: () => Portal;
        requiresWorkspace: (action: ActionRequest) => boolean;
        controlRun: (action: ActionRequest, input: RunAgentInput, res: ServerResponse, principal: string) => Promise<void>;
        envelope: (threadId: string, forwarded?: Record<string, unknown>, options?: { readonly create?: boolean }) => Promise<{ env: ClientEnvelope; reattached: boolean }>;
        boundWorker: (threadId: string, env: ClientEnvelope, binding: "create" | "required") => Promise<number>;
        actionBinding: (action: ActionRequest) => WorkerBinding;
        workerStatus: (workspaceId: number, workerId: number) => Promise<AguiStatusState>;
        action: (a: ActionRequest, input: RunAgentInput, env: ClientEnvelope | null, boundWorkerId: number | undefined, principal: string, onLoop: OperationLoopListener | undefined) => Promise<ActionOutcome>;
    }) {
        this.#seam = seam;
        this.#opts = opts;
        this.#portal = portal;
        this.#requiresWorkspace = requiresWorkspace;
        this.#controlRun = controlRun;
        this.#envelope = envelope;
        this.#boundWorker = boundWorker;
        this.#actionBinding = actionBinding;
        this.#workerStatus = workerStatus;
        this.#action = action;
    }

    // {§agui-http-authorization} — the principal and credential family the perimeter admitted this request under.
    async run(req: IncomingMessage, res: ServerResponse, connect = false, principal = "anonymous", family: string | null = null): Promise<void> {
        let decoded: unknown;
        try {
            decoded = JSON.parse(await RunHandler.#body(req));
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
        if (forwarded?.control !== undefined && typeof forwarded.control !== "boolean") {
            throw new HttpProblemError(httpProblem("control-invalid", 400, "control must be a boolean.",
                { stage: "request-validation", retryable: false }));
        }
        if (forwarded?.interactive !== undefined && typeof forwarded.interactive !== "boolean") {
            throw new HttpProblemError(httpProblem("interactive-invalid", 400, "interactive must be a boolean.",
                { stage: "request-validation", retryable: false }));
        }
        const mode = forwarded?.mode;
        if (mode !== undefined && mode !== "sync") {
            throw new HttpProblemError(httpProblem(
                "unsupported-run-mode",
                400,
                'forwardedProps.plurnk.mode must be "sync" when present.',
                { stage: "request-validation", retryable: false },
            ));
        }
        const synchronize = connect || mode === "sync";

        // Control plane FIRST: a management action that doesn't live in a world, and one the module does not
        // register or whose input it refuses, answers without binding — or forging — a workspace
        // ({§agui-action-binding}). Only admitted world-scoped actions, message Runs and sync Runs reach #envelope below.
        const action = parseAction(input.forwardedProps);
        if (synchronize && (action !== null || input.resume !== undefined || input.messages.length > 0)) {
            throw new HttpProblemError(httpProblem(
                "invalid-sync-input",
                400,
                "A sync Run cannot include messages, an action, or an interrupt resume.",
                { stage: "request-validation", retryable: false },
            ));
        }
        if (action !== null && !this.#requiresWorkspace(action)) {
            return await this.#controlRun(action, input, res, principal);
        }

        let prompt: string | null = null;
        let currentUser: UserMessage | null = null;
        if (!synchronize && action === null && input.resume === undefined) {
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
            currentUser = lastUser;
        }

        // {§agui-thread-binding} {§agui-action-binding} The threadId names its worker, never compared with the
        // workspace's name. A message, a setting, or its owner's session attaching creates it; watching passively
        // or reading never does. A Run that requires an existing worker, or creates nothing, attaches to an
        // existing world: a world that does not exist has no worker. A resume continues the Run whose interrupt it
        // answers: it binds the worker that Run bound, if any.
        const binding: WorkerBinding = input.resume !== undefined ? "attach"
            : synchronize ? forwarded?.control === true ? "create" : "required"
            : action === null ? "create" : this.#actionBinding(action);
        const { env, reattached } = await this.#envelope(input.threadId, forwarded, {
            create: binding === "create" || binding === "none",
        });
        const workspaceId = env.workspaceId;
        const workerId = binding === "create" || binding === "required"
            ? await this.#boundWorker(input.threadId, env, binding)
            : input.resume === undefined ? undefined : this.#portal().resumedWorker(workspaceId, input.threadId, input.resume);
        // {§agui-sync} A passive observation claims nothing; an owner's control connection claims as a message Run does.
        const control = forwarded?.control === true || (!synchronize && action === null);
        const owner = control ? MessageAddress.owner(principal, input.threadId) : undefined;
        if (owner !== undefined) {
            // {§agui-worker-owner} The Run declares the owner's capability set: the tools it
            // implements, and whether a person attends it. Unstated, nobody does.
            await this.#seam().registerWorkerOwner(workspaceId, {
                address: owner, tools: [...new Set(input.tools.map(({ name }) => name))], interactive: forwarded?.interactive === true,
            });
            if (workerId !== undefined) await this.#seam().claimWorkerOwner({ workspaceId, workerId, owner });
            // {§agui-owner-activation} — an owner's arrival is the workspace's demand: activation starts now,
            // so a first prompt finds it under way or done, and nothing waits for it here.
            void this.#seam().activateWorkspace({ workspaceId }).catch((cause: unknown) => {
                console.error(`AG-UI: activating workspace ${workspaceId} for its owner failed:`, cause);
            });
        }

        let finished = false;
        const interrupts: Interrupt[] = [];
        const finish = (): void => {
            if (finished) return;
            finished = true;
            if (heartbeat !== null) clearInterval(heartbeat);
            this.#portal().closeRun(workspaceId, boundRun);
            res.end();
        };
        const emit = (events: AguiEvent[]): void => {
            if (finished) return;
            for (const e of events) {
                res.write(`data: ${JSON.stringify(e)}\n\n`);
                // Terminate-resume, the terminate half: a stopped-world tool call
                // ends this AG-UI Run while its core owner remains paused.
                if (e.type === "TOOL_CALL_END") {
                    const interrupt = this.#portal().interruptForToolCall(
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

        // {§agui-run-start} The Portal routes to this Run from the moment it is bound; what reaches it
        // before RUN_STARTED and the snapshot are written follows them, in order. A terminal ends it at once.
        let presented = false;
        const held: AguiEvent[] = [];
        const routed = (events: AguiEvent[]): void => {
            if (presented) return emit(events);
            const terminal = events.filter(({ type }) => type === EventType.RUN_ERROR || type === EventType.RUN_FINISHED);
            if (terminal.length === 0) return void held.push(...events);
            held.length = 0;
            emit(terminal);
        };

        const notificationScope = action === null
            ? "worker"
            : action.kind === "op.exec" || action.kind === "op.parse"
                ? "operation"
                : "result";
        // {§agui-delegation-observation} — a message Run may ask for its descendants' rows.
        const descendants = action === null && forwarded?.descendants === true;
        const boundRun = this.#portal().openThread({
            workspaceId,
            // {§agui-broadcast-fan} An operation Run learns its Worker and Loop from the dispatch that opens them.
            workerId: notificationScope === "operation" ? null : workerId ?? null,
            threadId: input.threadId,
            notificationScope,
            ...(owner === undefined ? {} : { owner }),
            family,
            descendants,
            emit: routed,
            modelWorkerId: workerId,
            inputRunId: input.runId,
            cancelOnDisconnect: prompt !== null || notificationScope === "operation",
            ...(input.resume === undefined ? {} : { resume: input.resume }),
        });
        // {§agui-shutdown} Acquire the Run before committing headers or a heartbeat:
        // preparation may have crossed module closure.
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" });
        // {§agui-configuration} SSE comments keep quiet generations connected.
        const cadence = this.#opts().heartbeatMs;
        const heartbeat = cadence > 0 ? setInterval(() => { res.write(": hb\n\n"); }, cadence) : null;
        // {§agui-run-disconnect} Install once, before any asynchronous preparation.
        const disconnected = (): void => {
            if (finished) return;
            this.#portal().disconnect(boundRun);
            finish();
        };
        res.once("close", disconnected);
        if (res.destroyed) { disconnected(); return; }
        try {
        // A Run that binds no worker has no worker status to report.
        const status = workerId === undefined ? undefined : await this.#workerStatus(workspaceId, workerId);
        if (finished) return;
        let providers;
        let catalogProblem;
        try { providers = this.#seam().listProviders().aliases; }
        catch (cause) {
            catalogProblem = Problems.fromError(cause);
            if (catalogProblem === null) throw cause;
        }
        emit(this.#portal().runStarted(
            boundRun,
            stateSnapshot({
                ...(providers === undefined ? {} : { providers }),
                workspace: {
                    id: workspaceId, name: env.workspaceName, projectRoot: env.projectRoot, projectLabel: env.projectLabel,
                    preparation: this.#seam().workspacePreparationStatus(workspaceId),
                    activity: derivationActivity(this.#seam().workspaceDerivationStatus(workspaceId)),
                },
                ...(status === undefined ? {} : { status }),
            }),
        ));
        presented = true;
        emit(held.splice(0));
        if (catalogProblem !== undefined) emit([{ type: EventType.CUSTOM, name: "plurnk.problem", value: catalogProblem }]);
        if (finished) return;

        // {§agui-sync} — the existing Run endpoint can project the
        // bound worker's durable log without admitting a prompt or starting inference.
        // A live Loop remains observed; an idle one settles after its snapshot.
        if (synchronize) {
            for (const notice of this.#seam().configurationNotices()) {
                emit([{ type: EventType.CUSTOM, name: "plurnk.notice", value: notice }]);
            }
            // A sync Run requires its worker ({§agui-action-binding}), so one is bound here.
            const history = await this.#history(workspaceId, workerId!);
            if (finished) return;
            emit(this.#portal().replay(boundRun, history));
            if (finished) return;
            await this.#portal().synchronize(workspaceId, boundRun, connect);
            return;
        }

        // A management-action AG-UI Run (forwardedProps.plurnk.action): executed via the seam and answered on
        // this Run's own stream; concurrent actions share a workspace, and a result never rides another Run.
        // A client operation's Run observes the loop its dispatch opens ({§agui-broadcast-fan}).
        if (action !== null) {
            const finishAction = (outcome: ActionOutcome): void => {
                if (!finished) this.#portal().finishThread(boundRun, [actionResult(action.kind, outcome)]);
            };
            const onLoop: OperationLoopListener | undefined = notificationScope === "operation"
                ? (loop) => { this.#portal().bindOperation(boundRun, loop); }
                : undefined;
            void this.#action(action, input, env, workerId, principal, onLoop)
                // One queue barrier: a dispatch's channel notifies are enqueued but not yet
                // delivered when its promise resolves — drain them so Portal's stream
                // bookkeeping arms BEFORE the finish decision (then stream/concluded,
                // not a timer, releases any deferral).
                .then(async (outcome) => { await new Promise((r) => setImmediate(r)); finishAction(outcome); })
                .catch((err: unknown) => {
                    console.error(`AG-UI action '${action.kind}' failed:`, err);
                    const problem = Problems.fromError(err);
                    finishAction(problem === null
                        ? actionFailure("action-failed", "The action failed unexpectedly.", 500)
                        : { ok: false, problem });
                });
            return;
        }

        // AG-UI interrupt resume: this is a new AG-UI Run on the same thread. Bind it
        // to its presentation's continuation before releasing the proposal.
        if (input.resume !== undefined) {
            await this.#portal().resolve(workspaceId, boundRun, input.resume);
            return;
        }

        if (prompt === null || currentUser === null || workerId === undefined) throw new Error("message AG-UI Run reached dispatch without a validated prompt and its worker");

        if (reattached) {
            const history = await this.#history(workspaceId, workerId).catch(() => null);
            if (finished) return;
            if (history !== null && !RunHandler.#isOriented(input, history)) {
                const replayUser = currentUser ?? undefined;
                emit(this.#portal().replay(boundRun, history, replayUser));
            }
        }
        const started = await this.#portal().run(boundRun, {
            workspaceId, workerId, prompt,
            ...MessageAddress.submission(principal, input, currentUser),
            ...(forwarded !== undefined && Object.hasOwn(forwarded, "maxTurns")
                ? { maxTurns: forwarded.maxTurns as number }
                : this.#opts().maxTurns !== undefined ? { maxTurns: this.#opts().maxTurns } : {}),
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
            if (!finished) emit(this.#portal().replaceStatus(boundRun, currentStatus));
        }
        } catch (err) {
            // {§agui-http-failure} After headers, the frame alone is
            // not enough — the heartbeat interval and the Portal binding are live, and a
            // throw that escapes past finish() leaks them forever (the drill-hang). emit()
            // writes the terminal frame AND finish()es on RUN_ERROR — one door out.
            const exactProblem = Problems.fromError(err);
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
            this.#portal().failThread(boundRun, runErrorEvents(problem));
        }
    }

    // {§agui-snapshot} A snapshot is every message the live projection built, so it reads the whole log, page by page.
    async #history(workspaceId: number, workerId: number): Promise<Array<Record<string, unknown>>> {
        const rows: Array<Record<string, unknown>> = [];
        for (let beforeId: number | undefined; ;) {
            const cursor = beforeId;
            const page = await this.#seam().readLog({ workspaceId, workerId, limit: Number.MAX_SAFE_INTEGER, ...(cursor === undefined ? {} : { beforeId: cursor }) });
            const older = cursor === undefined ? page : page.filter(({ id }) => id < cursor);
            if (older.length === 0) return rows;
            rows.push(...older);
            beforeId = Math.min(...older.map(({ id }) => id));
        }
    }

    static #isOriented(input: RunAgentInput, history: ReadonlyArray<Record<string, unknown>>): boolean {
        const durableMessageIds = new Set(history.flatMap((entry) =>
            Translator.isResponse(entry, input.threadId)
                    ? [Translator.idOf(entry)]
                : []));
        return input.messages.some(({ id }) => durableMessageIds.has(id));
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
