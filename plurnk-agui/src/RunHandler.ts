import { Problems } from "@plurnk/plurnk-contracts";
// The AG-UI Run endpoint: one client run resolved to its worker, streamed, and settled. Split out of the module, which keeps the delegating entry point.
import { type IncomingMessage, type ServerResponse } from "node:http";
import Portal from "./Portal.ts";
import Translator from "./Translator.ts";
import MessageAddress from "./MessageAddress.ts";
import { stateSnapshot, parseAction, actionResult, type ActionRequest, type ActionOutcome, type AguiStatusState } from "./AguiPlus.ts";
import { EventType, type AguiEvent, type RunAgentInput, type UserMessage } from "./types.ts";
import { type Interrupt } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { type ApplicationPort, type ClientEnvelope } from "@plurnk/plurnk-contracts";
import { type ResolvedModuleOptions } from "./config.ts";
import { HttpProblemError, actionFailure } from "./action-results.ts";
import { httpProblem, runErrorEvents } from "./run-events.ts";

const LOOP_ADDRESSED_ACTIONS: ReadonlySet<string> = new Set(["loop.inject", "loop.cancel"]);

// {§module-seam-slices} — the calls a Run makes outside its Portal thread.
export type RunPort = Pick<ApplicationPort, "configurationNotices" | "listProviders" | "readLog" | "registerWorkerOwner" | "claimWorkerOwner" | "activateWorkspace">;

export default class RunHandler {
    readonly #seam: () => RunPort;
    readonly #opts: () => ResolvedModuleOptions;
    readonly #portal: () => Portal;
    readonly #requiresWorkspace: (kind: string) => boolean;
    readonly #controlRun: (action: ActionRequest, input: RunAgentInput, res: ServerResponse, principal: string) => Promise<void>;
    readonly #envelope: (threadId: string, forwarded?: Record<string, unknown>, options?: { readonly create?: boolean }) => Promise<{ env: ClientEnvelope; reattached: boolean }>;
    readonly #conversationWorker: (threadId: string, env: ClientEnvelope) => Promise<number>;
    readonly #observedWorker: (threadId: string, env: ClientEnvelope, forwarded?: Record<string, unknown>) => Promise<number>;
    readonly #workerStatus: (workspaceId: number, workerId: number) => Promise<AguiStatusState>;
    readonly #action: (a: ActionRequest, input: RunAgentInput, env: ClientEnvelope | null, conversationWorkerId: number | undefined, principal: string) => Promise<ActionOutcome>;

    constructor({ seam, opts, portal, requiresWorkspace, controlRun, envelope, conversationWorker, observedWorker, workerStatus, action }: {
        seam: () => RunPort;
        opts: () => ResolvedModuleOptions;
        portal: () => Portal;
        requiresWorkspace: (kind: string) => boolean;
        controlRun: (action: ActionRequest, input: RunAgentInput, res: ServerResponse, principal: string) => Promise<void>;
        envelope: (threadId: string, forwarded?: Record<string, unknown>, options?: { readonly create?: boolean }) => Promise<{ env: ClientEnvelope; reattached: boolean }>;
        conversationWorker: (threadId: string, env: ClientEnvelope) => Promise<number>;
        observedWorker: (threadId: string, env: ClientEnvelope, forwarded?: Record<string, unknown>) => Promise<number>;
        workerStatus: (workspaceId: number, workerId: number) => Promise<AguiStatusState>;
        action: (a: ActionRequest, input: RunAgentInput, env: ClientEnvelope | null, conversationWorkerId: number | undefined, principal: string) => Promise<ActionOutcome>;
    }) {
        this.#seam = seam;
        this.#opts = opts;
        this.#portal = portal;
        this.#requiresWorkspace = requiresWorkspace;
        this.#controlRun = controlRun;
        this.#envelope = envelope;
        this.#conversationWorker = conversationWorker;
        this.#observedWorker = observedWorker;
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

        // Control plane FIRST: a management action that doesn't live in a world (and an
        // unknown kind, which is no worker at all) answers without binding — or forging — a
        // workspace. Only world-scoped actions and conversations reach #envelope below.
        const action = parseAction(input.forwardedProps);
        if (synchronize && (action !== null || input.resume !== undefined || input.messages.length > 0)) {
            throw new HttpProblemError(httpProblem(
                "invalid-sync-input",
                400,
                "Conversation synchronization cannot include messages, an action, or an interrupt resume.",
                { stage: "request-validation", retryable: false },
            ));
        }
        if (action !== null && !this.#requiresWorkspace(action.kind)) {
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

        // {§agui-conversation-sync} A passive observation claims nothing and creates nothing; an owner's
        // control connection binds as a message Run does.
        const passive = synchronize && forwarded?.control !== true;
        if (!synchronize && forwarded?.worker !== undefined) {
            throw new HttpProblemError(httpProblem("worker-invalid", 400,
                "forwardedProps.plurnk.worker names the conversation an observation binds; a message or action Run addresses its thread.",
                { stage: "request-validation", retryable: false }));
        }
        // A loop-addressed action steers a loop already running in a world, and an observation watches
        // one: a world that does not exist has neither, so neither mints one. Everything else may.
        const { env, reattached } = await this.#envelope(input.threadId, forwarded, {
            create: !passive && (action === null || !LOOP_ADDRESSED_ACTIONS.has(action.kind)),
        });
        const workspaceId = env.workspaceId;
        // {§agui-thread-binding} The threadId is the conversation over the
        // world. threadId == workspace name binds the model worker (the default conversation);
        // a distinct threadId names its own worker: found by name, else minted via
        // createConversationWorker. The name is the identity at BOTH levels.
        const workerId = passive || forwarded?.worker !== undefined
            ? await this.#observedWorker(input.threadId, env, forwarded)
            : await this.#conversationWorker(input.threadId, env);
        const control = forwarded?.control === true || (!synchronize && action === null)
            || action?.kind === "op.exec" || action?.kind === "op.parse";
        const owner = control ? MessageAddress.owner(principal, input.threadId) : undefined;
        if (owner !== undefined) {
            // {§agui-worker-owner} The Run declares the owner's capability set: the tools it
            // implements, and whether a person attends it. Unstated, nobody does.
            await this.#seam().registerWorkerOwner(workspaceId, {
                address: owner, tools: [...new Set(input.tools.map(({ name }) => name))], interactive: forwarded?.interactive === true,
            });
            for (const claim of [workerId, env.workerId]) {
                await this.#seam().claimWorkerOwner({ workspaceId, workerId: claim, owner });
            }
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

        const lifecycleWorkerId = action?.kind === "op.exec" || action?.kind === "op.parse" ? env.workerId : workerId;
        const notificationScope = action === null
            ? "conversation"
            : action.kind === "op.exec" || action.kind === "op.parse"
                ? "operation"
                : "result";
        // {§agui-delegation-observation} — a conversation Run may ask for its descendants' rows.
        const descendants = action === null && forwarded?.descendants === true;
        const boundRun = this.#portal().openThread({
            workspaceId,
            workerId: lifecycleWorkerId,
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
        const status = await this.#workerStatus(workspaceId, workerId);
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
            stateSnapshot({ ...(providers === undefined ? {} : { providers }), workspace: { id: workspaceId, name: env.workspaceName, projectRoot: env.projectRoot, projectLabel: env.projectLabel }, status }),
        ));
        presented = true;
        emit(held.splice(0));
        if (catalogProblem !== undefined) emit([{ type: EventType.CUSTOM, name: "plurnk.problem", value: catalogProblem }]);
        if (finished) return;

        // {§agui-conversation-sync} — the existing Run endpoint can project the
        // daemon's durable conversation without admitting a prompt or starting inference.
        // A live Loop remains observed; an idle one settles after its snapshot.
        if (synchronize) {
            for (const notice of this.#seam().configurationNotices()) {
                emit([{ type: EventType.CUSTOM, name: "plurnk.notice", value: notice }]);
            }
            const history = await this.#seam().readLog({ workspaceId, workerId, limit: Number.MAX_SAFE_INTEGER });
            if (finished) return;
            emit(this.#portal().replay(boundRun, history));
            if (finished) return;
            await this.#portal().synchronize(workspaceId, boundRun, connect);
            return;
        }

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
                    this.#portal().finishThread(boundRun, events);
                    return;
                }
                this.#portal().finishRun(workspaceId, lifecycleWorkerId, input.threadId, events);
            };
            void this.#action(action, input, env, workerId, principal)
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

        if (prompt === null || currentUser === null) throw new Error("conversation AG-UI Run reached dispatch without a validated prompt");

        if (reattached) {
            const history = await this.#seam().readLog({ workspaceId, workerId, limit: Number.MAX_SAFE_INTEGER }).catch(() => null);
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

    static #isOriented(input: RunAgentInput, history: ReadonlyArray<Record<string, unknown>>): boolean {
        const durableMessageIds = new Set(history.flatMap((entry) =>
            Translator.isResponse(entry, input.threadId)
                    ? [String(entry.coordinate ?? entry.id)]
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
