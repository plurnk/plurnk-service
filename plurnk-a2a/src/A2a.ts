import { readFile } from "node:fs/promises";
import {
    TaskState,
    type StreamResponse,
    type Task,
} from "@a2a-js/sdk";
import type { Client } from "@a2a-js/sdk/client";
import {
    PathSyntax,
    Results,
    type PassthroughResult,
    type RepresentationPreparationRequest,
    type RepresentationPreparationResult,
    type SchemeCtx,
    type SchemeHandler,
    type SchemeManifest,
    type SchemeResult,
    type SendStatement,
    type StreamSubscription,
} from "@plurnk/plurnk-schemes";
import A2aMessage from "./A2aMessage.ts";
import A2aProjection from "./A2aProjection.ts";

const documentation = await readFile(new URL("../docs/a2a.md", import.meta.url), "utf-8");
const OWNER = "scheme:a2a";

export type A2aClientResolver = (authority: string) => Client | null | Promise<Client | null>;

interface A2aAddress {
    readonly authority: string;
    readonly pathname: string;
}

type A2aAddressResolution =
    | { readonly address: A2aAddress }
    | { readonly problem: SchemeResult };

type A2aClientResolution =
    | { readonly client: Client }
    | { readonly problem: SchemeResult };

/** Outbound A2A v1 resources and Task obligations over the ordinary scheme API. */
export default class A2a implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "a2a",
        authority: "resource",
        channels: { body: "text/markdown", json: "application/json" },
        defaultChannel: "body",
        category: "data",
        entryOwner: "worker",
        inherit: "none",
        writableBy: ["model", "client"],
        volatile: true,
        modelVisible: true,
        folderScopes: true,
        glyph: "🤝",
        flags: { requiresWeb: true },
        example: [
            "## SEND0 [200] (a2a://researcher)",
            "Compare the two proposals and return a recommendation with evidence.",
        ].join("\n"),
        documentation,
    };

    readonly #resolveClient: A2aClientResolver;

    constructor(resolveClient: A2aClientResolver) {
        this.#resolveClient = resolveClient;
    }

    async prepareRepresentation(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult> {
        const { authority, pathname } = request;
        if (authority.length === 0) {
            return A2a.#problem("agent-required", 400, "An A2A resource requires an agent alias in its authority.", {
                stage: "target-validation",
                retryable: false,
            });
        }

        const existing = await ctx.entries.read(pathname);
        if (Results.isErrorStatus(existing.status) && existing.status !== 404) return existing;
        if (existing.entry !== null && Object.values(existing.entry.channels).some(({ state }) => state === "active")) {
            return { status: 200 };
        }
        if (pathname.startsWith("/messages/")) {
            return existing.entry === null
                ? A2a.#problem("message-not-found", 404, `No retained A2A Message exists at a2a://${authority}${pathname}.`, {
                    target: `a2a://${authority}${pathname}`,
                    retryable: false,
                })
                : { status: 200 };
        }

        const resolvedClient = await this.#client(authority);
        if ("problem" in resolvedClient) return resolvedClient.problem;
        const { client } = resolvedClient;
        try {
            if (pathname === "" || pathname === "/") {
                const card = await client.getAgentCard({ signal: ctx.signal });
                return A2a.#prepared(await ctx.entries.write(pathname, A2aProjection.agentCardEntry(card)));
            }

            const artifactIdentity = A2aProjection.artifactIdentity(pathname);
            if (artifactIdentity !== null) {
                const task = await client.getTask({ tenant: "", id: artifactIdentity.taskId }, { signal: ctx.signal });
                const artifact = task.artifacts.find(({ artifactId }) => artifactId === artifactIdentity.artifactId);
                if (artifact === undefined) {
                    return A2a.#problem("artifact-not-found", 404, `A2A Task ${task.id} has no Artifact ${artifactIdentity.artifactId}.`, {
                        taskId: task.id,
                        artifactId: artifactIdentity.artifactId,
                        retryable: false,
                    });
                }
                return A2a.#prepared(await ctx.entries.write(
                    pathname,
                    A2aProjection.artifactEntry(task, artifact),
                ));
            }

            const taskId = A2aProjection.taskIdentity(pathname);
            if (taskId !== null) {
                const task = await client.getTask({ tenant: "", id: taskId }, { signal: ctx.signal });
                return A2a.#prepared(await ctx.entries.write(
                    pathname,
                    A2aProjection.taskEntry(task, authority),
                ));
            }
            return A2a.#problem("resource-not-found", 404, `No A2A resource exists at a2a://${authority}${pathname}.`, {
                target: `a2a://${authority}${pathname}`,
                retryable: false,
            });
        } catch (cause) {
            return A2a.#remoteProblem(authority, "read", cause);
        }
    }

    async send(statement: SendStatement, ctx: SchemeCtx): Promise<PassthroughResult> {
        const resolvedAddress = A2a.#address(statement.target);
        if ("problem" in resolvedAddress) return A2a.#passthrough(resolvedAddress.problem);
        const { address } = resolvedAddress;
        if (statement.signal === 410) {
            return A2a.#passthrough(await ctx.entries.delete(address.pathname));
        }
        if (statement.signal === 499) return { shape: "passthrough", status: 200 };
        if (statement.signal !== 200) {
            return A2a.#failure("send-status-unsupported", 501, `The A2A scheme does not interpret SEND status ${statement.signal ?? "none"}.`, {
                requestedStatus: statement.signal,
                stage: "dispatch",
                retryable: false,
            });
        }
        const text = statement.body?.raw;
        if (text === undefined || text.length === 0) {
            return A2a.#failure("message-required", 400, "A2A SEND requires a non-empty Message body.", {
                stage: "request-validation",
                retryable: false,
            });
        }
        const taskId = address.pathname === "" || address.pathname === "/"
            ? undefined
            : A2aProjection.taskIdentity(address.pathname) ?? false;
        if (taskId === false) {
            return A2a.#failure("send-target-invalid", 400, "A2A SEND targets an agent root or an exact Task resource.", {
                target: `a2a://${address.authority}${address.pathname}`,
                recovery: `Use a2a://${address.authority} for new work or a2a://${address.authority}/tasks/<task-id> to continue a Task.`,
                retryable: false,
            });
        }

        const resolvedClient = await this.#client(address.authority);
        if ("problem" in resolvedClient) return A2a.#passthrough(resolvedClient.problem);
        const { client } = resolvedClient;
        const local = new AbortController();
        const abortFromParent = () => local.abort(ctx.signal?.reason);
        if (ctx.signal?.aborted) abortFromParent();
        else ctx.signal?.addEventListener("abort", abortFromParent, { once: true });
        const unlinkParent = () => ctx.signal?.removeEventListener("abort", abortFromParent);
        const stream = client.sendMessageStream(
            A2aMessage.request(text, taskId === undefined ? {} : { taskId }),
            { signal: local.signal },
        );

        let first: IteratorResult<StreamResponse, void>;
        try {
            first = await stream.next();
        } catch (cause) {
            unlinkParent();
            return A2a.#passthrough(A2a.#remoteProblem(address.authority, "send", cause));
        }
        if (first.done || first.value.payload === undefined) {
            unlinkParent();
            await stream.return(undefined).catch(() => {});
            return A2a.#failure("stream-first-result-invalid", 502, "The A2A agent returned no Task or Message as its first stream item.", {
                agent: address.authority,
                stage: "protocol",
                retryable: true,
            });
        }
        const payload = first.value.payload;
        if (payload.$case === "message") {
            let extra: IteratorResult<StreamResponse, void>;
            try {
                extra = await stream.next();
            } catch (cause) {
                unlinkParent();
                return A2a.#passthrough(A2a.#remoteProblem(address.authority, "direct-message", cause));
            }
            unlinkParent();
            await stream.return(undefined).catch(() => {});
            if (!extra.done) {
                return A2a.#failure("direct-message-stream-invalid", 502, "The A2A agent emitted additional stream items after a direct Message.", {
                    agent: address.authority,
                    stage: "protocol",
                    retryable: false,
                });
            }
            const pathname = A2aProjection.messagePath(payload.value.messageId);
            const written = await ctx.entries.write(pathname, A2aProjection.messageEntry(payload.value));
            if (Results.isErrorStatus(written.status)) return A2a.#passthrough(written);
            return {
                shape: "passthrough",
                status: 200,
                resource: `a2a://${address.authority}${pathname}`,
                messageId: payload.value.messageId,
                contextId: payload.value.contextId,
            };
        }
        if (payload.$case !== "task") {
            unlinkParent();
            await stream.return(undefined).catch(() => {});
            return A2a.#failure("stream-first-result-invalid", 502, `The A2A agent emitted ${payload.$case} before identifying its Task.`, {
                agent: address.authority,
                stage: "protocol",
                retryable: false,
            });
        }
        if (taskId !== undefined && payload.value.id !== taskId) {
            unlinkParent();
            await stream.return(undefined).catch(() => {});
            return A2a.#failure("task-identity-changed", 502, `The A2A agent answered continuation of Task ${taskId} with Task ${payload.value.id}.`, {
                requestedTaskId: taskId,
                returnedTaskId: payload.value.id,
                stage: "protocol",
                retryable: false,
            });
        }
        return this.#retainTask(address, client, stream, payload.value, local, unlinkParent, ctx);
    }

    async #retainTask(
        address: A2aAddress,
        client: Client,
        stream: AsyncGenerator<StreamResponse, void, undefined>,
        initial: Task,
        local: AbortController,
        unlinkParent: () => void,
        ctx: SchemeCtx,
    ): Promise<PassthroughResult> {
        const pathname = A2aProjection.taskPath(initial.id);
        const written = await ctx.entries.write(pathname, A2aProjection.taskSeed(initial));
        if (Results.isErrorStatus(written.status)) {
            unlinkParent();
            local.abort("task entry could not be created");
            await stream.return(undefined).catch(() => {});
            return A2a.#passthrough(written);
        }
        const subscription = await ctx.subscriptions.open(pathname, {
            cancel: async () => {
                try {
                    await client.cancelTask({ tenant: "", id: initial.id, metadata: {} });
                } finally {
                    local.abort("A2A Task cancelled by Plurnk");
                }
            },
        });
        unlinkParent();
        const abort = () => local.abort(subscription.reason);
        if (subscription.aborted) abort();
        else subscription.addEventListener("abort", abort, { once: true });
        void this.#pumpTask(address, client, stream, initial, subscription)
            .finally(() => subscription.removeEventListener("abort", abort))
            .catch((cause: unknown) => {
                console.error("A2A Task terminal cleanup failed", {
                    agent: address.authority,
                    taskId: initial.id,
                    cause,
                });
            });
        return {
            shape: "passthrough",
            status: 102,
            resource: `a2a://${address.authority}${pathname}`,
            taskId: initial.id,
            contextId: initial.contextId,
        };
    }

    async #pumpTask(
        address: A2aAddress,
        client: Client,
        stream: AsyncGenerator<StreamResponse, void, undefined>,
        initial: Task,
        subscription: StreamSubscription,
    ): Promise<void> {
        let result: SchemeResult;
        let summary: string;
        try {
            for await (const event of stream) {
                if (event.payload === undefined) {
                    throw new TypeError("A2A stream item omitted its payload");
                }
            }
            if (subscription.aborted) {
                result = A2a.#cancelled(initial.id);
                summary = `A2A Task ${initial.id} cancelled`;
            } else {
                const task = await client.getTask({ tenant: "", id: initial.id });
                const content = A2aProjection.taskContent(task, address.authority);
                await subscription.notifyChunk("body", content.body, "text/markdown");
                await subscription.notifyChunk("json", content.json, "application/json");
                result = A2a.#taskResult(task);
                summary = `A2A Task ${task.id}: ${A2a.#state(task)}`;
            }
        } catch (cause) {
            result = subscription.aborted
                ? A2a.#cancelled(initial.id)
                : A2a.#remoteProblem(address.authority, "stream", cause);
            summary = result.problem?.detail ?? `A2A Task ${initial.id} failed`;
        }
        await subscription.close(result, summary);
    }

    async #client(authority: string): Promise<A2aClientResolution> {
        try {
            const client = await this.#resolveClient(authority);
            return client === null
                ? {
                    problem: A2a.#problem("agent-not-configured", 404, `No A2A agent is configured as '${authority}'.`, {
                        agent: authority,
                        retryable: false,
                    }),
                }
                : { client };
        } catch (cause) {
            return { problem: A2a.#remoteProblem(authority, "connect", cause) };
        }
    }

    static #address(target: SendStatement["target"]): A2aAddressResolution {
        if (target === null || target.kind !== "url" || target.scheme !== "a2a" || target.hostname === null) {
            return {
                problem: A2a.#problem("bad-target", 400, "A2A SEND requires an a2a://<agent> target.", {
                    stage: "target-validation",
                    retryable: false,
                }),
            };
        }
        if (target.username !== null || target.password !== null || target.query !== null || target.headers !== undefined) {
            return {
                problem: A2a.#problem("target-metadata-unsupported", 400, "A2A targets do not accept credentials, query parameters, or request headers.", {
                    stage: "target-validation",
                    retryable: false,
                }),
            };
        }
        if (target.fragment !== null && !Object.hasOwn(A2a.manifest.channels, target.fragment)) {
            return {
                problem: A2a.#problem("channel-not-found", 400, `A2A resources have no #${target.fragment} channel.`, {
                    requestedChannel: target.fragment,
                    availableChannels: Object.keys(A2a.manifest.channels),
                    retryable: false,
                }),
            };
        }
        return {
            address: {
                authority: `${target.hostname}${target.port === null ? "" : `:${target.port}`}`,
                pathname: PathSyntax.decodeParens(target.pathname),
            },
        };
    }

    static #prepared(result: SchemeResult): RepresentationPreparationResult {
        return Results.isErrorStatus(result.status) ? result : { status: 200 };
    }

    static #taskResult(task: Task): SchemeResult {
        const state = task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
        if (
            state === TaskState.TASK_STATE_COMPLETED
            || state === TaskState.TASK_STATE_INPUT_REQUIRED
            || state === TaskState.TASK_STATE_AUTH_REQUIRED
        ) {
            return { status: 200, taskId: task.id, taskState: A2a.#state(task) };
        }
        if (state === TaskState.TASK_STATE_CANCELED) return A2a.#cancelled(task.id);
        if (state === TaskState.TASK_STATE_REJECTED) {
            return A2a.#problem("task-rejected", 403, `A2A Task ${task.id} was rejected by the remote agent.`, {
                taskId: task.id,
                taskState: A2a.#state(task),
                retryable: false,
            });
        }
        if (state === TaskState.TASK_STATE_FAILED) {
            return A2a.#problem("task-failed", 502, `A2A Task ${task.id} failed at the remote agent.`, {
                taskId: task.id,
                taskState: A2a.#state(task),
                retryable: false,
            });
        }
        return A2a.#problem("stream-ended-early", 502, `The A2A stream ended while Task ${task.id} remained ${A2a.#state(task)}.`, {
            taskId: task.id,
            taskState: A2a.#state(task),
            retryable: true,
        });
    }

    static #state(task: Task): string {
        return TaskState[task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED]
            ?.replace(/^TASK_STATE_/, "")
            .toLowerCase()
            .replaceAll("_", "-") ?? "unrecognized";
    }

    static #cancelled(taskId: string): SchemeResult {
        return A2a.#problem("task-cancelled", 499, `A2A Task ${taskId} was cancelled.`, {
            taskId,
            retryable: false,
        });
    }

    static #remoteProblem(authority: string, stage: string, cause: unknown): SchemeResult {
        console.error("A2A remote request failed", { agent: authority, stage, cause });
        return A2a.#problem("remote-request-failed", 502, `The A2A request to '${authority}' failed during ${stage}.`, {
            agent: authority,
            stage,
            retryable: true,
        });
    }

    static #failure(
        code: string,
        status: number,
        detail: string,
        extensions: Readonly<Record<string, unknown>>,
    ): PassthroughResult {
        return A2a.#passthrough(A2a.#problem(code, status, detail, extensions));
    }

    static #problem(
        code: string,
        status: number,
        detail: string,
        extensions: Readonly<Record<string, unknown>>,
    ): SchemeResult {
        return Results.failure(OWNER, code, status, detail, {}, extensions);
    }

    static #passthrough(result: SchemeResult): PassthroughResult {
        return { ...result, shape: "passthrough" };
    }
}
