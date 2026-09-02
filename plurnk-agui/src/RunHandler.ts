// The AG-UI Run endpoint: one client run resolved to its worker, streamed, and settled. Split out of the module, which keeps the delegating entry point.
import { type IncomingMessage, type ServerResponse } from "node:http";
import Portal from "./Portal.ts";
import { stateDelta, stateSnapshot, parseAction, actionResult, type ActionRequest, type ActionOutcome, type AguiStatusState } from "./AguiPlus.ts";
import { EventType, type AguiEvent, type RunAgentInput, type UserMessage } from "./types.ts";
import { RunAgentInputSchema, type Interrupt } from "@ag-ui/core";
import { type ApplicationPort, type ClientEnvelope } from "@plurnk/plurnk-contracts";
import { type ResolvedModuleOptions } from "./config.ts";
import { HttpProblemError, actionFailure, problemFromError } from "./action-results.ts";
import { httpProblem, runErrorEvents } from "./run-events.ts";

export default class RunHandler {
    readonly #seam: () => ApplicationPort;
    readonly #opts: () => ResolvedModuleOptions;
    readonly #portal: () => Portal;
    readonly #requiresWorkspace: (kind: string) => boolean;
    readonly #controlRun: (action: ActionRequest, input: RunAgentInput, res: ServerResponse) => Promise<void>;
    readonly #envelope: (threadId: string, forwarded?: Record<string, unknown>) => Promise<{ env: ClientEnvelope; reattached: boolean }>;
    readonly #conversationWorker: (threadId: string, env: ClientEnvelope) => Promise<number>;
    readonly #workerStatus: (workspaceId: number, workerId: number) => Promise<AguiStatusState>;
    readonly #action: (a: ActionRequest, env: ClientEnvelope | null, conversationWorkerId?: number) => Promise<ActionOutcome>;

    constructor({ seam, opts, portal, requiresWorkspace, controlRun, envelope, conversationWorker, workerStatus, action }: {
        seam: () => ApplicationPort;
        opts: () => ResolvedModuleOptions;
        portal: () => Portal;
        requiresWorkspace: (kind: string) => boolean;
        controlRun: (action: ActionRequest, input: RunAgentInput, res: ServerResponse) => Promise<void>;
        envelope: (threadId: string, forwarded?: Record<string, unknown>) => Promise<{ env: ClientEnvelope; reattached: boolean }>;
        conversationWorker: (threadId: string, env: ClientEnvelope) => Promise<number>;
        workerStatus: (workspaceId: number, workerId: number) => Promise<AguiStatusState>;
        action: (a: ActionRequest, env: ClientEnvelope | null, conversationWorkerId?: number) => Promise<ActionOutcome>;
    }) {
        this.#seam = seam;
        this.#opts = opts;
        this.#portal = portal;
        this.#requiresWorkspace = requiresWorkspace;
        this.#controlRun = controlRun;
        this.#envelope = envelope;
        this.#conversationWorker = conversationWorker;
        this.#workerStatus = workerStatus;
        this.#action = action;
    }

    async run(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

        // Control plane FIRST: a management action that doesn't live in a world (and an
        // unknown kind, which is no worker at all) answers without binding — or forging — a
        // workspace. Only world-scoped actions and conversations reach #envelope below.
        const action = parseAction(input.forwardedProps);
        if (action !== null && !this.#requiresWorkspace(action.kind)) {
            return await this.#controlRun(action, input, res);
        }

        let prompt: string | null = null;
        let currentUser: UserMessage | null = null;
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
            currentUser = lastUser;
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
        const cadence = this.#opts().heartbeatMs;
        const heartbeat = cadence > 0 ? setInterval(() => { res.write(": hb\n\n"); }, cadence) : null;
        const finish = (): void => {
            if (finished) return;
            finished = true;
            if (heartbeat !== null) clearInterval(heartbeat);
            this.#portal().closeRun(workspaceId, boundRun);
            res.end();
        };
        const emit = (events: AguiEvent[]): void => {
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

        const lifecycleWorkerId = action?.kind === "op.exec" || action?.kind === "op.parse" ? env.workerId : workerId;
        const notificationScope = action === null
            ? "conversation"
            : action.kind === "op.exec" || action.kind === "op.parse"
                ? "operation"
                : "result";
        const boundRun = this.#portal().openThread({
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
        emit(this.#portal().runStarted(
            boundRun,
            stateSnapshot({ providers: this.#seam().listProviders().aliases, workspace: { id: workspaceId, name: env.workspaceName, projectRoot: env.projectRoot }, status }),
        ));
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
                    this.#portal().finishThread(boundRun, events);
                    return;
                }
                this.#portal().finishRun(workspaceId, lifecycleWorkerId, input.threadId, events);
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
                this.#seam().cancelDrain(lifecycleWorkerId, "client_disconnected");
                finish();
            });
            return;
        }

        // AG-UI interrupt resume: this is a new AG-UI Run on the same thread. Bind it
        // to the durable continuation before releasing the proposal.
        if (input.resume !== undefined) {
            await this.#portal().resolve(workspaceId, boundRun, input.resume);
            res.on("close", finish); // client hangup on a resume just detaches; the loop is already active
            return;
        }

        if (prompt === null) throw new Error("conversation AG-UI Run reached dispatch without a validated prompt");

        if (reattached) {
            const history = await this.#seam().readLog({ workspaceId, workerId, limit: 1000 }).catch(() => null);
            if (history !== null && !RunHandler.#isOriented(input, history)) {
                const replayUser = currentUser === null
                    ? undefined
                    : { ...currentUser, id: `${input.runId}/user` };
                emit(this.#portal().replay(boundRun, history, replayUser));
            }
        }
        const started = await this.#portal().run(boundRun, {
            workspaceId, workerId, prompt,
            ...(forwarded !== undefined && Object.hasOwn(forwarded, "maxTurns")
                ? { maxTurns: forwarded.maxTurns as number }
                : this.#opts().maxTurns !== undefined ? { maxTurns: this.#opts().maxTurns } : {}),
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
            this.#seam().cancelDrain(workerId, "client_disconnected");
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
            this.#portal().failThread(boundRun, runErrorEvents(problem));
        }
    }

    static #isOriented(input: RunAgentInput, history: ReadonlyArray<Record<string, unknown>>): boolean {
        const durableMessageIds = new Set(history.flatMap((entry) =>
            entry.origin === "model" && entry.op === "SEND"
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
