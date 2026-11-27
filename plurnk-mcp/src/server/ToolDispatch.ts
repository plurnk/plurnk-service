// {§mcp-http-server} — Inbound `/mcp` tool lowering, policy & actor enforcement, dispatch, and stream settlement.

import type { AsyncLocalStorage } from "node:async_hooks";
import {
    Problems,
    actorsMatch,
    formatExteriorActorInput,
    isDefaultExteriorActor,
    isExecution,
    isRecord,
    parseExteriorActor,
    type ParsedPath,
    type PlurnkStatement,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { logCoordinateOf, type McpCallerClaims, type McpRequestContext, type McpRouteTarget } from "./EventBus.ts";

const MCP_OWNER_ACTOR = "mcp:///owner";

export interface McpToolCallOutcome {
    readonly isError?: boolean;
    readonly _meta?: Record<string, unknown>;
    readonly content: Array<{ readonly type: "text"; readonly text: string }>;
}

interface StreamConcludedWaiter {
    readonly workspaceId: number;
    readonly sessionId: number;
    readonly target: string;
    readonly resolve: (result: Readonly<Record<string, unknown>> | null) => void;
}

export class StreamCompletionTracker {
    readonly #waiters = new Set<StreamConcludedWaiter>();
    readonly #recentConcluded = new Map<string, Readonly<Record<string, unknown>> | null>();

    recordConcluded(
        workspaceId: number,
        sessionId: number,
        target: string,
        result: Readonly<Record<string, unknown>> | null,
    ): void {
        const key = `${workspaceId}:${sessionId}:${target}`;
        this.#recentConcluded.set(key, result);
        if (this.#recentConcluded.size > 256) {
            const oldest = this.#recentConcluded.keys().next().value;
            if (oldest !== undefined) this.#recentConcluded.delete(oldest);
        }
        for (const waiter of [...this.#waiters]) {
            if (waiter.workspaceId === workspaceId && waiter.sessionId === sessionId && waiter.target === target) {
                this.#waiters.delete(waiter);
                waiter.resolve(result);
            }
        }
    }

    abortAll(): void {
        for (const waiter of [...this.#waiters]) {
            this.#waiters.delete(waiter);
            waiter.resolve(null);
        }
        this.#recentConcluded.clear();
    }

    async wait(
        seam: ApplicationPort,
        workspaceId: number,
        sessionId: number,
        streamTarget: string,
        signal?: AbortSignal,
    ): Promise<Readonly<Record<string, unknown>> | null> {
        const key = `${workspaceId}:${sessionId}:${streamTarget}`;
        if (this.#recentConcluded.has(key)) {
            const cached = this.#recentConcluded.get(key) ?? null;
            this.#recentConcluded.delete(key);
            return cached;
        }

        const openStreams = await seam.readStreams({ workspaceId, sessionId });
        const stillOpen = openStreams.some(
            (s) =>
                s.target === streamTarget &&
                (s.channels.length === 0 || s.channels.some((ch) => ch.state === "active")),
        );
        if (!stillOpen) {
            const cached = this.#recentConcluded.get(key) ?? null;
            this.#recentConcluded.delete(key);
            return cached;
        }

        return new Promise<Readonly<Record<string, unknown>> | null>((resolve) => {
            const waiter: StreamConcludedWaiter = {
                workspaceId,
                sessionId,
                target: streamTarget,
                resolve: (res) => {
                    signal?.removeEventListener("abort", onAbort);
                    this.#recentConcluded.delete(key);
                    resolve(res);
                },
            };
            const onAbort = (): void => {
                this.#waiters.delete(waiter);
                resolve({ status: 499 });
            };
            this.#waiters.add(waiter);
            signal?.addEventListener("abort", onAbort, { once: true });
            if (this.#recentConcluded.has(key)) {
                this.#waiters.delete(waiter);
                signal?.removeEventListener("abort", onAbort);
                const cached = this.#recentConcluded.get(key) ?? null;
                this.#recentConcluded.delete(key);
                resolve(cached);
            }
        });
    }
}

const isHostPathTarget = (target: ParsedPath | null): boolean => {
    if (target === null) return false;
    if (target.kind !== "url") return true;
    return (
        target.scheme === null ||
        target.scheme === "file" ||
        target.scheme === "ws" ||
        target.scheme === "wss"
    );
};

const isReadOnlyFunctionalityBody = (rawBody: string | null): boolean => {
    const trimmed = (rawBody ?? "").trim();
    if (trimmed.length === 0 || trimmed === "{}") return true;
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return false;
    }
    if (!isRecord(parsed)) return false;
    if (typeof parsed.action === "string") {
        return parsed.action === "list" || parsed.action === "discover";
    }
    const keys = Object.keys(parsed);
    if (keys.length === 0) return true;
    return keys.length === 1 && keys[0] === "discover" && typeof parsed.discover === "string";
};

const isHostEffectInvocation = (statement: PlurnkStatement, readOnlyHint?: boolean): boolean => {
    if (readOnlyHint === true) return false;
    if (isExecution(statement)) {
        if (statement.runtime === "plurnk") {
            const familyTarget = statement.target?.raw ?? "";
            if (familyTarget === "question") return false;
            return !isReadOnlyFunctionalityBody(statement.body);
        }
        return true;
    }
    switch (statement.op) {
        case "edit":
            return isHostPathTarget(statement.target);
        case "copy":
            return isHostPathTarget(statement.destination.target);
        case "move":
            return isHostPathTarget(statement.source.target) || isHostPathTarget(statement.destination.target);
        case "kill":
            return isHostPathTarget(statement.target);
        case "send":
            return (
                statement.target !== null &&
                statement.target.kind === "url" &&
                (statement.target.scheme === "http" ||
                    statement.target.scheme === "https" ||
                    statement.target.scheme === "ws" ||
                    statement.target.scheme === "wss")
            );
        default:
            return false;
    }
};

const formatFailure = (result: Readonly<Record<string, unknown>>): string => {
    const problem = isRecord(result.problem) ? result.problem : null;
    const detail =
        typeof problem?.detail === "string"
            ? problem.detail
            : typeof result.detail === "string"
              ? result.detail
              : typeof result.message === "string"
                ? result.message
                : typeof result.content === "string"
                  ? result.content
                  : JSON.stringify(result);
    const recovery =
        typeof problem?.recovery === "string" && problem.recovery.length > 0
            ? `\nRecovery: ${problem.recovery}`
            : "";
    return `${detail}${recovery}`;
};

const formatSuccess = (result: Readonly<Record<string, unknown>>): string => {
    if (typeof result.content === "string") return result.content;
    if (typeof result.body === "string") return result.body;
    if (result.results !== undefined) return JSON.stringify(result.results, null, 2);
    if (typeof result.detail === "string") return result.detail;
    return JSON.stringify(result, null, 2);
};

const formatExecutionOutcome = async (args: {
    readonly seam: ApplicationPort;
    readonly streamTracker: StreamCompletionTracker;
    readonly workspaceId: number;
    readonly capturedLoop: { readonly sessionId: number; readonly loopId: number };
    readonly runtime: string;
    readonly result: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
}): Promise<McpToolCallOutcome> => {
    const { seam, streamTracker, workspaceId, capturedLoop, runtime, result, signal } = args;
    const rows = await seam.readLog({
        workspaceId,
        sessionId: capturedLoop.sessionId,
        loopId: capturedLoop.loopId,
        limit: 1,
    });
    const row = rows[0];
    const logCoordinate = logCoordinateOf(row);
    const meta = logCoordinate !== null ? { _meta: { logCoordinate } } : {};
    const attrs: Record<string, unknown> = {
        ...(isRecord(result.attrs) ? result.attrs : {}),
        ...(row !== undefined && isRecord(row.attrs) ? row.attrs : {}),
    };
    const pathname = typeof attrs.pathname === "string" ? attrs.pathname : null;
    const streamTarget =
        typeof attrs.stream === "string"
            ? attrs.stream
            : pathname !== null
              ? `${runtime}://${pathname}`
              : null;
    if (streamTarget === null) {
        return {
            ...meta,
            content: [{ type: "text", text: formatSuccess(result) }],
        };
    }

    const concludedResult = await streamTracker.wait(
        seam,
        workspaceId,
        capturedLoop.sessionId,
        streamTarget,
        signal,
    );
    const entryRead = await seam.readEntry({
        workspaceId,
        sessionId: capturedLoop.sessionId,
        target: streamTarget,
    });
    const channels = entryRead.entry?.channels ?? {};
    const resultChannel = channels.results ?? channels.result;
    if (resultChannel !== undefined) {
        const isError =
            (concludedResult !== null &&
                typeof concludedResult.status === "number" &&
                concludedResult.status >= 400) ||
            resultChannel.state === "errored";
        return {
            ...(isError ? { isError: true } : {}),
            ...meta,
            content: [
                {
                    type: "text",
                    text:
                        resultChannel.content.length > 0
                            ? resultChannel.content
                            : JSON.stringify(concludedResult ?? result),
                },
            ],
        };
    }

    const parts: string[] = [];
    for (const [, ch] of Object.entries(channels)) {
        if (ch.content.length > 0) {
            parts.push(ch.content);
        }
    }
    const concludedStatus =
        concludedResult !== null && typeof concludedResult.status === "number"
            ? concludedResult.status
            : typeof result.status === "number"
              ? result.status
              : 200;
    const hasChannelError = Object.values(channels).some((ch) => ch.state === "errored");
    const isError = concludedStatus >= 400 || hasChannelError;
    if (isError && concludedResult !== null && isRecord(concludedResult.problem)) {
        const detail = typeof concludedResult.problem.detail === "string" ? concludedResult.problem.detail : "";
        if (detail.length > 0 && !parts.some((p) => p.includes(detail))) {
            parts.push(detail);
        }
    }
    const text =
        parts.length > 0
            ? parts.join(parts.every((p) => p.endsWith("\n")) ? "" : "\n")
            : JSON.stringify(concludedResult ?? { status: concludedStatus });
    return {
        ...(isError ? { isError: true } : {}),
        ...meta,
        content: [{ type: "text", text }],
    };
};

export const executeMcpToolCall = async (args: {
    readonly seam: ApplicationPort;
    readonly streamTracker: StreamCompletionTracker;
    readonly requestContext: AsyncLocalStorage<McpRequestContext>;
    readonly target: McpRouteTarget;
    readonly fallbackClaims: McpCallerClaims;
    readonly toolName: string;
    readonly rawArgs: unknown;
    readonly readOnlyHint?: boolean;
    readonly signal?: AbortSignal;
}): Promise<McpToolCallOutcome> => {
    const { seam, streamTracker, requestContext, target, fallbackClaims, toolName, rawArgs, readOnlyHint, signal } = args;
    const { workspaceId, sessionId, isModelSession } = target;
    const reqStore = requestContext.getStore();
    const verifiedSubject = reqStore?.subject ?? fallbackClaims.subject;
    const verifiedHandle = reqStore?.handle ?? fallbackClaims.handle;
    const verifiedName = reqStore?.name ?? fallbackClaims.name;
    const canDelegateActor = (reqStore?.canDelegateActor ?? fallbackClaims.canDelegateActor) === true;
    const normalizedArgs = isRecord(rawArgs) ? rawArgs : {};
    const executors = seam.executorTags(workspaceId);
    const parsed = PlurnkParser.lowerToolCall("plurnk", toolName, normalizedArgs, { executors });
    const parseErrors = parsed.items.filter(
        (item): item is Extract<typeof item, { kind: "error" }> =>
            item.kind === "error" && item.error.severity === "error",
    );
    const statements = parsed.items
        .filter((item): item is Extract<typeof item, { kind: "statement" }> => item.kind === "statement")
        .map((item) => item.statement);
    if (parseErrors.length > 0 || statements.length === 0) {
        const message = parseErrors[0]?.error.message ?? PlurnkParser.NO_VALID_EXPRESSION;
        return {
            isError: true,
            content: [{ type: "text", text: message }],
        };
    }

    let statement: PlurnkStatement = statements[0];
    if (statement.op === "send" && statement.actor !== undefined && statement.actor !== null) {
        const parsedActor = parseExteriorActor(statement.actor, "mcp");
        if (parsedActor === null) {
            const formatted = formatExteriorActorInput(statement.actor);
            return {
                isError: true,
                content: [{ type: "text", text: `Invalid exterior actor '${formatted}'. (actor-invalid)` }],
            };
        }
        const subjectMatches = verifiedSubject !== null && actorsMatch(statement.actor, verifiedSubject);
        const delegatedAllowed = canDelegateActor && !isDefaultExteriorActor(parsedActor.id);
        if (seam.credentials.face() !== null && !subjectMatches && !delegatedAllowed) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Actor '${parsedActor.id}' does not match authenticated subject '${verifiedSubject ?? ""}'. (actor-not-authorized)`,
                    },
                ],
            };
        }
        if (
            typeof statement.actor === "string" &&
            subjectMatches &&
            !isDefaultExteriorActor(parsedActor.id) &&
            (verifiedHandle !== undefined || verifiedName !== undefined)
        ) {
            statement = {
                ...statement,
                actor: {
                    id: parsedActor.id,
                    handle: verifiedHandle ?? parsedActor.handle,
                    ...(verifiedName !== undefined ? { name: verifiedName } : {}),
                },
            };
        }
    } else if (
        statement.op === "send" &&
        (statement.actor === undefined || statement.actor === null) &&
        statement.target?.kind === "url" &&
        statement.target.scheme === "session" &&
        (statement.target.pathname === null || statement.target.pathname === "" || statement.target.pathname === "/") &&
        verifiedSubject !== null &&
        (verifiedHandle !== undefined || verifiedName !== undefined)
    ) {
        const parsedSub = parseExteriorActor(verifiedSubject, "mcp");
        if (parsedSub !== null && !isDefaultExteriorActor(parsedSub.id)) {
            statement = {
                ...statement,
                actor: {
                    id: parsedSub.id,
                    handle: verifiedHandle ?? parsedSub.handle,
                    ...(verifiedName !== undefined ? { name: verifiedName } : {}),
                },
            };
        }
    }

    const callerActor =
        typeof verifiedSubject === "string" && verifiedSubject.trim().length > 0
            ? (parseExteriorActor(verifiedSubject, "mcp")?.uri ?? `mcp://${encodeURIComponent(verifiedSubject.trim())}`)
            : MCP_OWNER_ACTOR;
    if (
        isHostEffectInvocation(statement, readOnlyHint) &&
        typeof seam.readWorkspaceProposalPolicy === "function"
    ) {
        const { effective } = await seam.readWorkspaceProposalPolicy({ workspaceId });
        if (effective === "reject") {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text:
                            `Workspace proposal policy 'reject' forbids host-effecting tool '${toolName}' over /mcp.\n` +
                            "Recovery: Set the workspace proposal policy to 'accept' before invoking host-effecting tools over /mcp.",
                    },
                ],
            };
        }
        if (effective === "review") {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text:
                            `Workspace proposal policy 'review' requires interactive approval, and /mcp has no approval channel for host-effecting tool '${toolName}'.\n` +
                            "Recovery: Approve host-effecting work interactively over /acp or set the workspace proposal policy to 'accept'.",
                    },
                ],
            };
        }
    }

    let capturedLoop: { readonly sessionId: number; readonly loopId: number } | null = null;
    const readCapturedLoop = (): { readonly sessionId: number; readonly loopId: number } | null => capturedLoop;
    const onAbort = (): void => {
        if (capturedLoop !== null) {
            void seam
                .cancelLoop({
                    workspaceId,
                    loopId: capturedLoop.loopId,
                    reason: "mcp_client_cancelled",
                })
                .catch(() => undefined);
        }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
        const results = await seam.dispatchClientAction({
            workspaceId,
            actor: callerActor,
            ...(isModelSession ? { contextSessionId: sessionId } : {}),
            statements: [statement],
            onLoop: (loop) => {
                capturedLoop = loop;
                if (signal?.aborted === true) {
                    onAbort();
                }
            },
        });
        const result = results[0] ?? { status: 500, detail: "No operation result returned." };
        if (result.status >= 400) {
            return {
                isError: true,
                content: [{ type: "text", text: formatFailure(result) }],
            };
        }

        const activeLoop = readCapturedLoop();
        if (isExecution(statement) && activeLoop !== null) {
            return await formatExecutionOutcome({
                seam,
                streamTracker,
                workspaceId,
                capturedLoop: activeLoop,
                runtime: statement.runtime,
                result,
                signal,
            });
        }

        const logCoordinate =
            activeLoop !== null
                ? logCoordinateOf(
                      (
                          await seam.readLog({
                              workspaceId,
                              sessionId: activeLoop.sessionId,
                              loopId: activeLoop.loopId,
                              limit: 1,
                          })
                      )[0],
                  )
                : null;
        return {
            ...(logCoordinate !== null ? { _meta: { logCoordinate } } : {}),
            content: [{ type: "text", text: formatSuccess(result) }],
        };
    } catch (cause) {
        const problem = Problems.fromError(cause);
        if (problem !== null) {
            const recovery =
                typeof problem.recovery === "string" && problem.recovery.length > 0
                    ? `\nRecovery: ${problem.recovery}`
                    : "";
            return {
                isError: true,
                content: [{ type: "text", text: `${problem.detail}${recovery}` }],
            };
        }
        return {
            isError: true,
            content: [{ type: "text", text: cause instanceof Error ? cause.message : String(cause) }],
        };
    } finally {
        signal?.removeEventListener("abort", onAbort);
    }
};
