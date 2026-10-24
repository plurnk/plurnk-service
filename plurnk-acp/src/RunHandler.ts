import { Problems, isRecord, isSafeInteger } from "@plurnk/plurnk-contracts";
// The ACP Run endpoint: one client run resolved to its worker, streamed, and settled. Split out of the module, which keeps the delegating entry point.
import { type IncomingMessage, type ServerResponse } from "node:http";
import type Portal from "./Portal.ts";
import type Overview from "./Overview.ts";
import Translator from "./Translator.ts";
import MessageAddress from "./MessageAddress.ts";
import { stateSnapshot, parseAction, actionRunResult, derivationActivity, type ActionRequest, type ActionOutcome, type AcpWorkerGauge } from "./AcpPlus.ts";
import { EventType, parseRunAgentInput, type AcpEvent, type Interrupt, type RunAgentInput, type UserMessage } from "./types.ts";
import type { ClientEnvelope, LogEntryWire } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { type ResolvedModuleOptions } from "./config.ts";
import { type OperationLoopListener } from "./BuiltinActions.ts";
import { HttpProblemError, actionFailure } from "./action-results.ts";
import { httpProblem, runErrorEvents } from "./run-events.ts";

// {§acp-action-binding} What a Run binds of the worker its thread names: it may create it (and its workspace), it
// requires it, it binds none and creates nothing (`attach`), or it binds none and may bring the workspace into being.
export type WorkerBinding = "create" | "required" | "attach" | "none";

// {§module-seam-slices} — the calls a Run makes outside its Portal thread.
export type RunPort = Pick<ApplicationPort, "configurationNotices" | "listProviders" | "readLog" | "readWorker" | "listWorkerReferences" | "messageAdmission" | "readInbox" | "registerWorkerOwner" | "claimWorkerOwner" | "activateWorkspace" | "workspacePreparationStatus" | "workspaceDerivationStatus">;

// A forwardedProps.plurnk field of the wrong type: the request's own 400, coded for the field in kebab case
// ({§problems-acp}) and naming it as the client spelled it.
export const forwardedRefusal = (key: string, expected: string): HttpProblemError =>
    new HttpProblemError(httpProblem(`${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}-invalid`, 400,
        `${key} must be ${expected}.`, { stage: "request-validation", retryable: false }));

export default class RunHandler {
    readonly #seam: () => RunPort;
    readonly #opts: () => ResolvedModuleOptions;
    readonly #portal: () => Portal;
    readonly #stopping: () => boolean;
    readonly #track: <T>(work: Promise<T>) => Promise<T>;
    readonly #requiresWorkspace: (action: ActionRequest) => boolean;
    readonly #controlRun: (action: ActionRequest, input: RunAgentInput, res: ServerResponse) => Promise<void>;
    readonly #envelope: (threadId: string, forwarded?: Record<string, unknown>, options?: { readonly create?: boolean; readonly worker?: boolean }) => Promise<{ env: ClientEnvelope; reattached: boolean }>;
    readonly #conversation: (threadId: string, forwarded?: Record<string, unknown>) => Promise<{ workspaceId: number; workerId: number } | null>;
    readonly #boundWorker: (threadId: string, env: ClientEnvelope, binding: "create" | "required", forwarded?: Record<string, unknown>) => Promise<number>;
    readonly #actionBinding: (action: ActionRequest) => WorkerBinding;
    readonly #workerGauge: (workspaceId: number, workerId: number, threadId: string) => Promise<AcpWorkerGauge>;
    readonly #action: (a: ActionRequest, input: RunAgentInput, env: ClientEnvelope | null, boundWorkerId: number | undefined, onLoop: OperationLoopListener | undefined) => Promise<ActionOutcome>;
    readonly #origin: (req: IncomingMessage) => string;
    readonly #overview: () => Overview;

    constructor({ seam, opts, portal, stopping, requiresWorkspace, controlRun, envelope, conversation, boundWorker, actionBinding, workerGauge, action, origin, track, overview }: {
        seam: () => RunPort;
        opts: () => ResolvedModuleOptions;
        portal: () => Portal;
        stopping: () => boolean;
        // {§acp-shutdown} Holds the work a Run starts until it settles, so the module's closure joins it.
        track: <T>(work: Promise<T>) => Promise<T>;
        requiresWorkspace: (action: ActionRequest) => boolean;
        controlRun: (action: ActionRequest, input: RunAgentInput, res: ServerResponse) => Promise<void>;
        envelope: (threadId: string, forwarded?: Record<string, unknown>, options?: { readonly create?: boolean; readonly worker?: boolean }) => Promise<{ env: ClientEnvelope; reattached: boolean }>;
        conversation: (threadId: string, forwarded?: Record<string, unknown>) => Promise<{ workspaceId: number; workerId: number } | null>;
        boundWorker: (threadId: string, env: ClientEnvelope, binding: "create" | "required", forwarded?: Record<string, unknown>) => Promise<number>;
        actionBinding: (action: ActionRequest) => WorkerBinding;
        workerGauge: (workspaceId: number, workerId: number, threadId: string) => Promise<AcpWorkerGauge>;
        action: (a: ActionRequest, input: RunAgentInput, env: ClientEnvelope | null, boundWorkerId: number | undefined, onLoop: OperationLoopListener | undefined) => Promise<ActionOutcome>;
        // {§acp-body-reference} The origin a request reached this daemon at, where its Run's bodies are fetched.
        origin: (req: IncomingMessage) => string;
        // {§acp-overview} The observations of the worker overview.
        overview: () => Overview;
    }) {
        this.#seam = seam;
        this.#opts = opts;
        this.#portal = portal;
        this.#stopping = stopping;
        this.#track = track;
        this.#requiresWorkspace = requiresWorkspace;
        this.#controlRun = controlRun;
        this.#envelope = envelope;
        this.#conversation = conversation;
        this.#boundWorker = boundWorker;
        this.#actionBinding = actionBinding;
        this.#workerGauge = workerGauge;
        this.#action = action;
        this.#origin = origin;
        this.#overview = overview;
    }

    // {§acp-run-input} A Run does one thing.
    static #ambiguous(): HttpProblemError {
        return new HttpProblemError(httpProblem(
            "ambiguous-run-input",
            400,
            "The Run carries more than one of a new message, an action, an interrupt resume and an overview.",
            { stage: "request-validation", recovery: "Send each in its own Run.", retryable: false },
        ));
    }

    // {§acp-overview-run} The overview a Run asks for: the daemon's, or one workspace's; null when it asks for none.
    static #overviewScope(forwarded: Record<string, unknown> | undefined): { readonly workspaceId: number | null } | null {
        const value = forwarded?.overview;
        if (value === undefined) return null;
        if (!isRecord(value) || Object.keys(value).some((key) => key !== "workspaceId")
            || (value.workspaceId !== undefined && (!isSafeInteger(value.workspaceId) || value.workspaceId < 1))) {
            throw new HttpProblemError(httpProblem("overview-invalid", 400, "An overview's scope is {} or { workspaceId: <positive integer> }.",
                { overview: value, stage: "request-validation", retryable: false }));
        }
        return { workspaceId: value.workspaceId ?? null };
    }

    // {§acp-http-authorization} — the credential family the perimeter admitted this request under.
    async run(req: IncomingMessage, res: ServerResponse, connect = false, family: string | null = null): Promise<void> {
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
        return await this.runDecoded(req, res, decoded, connect, family);
    }

    async runDecoded(req: IncomingMessage, res: ServerResponse, decoded: unknown, connect = false, family: string | null = null): Promise<void> {
        const parsed = parseRunAgentInput(decoded);
        if (!parsed.success) {
            throw new HttpProblemError(httpProblem(
                "invalid-run-input",
                400,
                "The request body does not satisfy the ACP RunAgentInput contract.",
                {
                    stage: "request-validation",
                    issues: parsed.issues,
                    retryable: false,
                },
            ));
        }
        const input: RunAgentInput = parsed.data;
        const forwarded = isRecord(input.forwardedProps) && isRecord(input.forwardedProps.plurnk) ? input.forwardedProps.plurnk : undefined;
        if (forwarded?.control !== undefined && typeof forwarded.control !== "boolean") {
            throw new HttpProblemError(httpProblem("control-invalid", 400, "control must be a boolean.",
                { stage: "request-validation", retryable: false }));
        }
        if (forwarded?.interactive !== undefined && typeof forwarded.interactive !== "boolean") {
            throw new HttpProblemError(httpProblem("interactive-invalid", 400, "interactive must be a boolean.",
                { stage: "request-validation", retryable: false }));
        }
        const negotiated = RunHandler.#reasoningByLink(forwarded);
        // {§acp-run-input} A Run does one thing, chosen by its input before anything binds: a resume resolves, an
        // action acts, a new message submits, and a Run that carries none of them synchronizes ({§acp-sync}).
        const action = parseAction(input.forwardedProps);
        const fresh = await this.#newMessage(input, forwarded);
        const asks = Number(input.resume !== undefined) + Number(action !== null) + Number(fresh !== null);
        // {§acp-overview-run} An overview is a Run of its own, binding nothing: the snapshot, or on a connection what follows it.
        const overview = RunHandler.#overviewScope(forwarded);
        if (overview !== null) {
            if (asks > 0) throw RunHandler.#ambiguous();
            return await this.#overview().observe(input, res, { workspaceId: overview.workspaceId, live: connect, origin: this.#origin(req), family });
        }
        if (connect && asks > 0) {
            throw new HttpProblemError(httpProblem(
                "invalid-connect-input",
                400,
                "A connection cannot include a new message, an action, or an interrupt resume.",
                { stage: "request-validation", retryable: false },
            ));
        }
        if (asks > 1) throw RunHandler.#ambiguous();
        const synchronize = connect || asks === 0;
        // {§acp-held-interrupts} The interrupts a Run that submits nothing names as its client's, unanswered.
        const holding = synchronize && forwarded?.interrupts !== undefined ? RunHandler.#forwardedStrings(forwarded, "interrupts") : [];

        // Control plane FIRST: a management action that doesn't live in a workspace, and one the module does not
        // register or whose input it refuses, answers without binding — or forging — a workspace
        // ({§acp-action-binding}). Only admitted workspace-scoped actions, message Runs and sync Runs reach #envelope below.
        if (action !== null && !this.#requiresWorkspace(action)) {
            return await this.#controlRun(action, input, res);
        }

        let prompt: string | null = null;
        let currentUser: UserMessage | null = null;
        if (fresh !== null) {
            if (typeof fresh.content !== "string" || fresh.content.length === 0) {
                throw new HttpProblemError(httpProblem(
                    "user-message-text-required",
                    400,
                    "A new user message must be non-empty text.",
                    { stage: "request-validation", recovery: "Send the message as non-empty text.", retryable: false },
                ));
            }
            prompt = fresh.content;
            currentUser = fresh;
        }

        // {§acp-thread-binding} {§acp-action-binding} The thread resolves to its worker. A message,
        // a setting, or its owner's session attaching creates it; watching passively
        // or reading never does. A Run that requires an existing worker, or creates nothing, attaches to an
        // existing workspace: a workspace that does not exist has no worker. A resume continues the Run whose interrupt it
        // answers: it binds the worker that Run bound, if any.
        const binding: WorkerBinding = input.resume !== undefined ? "attach"
            : synchronize ? forwarded?.control === true ? "create" : "required"
            : action === null ? "create" : this.#actionBinding(action);
        const { env, reattached } = await this.#envelope(input.threadId, forwarded, {
            create: binding === "create" || binding === "none",
            worker: binding === "create",
        });
        const workspaceId = env.workspaceId;
        const workerId = binding === "create" || binding === "required"
            ? await this.#boundWorker(input.threadId, env, binding, forwarded)
            : input.resume === undefined ? undefined : this.#portal().resumedWorker(workspaceId, input.threadId, input.resume);
        // {§acp-thread-address} Routing identity and the spelling a client used are separate from reply delivery.
        const replyThreads = workerId === undefined ? [input.threadId] : await this.replyThreads(workspaceId, workerId, input.threadId);
        // {§acp-sync} A passive observation claims nothing; an owner's control connection claims as a message Run does.
        // Either presents the gates addressed to the operator ({§acp-proposal-resolve}).
        const control = forwarded?.control === true || (!synchronize && action === null);
        const owner = control ? MessageAddress.OWNER : undefined;
        if (owner !== undefined) {
            // {§acp-worker-owner} The Run declares the owner's capability set: the tools it
            // implements, and whether a person attends it. Unstated, nobody does.
            // An ACP owner answers a gate's interrupt ({§acp-proposal-resolve}), so the module declares its review for it:
            // a client declares only the tools it implements.
            await this.#seam().registerWorkerOwner(workspaceId, {
                address: owner, tools: [...new Set(["request_approval", ...input.tools.map(({ name }) => name)])], interactive: forwarded?.interactive === true,
            });
            if (workerId !== undefined) await this.#seam().claimWorkerOwner({ workspaceId, workerId, owner });
            // {§acp-owner-activation} — an owner's arrival is the workspace's demand: activation starts now,
            // so a first prompt finds it under way or done, and nothing waits for it here.
            void this.#seam().activateWorkspace({ workspaceId }).catch((cause: unknown) => {
                // {§functionality-preparation-cancellation} Shutdown owns and joins this cancellation.
                if (this.#stopping() && cause instanceof DOMException && cause.name === "AbortError") return;
                console.error(`ACP: activating workspace ${workspaceId} for its owner failed:`, cause);
            });
        }

        let finished = false;
        const finish = (): void => {
            if (finished) return;
            finished = true;
            if (heartbeat !== null) clearInterval(heartbeat);
            this.#portal().closeRun(workspaceId, boundRun);
            res.end();
        };
        // Terminate-resume, the terminate half ({§acp-proposal-resolve}): the interrupts a gate presents end this ACP Run
        // after its events, while their core owner remains paused.
        const emit = (events: AcpEvent[], interrupts: Interrupt[] = []): void => {
            if (finished) return;
            for (const e of events) {
                res.write(`data: ${JSON.stringify(e)}\n\n`);
                if (e.type === "RUN_FINISHED" || e.type === "RUN_ERROR") finish();
            }
            if (interrupts.length > 0 && !finished) {
                res.write(`data: ${JSON.stringify({
                    type: EventType.RUN_FINISHED,
                    threadId: input.threadId,
                    runId: input.runId,
                    outcome: { type: "interrupt", interrupts },
                })}\n\n`);
                finish();
            }
        };

        // {§acp-run-start} The Portal routes to this Run from the moment it is bound; what reaches it
        // before RUN_STARTED and the snapshot are written follows them, in order. A terminal ends it at once.
        // Each notification's events are held together, so a Run can tell the rows its snapshot holds.
        let presented = false;
        const held: Array<{ events: AcpEvent[]; interrupts: Interrupt[] }> = [];
        // {§acp-sync} The rows the Run's snapshot holds, by version: a later delivery of one is not built a second time.
        const replayed = new Map<unknown, string>();
        // {§acp-history-advance} What the Run's client holds of messages since its latest snapshot, and the refresh that
        // sends a fresh window once a turn ends with that past the ceiling.
        let windowChars = 0;
        let advance: (() => void) | null = null;
        let refreshing = false;
        const deliver = (events: AcpEvent[], interrupts: Interrupt[]): void => {
            const delivered = RunHandler.#unreplayed(events, replayed);
            emit(delivered, interrupts);
            windowChars += RunHandler.#messageChars(delivered);
            if (windowChars > this.#opts().historyPageChars && delivered.some(({ type }) => type === EventType.STEP_FINISHED)) advance?.();
        };
        const routed = (events: AcpEvent[], interrupts: Interrupt[] = []): void => {
            if (presented) return deliver(events, interrupts);
            const terminal = events.filter(({ type }) => type === EventType.RUN_ERROR || type === EventType.RUN_FINISHED);
            if (terminal.length === 0) return void held.push({ events, interrupts });
            // {§acp-history-advance} A Run that ends while its window is read again ends with what reached it, in order.
            if (refreshing) {
                presented = true;
                for (const batch of held.splice(0)) deliver(batch.events, batch.interrupts);
                return deliver(events, interrupts);
            }
            held.length = 0;
            emit(terminal);
        };

        const notificationScope = action === null
            ? "worker"
            : action.kind === "op.exec" || action.kind === "op.parse"
                ? "operation"
                : "result";
        // {§acp-delegation-observation} — a message Run may ask for its descendants' rows.
        const descendants = action === null && forwarded?.descendants === true;
        // {§acp-reasoning-link} — and may negotiate its reasoning by link.
        const reasoningByLink = negotiated && action === null;
        const boundRun = this.#portal().openThread({
            workspaceId,
            // {§acp-broadcast-fan} An operation Run learns its Worker and Loop from the dispatch that opens them.
            workerId: notificationScope === "operation" ? null : workerId ?? null,
            threadId: input.threadId,
            origin: this.#origin(req),
            replyThreads,
            notificationScope,
            owner: MessageAddress.OWNER,
            family,
            descendants,
            reasoningByLink,
            emit: routed,
            modelWorkerId: workerId,
            inputRunId: input.runId,
            ...(input.resume === undefined ? {} : { resume: input.resume }),
        });
        // {§acp-history-window} A window's snapshot, and the rows whose messages it holds: a later delivery of one at the
        // same version is not built a second time.
        const present = (window: { events: AcpEvent[]; rows: ReadonlySet<unknown> }, rows: readonly LogEntryWire[]): void => {
            emit(window.events);
            replayed.clear();
            for (const row of rows) if (window.rows.has(row.id)) replayed.set(row.id, RunHandler.#version(row));
            windowChars = RunHandler.#messageChars(window.events);
        };
        // {§acp-history-advance} The bound worker's window again, from its log; what reaches the Run meanwhile follows it.
        if (workerId !== undefined && notificationScope === "worker") {
            advance = () => {
                if (refreshing || finished) return;
                refreshing = true;
                presented = false;
                void this.#track((async () => {
                    const [history, inbox] = await Promise.all([this.#history(workspaceId, workerId), this.#seam().readInbox({ workspaceId, workerId })]);
                    const subagents = await this.#portal().subagentHistory(boundRun, (descendant) => this.#history(workspaceId, descendant));
                    // A terminal that arrived meanwhile abandoned the refresh.
                    if (finished || presented) return;
                    present(this.#portal().replay(boundRun, history, inbox, subagents), [...history, ...subagents.flatMap(({ entries }) => entries)]);
                    presented = true;
                    for (const batch of held.splice(0)) deliver(batch.events, batch.interrupts);
                })()).catch((cause: unknown) => {
                    const exactProblem = Problems.fromError(cause);
                    if (exactProblem === null) console.error("ACP history refresh failed:", cause);
                    this.#portal().failThread(boundRun, runErrorEvents(exactProblem ?? httpProblem("run-failed", 500, "The ACP Run failed unexpectedly.",
                        { stage: "history", retryable: false })));
                }).finally(() => { refreshing = false; });
            };
        }
        // {§acp-shutdown} Acquire the Run before committing headers or a heartbeat:
        // preparation may have crossed module closure.
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" });
        // {§acp-configuration} SSE comments keep quiet generations connected.
        const cadence = this.#opts().heartbeatMs;
        const heartbeat = cadence > 0 ? setInterval(() => { res.write(": hb\n\n"); }, cadence) : null;
        // {§acp-run-disconnect} Install once, before any asynchronous preparation: a disconnect ends this
        // delivery and nothing else.
        const disconnected = (): void => {
            if (finished) return;
            this.#portal().disconnect(boundRun);
            finish();
        };
        res.once("close", disconnected);
        if (res.destroyed) { disconnected(); return; }
        try {
        // A Run that binds no worker has no worker status to report.
        const gauge = workerId === undefined ? undefined : await this.#workerGauge(workspaceId, workerId, input.threadId);
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
            }, gauge),
            gauge?.status,
        ));
        // {§acp-message-acceptance} A message Run on a thread it reattached may present a snapshot once its message is
        // admitted; what reaches it before then is held as a sync Run's is.
        const mayReplay = fresh !== null && reattached;
        if (!synchronize && !mayReplay) {
            presented = true;
            for (const batch of held.splice(0)) emit(batch.events, batch.interrupts);
        }
        if (catalogProblem !== undefined) emit([{ type: EventType.CUSTOM, name: "plurnk.problem", value: catalogProblem }]);
        if (finished) return;

        // {§acp-sync} — the existing Run endpoint can project the
        // bound worker's durable log without admitting a prompt or starting inference.
        // A live Loop remains observed; an idle one settles after its snapshot.
        if (synchronize) {
            for (const notice of this.#seam().configurationNotices()) {
                emit([{ type: EventType.CUSTOM, name: "plurnk.notice", value: notice }]);
            }
            // A sync Run requires its worker ({§acp-action-binding}), so one is bound here.
            // {§acp-message-acceptance} The snapshot carries the accepted messages the Worker has not yet observed.
            const [history, inbox] = await Promise.all([this.#history(workspaceId, workerId!), this.#seam().readInbox({ workspaceId, workerId: workerId! })]);
            // {§acp-subagents} A Run that observes its delegation replays it too.
            const subagents = await this.#portal().subagentHistory(boundRun, (descendant) => this.#history(workspaceId, descendant));
            if (finished) return;
            // {§acp-sync} What reached the Run while its log was read follows its snapshot, and a row the snapshot
            // already holds as it arrived is not built a second time.
            present(this.#portal().replay(boundRun, history, inbox, subagents), [...history, ...subagents.flatMap(({ entries }) => entries)]);
            presented = true;
            for (const batch of held.splice(0)) emit(RunHandler.#unreplayed(batch.events, replayed), batch.interrupts);
            if (finished) return;
            await this.#portal().synchronize(workspaceId, boundRun, connect, holding);
            return;
        }

        // A management-action ACP Run (forwardedProps.plurnk.action): executed via the seam and answered on
        // this Run's own stream; concurrent actions share a workspace, and a result never rides another Run.
        // A client operation's Run observes the loop its dispatch opens ({§acp-broadcast-fan}).
        if (action !== null) {
            const finishAction = (outcome: ActionOutcome): void => {
                if (!finished) this.#portal().finishThread(boundRun, [], actionRunResult(action.kind, outcome));
            };
            const onLoop: OperationLoopListener | undefined = notificationScope === "operation"
                ? (loop) => { this.#portal().bindOperation(boundRun, loop); }
                : undefined;
            void this.#track(this.#action(action, input, env, workerId, onLoop)
                // One queue barrier: a dispatch's channel notifies are enqueued but not yet
                // delivered when its promise resolves — drain them so Portal's stream
                // bookkeeping arms BEFORE the finish decision (then stream/concluded,
                // not a timer, releases any deferral).
                .then(async (outcome) => { await new Promise((r) => setImmediate(r)); finishAction(outcome); })
                .catch((err: unknown) => {
                    console.error(`ACP action '${action.kind}' failed:`, err);
                    const problem = Problems.fromError(err);
                    finishAction(problem === null
                        ? actionFailure("action-failed", "The action failed unexpectedly.", 500)
                        : { ok: false, problem });
                }));
            return;
        }

        // ACP interrupt resume: this is a new ACP Run on the same thread. Bind it
        // to its presentation's continuation before releasing the proposal.
        if (input.resume !== undefined) {
            await this.#portal().resolve(workspaceId, boundRun, input.resume);
            return;
        }

        if (prompt === null || currentUser === null || workerId === undefined) throw new Error("message ACP Run reached dispatch without a validated prompt and its worker");

        // {§acp-message-acceptance} The message is durable before anything is presented: a snapshot built after its
        // admission holds it accepted, and no Run copies a message from its input into one.
        const submission = {
            workspaceId, workerId, prompt,
            ...MessageAddress.submission(input, currentUser),
            ...(forwarded !== undefined && Object.hasOwn(forwarded, "maxTurns")
                ? { maxTurns: RunHandler.#forwardedInteger(forwarded, "maxTurns") }
                : this.#opts().maxTurns !== undefined ? { maxTurns: this.#opts().maxTurns } : {}),
            ...(forwarded !== undefined && Object.hasOwn(forwarded, "openPaths")
                ? { openPaths: RunHandler.#forwardedStrings(forwarded, "openPaths") }
                : {}),
            // {§methods-loop-run-model} The client may still forward one explicit
            // alias-or-provider/model selector. The daemon
            // persists an explicit selection onto the worker and snapshots it on the
            // loop; an omitted selector continues the worker's durable model.
            ...(forwarded !== undefined && Object.hasOwn(forwarded, "selector")
                ? { selector: RunHandler.#forwardedString(forwarded, "selector", "a string") }
                : {}),
            ...(forwarded !== undefined && Object.hasOwn(forwarded, "childSelector")
                ? { childSelector: forwarded.childSelector === null ? null : RunHandler.#forwardedString(forwarded, "childSelector", "a string or null") }
                : {}),
        };
        let started: { loopId: number } | null;
        if (!reattached) {
            started = await this.#portal().run(boundRun, submission);
        } else {
            // {§acp-replay} The conversation decides whether this Run replays before its message is submitted: a history
            // the daemon cannot read submits nothing.
            const history = await this.#history(workspaceId, workerId);
            if (finished) return;
            const oriented = RunHandler.#isOriented(input, history, replyThreads);
            const ack = await this.#portal().submit(boundRun, submission);
            if (!oriented) {
                const inbox = await this.#seam().readInbox({ workspaceId, workerId });
                const subagents = await this.#portal().subagentHistory(boundRun, (descendant) => this.#history(workspaceId, descendant));
                if (finished) return;
                present(this.#portal().replay(boundRun, history, inbox, subagents), [...history, ...subagents.flatMap(({ entries }) => entries)]);
            }
            // {§acp-sync} What reached the Run meanwhile follows its snapshot, less the rows the snapshot already holds.
            presented = true;
            for (const batch of held.splice(0)) emit(RunHandler.#unreplayed(batch.events, replayed), batch.interrupts);
            if (finished) return;
            started = await this.#portal().attach(boundRun, workspaceId, ack);
        }
        if (started !== null && !finished) {
            const currentGauge = await this.#workerGauge(workspaceId, workerId, input.threadId);
            if (!finished) emit(this.#portal().replaceGauge(boundRun, currentGauge));
        }
        } catch (err) {
            // {§acp-http-failure} After headers, the frame alone is
            // not enough — the heartbeat interval and the Portal binding are live, and a
            // throw that escapes past finish() leaks them forever (the drill-hang). emit()
            // writes the terminal frame AND finish()es on RUN_ERROR — one door out.
            const exactProblem = Problems.fromError(err);
            if (exactProblem === null) console.error("ACP Run failed:", err);
            const problem = exactProblem ?? httpProblem(
                "run-failed",
                500,
                "The ACP Run failed unexpectedly.",
                {
                    stage: "run",
                    retryable: false,
                },
            );
            this.#portal().failThread(boundRun, runErrorEvents(problem));
        }
    }

    // {§acp-run-input} The Run's new message: its last message, when that is a user message of the thread's own
    // conversation that is neither one the daemon presented, its id a coordinate the worker's log holds, nor one a
    // client already sent, its address an idempotency key core decides ({§message-idempotency}). Both are keyed reads.
    async #newMessage(input: RunAgentInput, forwarded: Record<string, unknown> | undefined): Promise<UserMessage | null> {
        const last = input.messages.at(-1);
        if (last?.role !== "user" || last.subagentRunId !== undefined) return null;
        const conversation = await this.#conversation(input.threadId, forwarded);
        if (conversation === null) return last;
        const coordinate = /^(\d+)\/(\d+)\/(\d+)$/u.exec(last.id);
        if (coordinate !== null) {
            const [loopSeq, turnSeq, sequence] = [Number(coordinate[1]), Number(coordinate[2]), Number(coordinate[3])];
            if ((await this.#seam().readLog({ ...conversation, loopSeq, turnSeq, sequence })).length > 0) return null;
        }
        if (typeof last.content !== "string") return last;
        const admission = await this.#seam().messageAdmission({
            workspaceId: conversation.workspaceId, address: MessageAddress.render(input.threadId, last.id), body: last.content,
        });
        return admission === "new" ? last : null;
    }

    // {§acp-thread-address} The threads whose replies are speech in a worker's conversation: the thread itself, the
    // worker's name and qualified address, and every reference to it.
    async replyThreads(workspaceId: number, workerId: number, threadId: string): Promise<string[]> {
        const worker = await this.#seam().readWorker({ workspaceId, identity: { id: workerId } });
        if (worker === null) throw new Error("The bound worker is absent.");
        return [threadId, worker.name, `${workspaceId}#${worker.name}`,
            ...await this.#seam().listWorkerReferences({ workspaceId, workerId, namespace: "acp" })];
    }

    // {§acp-history-page} A worker's whole log, which every snapshot and history page is cut from.
    history(workspaceId: number, workerId: number): Promise<LogEntryWire[]> { return this.#history(workspaceId, workerId); }

    // {§acp-snapshot} A snapshot is cut from every message the live projection built, so it reads the whole log, page by page.
    async #history(workspaceId: number, workerId: number): Promise<LogEntryWire[]> {
        const rows: LogEntryWire[] = [];
        for (let beforeId: number | undefined; ;) {
            const cursor = beforeId;
            const page = await this.#seam().readLog({ workspaceId, workerId, limit: Number.MAX_SAFE_INTEGER, ...(cursor === undefined ? {} : { beforeId: cursor }) });
            const older = cursor === undefined ? page : page.filter(({ id }) => id < cursor);
            if (older.length === 0) return rows;
            rows.push(...older);
            beforeId = Math.min(...older.map(({ id }) => id));
        }
    }

    // {§acp-sync} A row's version: what a later delivery of the same row can change.
    // {§acp-run-input} A forwarded field is read by the type the loop contract names; a wrong one is the request's refusal.
    static #forwardedInteger(forwarded: Readonly<Record<string, unknown>>, key: string): number {
        const value = forwarded[key];
        if (!isSafeInteger(value)) throw forwardedRefusal(key, "an integer");
        return value;
    }

    static #forwardedString(forwarded: Readonly<Record<string, unknown>>, key: string, expected: string): string {
        const value = forwarded[key];
        if (typeof value !== "string") throw forwardedRefusal(key, expected);
        return value;
    }

    // {§acp-reasoning-link} A Run negotiates its reasoning by link with `reasoning: "link"`; it is no other value.
    static #reasoningByLink(forwarded: Readonly<Record<string, unknown>> | undefined): boolean {
        if (forwarded === undefined || !Object.hasOwn(forwarded, "reasoning")) return false;
        if (forwarded.reasoning !== "link") throw forwardedRefusal("reasoning", "\"link\"");
        return true;
    }

    static #forwardedStrings(forwarded: Readonly<Record<string, unknown>>, key: string): string[] {
        const value = forwarded[key];
        if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
            throw forwardedRefusal(key, "an array of strings");
        }
        return value;
    }

    static #version(row: { status_rx?: unknown; signal?: unknown; attrs?: unknown }): string {
        return JSON.stringify([row.status_rx ?? null, row.signal ?? null, row.attrs ?? null]);
    }

    // {§acp-history-advance} What events add to the messages a client holds: the serialized length of those that build
    // messages, a snapshot's included.
    static #messageChars(events: readonly AcpEvent[]): number {
        let chars = 0;
        for (const event of events) {
            if (event.type === EventType.MESSAGES_SNAPSHOT || event.type.startsWith("TEXT_MESSAGE_") || event.type.startsWith("TOOL_CALL_")
                || event.type.startsWith("REASONING_MESSAGE_")) chars += JSON.stringify(event).length;
        }
        return chars;
    }

    // {§acp-sync} One notification's events, without the parts of a row the snapshot already holds: none of them when it
    // holds the row as it arrived; when it holds an earlier version, whose call it holds, the later facts folded onto that
    // call, a repeated START and END without arguments ({§acp-proposal-resolve}), and the call's result.
    static #unreplayed(events: AcpEvent[], replayed: ReadonlyMap<unknown, string>): AcpEvent[] {
        const facts = events.map((event) => "metadata" in event && isRecord(event.metadata) && isRecord(event.metadata.plurnk) ? event.metadata.plurnk : undefined)
            .find((plurnk) => plurnk?.id !== undefined);
        const ambient = events.find((event) => event.type === EventType.CUSTOM && event.name === "plurnk.ambient");
        const whole = ambient?.type === EventType.CUSTOM && isRecord(ambient.value) ? ambient.value : undefined;
        const row = facts !== undefined ? { id: facts.id, version: RunHandler.#version({ status_rx: facts.status, signal: facts.signal, attrs: facts.attrs }) }
            : whole !== undefined ? { id: whole.id, version: RunHandler.#version(whole) } : null;
        if (row === null || !replayed.has(row.id)) return events;
        const held = (event: AcpEvent): boolean => (event.type.startsWith("TOOL_CALL_") && event.type !== EventType.TOOL_CALL_RESULT)
            || event.type.startsWith("TEXT_MESSAGE_") || event.type.startsWith("REASONING_");
        if (replayed.get(row.id) !== row.version) {
            return events.filter((event) => !held(event) || event.type === EventType.TOOL_CALL_START || event.type === EventType.TOOL_CALL_END);
        }
        return events.filter((event) => !(held(event) || event.type === EventType.TOOL_CALL_RESULT
            || (event.type === EventType.CUSTOM && event.name === "plurnk.ambient")));
    }

    static #isOriented(input: RunAgentInput, history: readonly LogEntryWire[], replyThreads: readonly string[]): boolean {
        const durableMessageIds = new Set(history.flatMap((entry) =>
            Translator.isResponse(entry, replyThreads)
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
