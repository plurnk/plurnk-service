import { isRecord } from "@plurnk/plurnk-contracts";
import {
    fromJsonSchema,
    isInputRequiredResult,
    SdkError,
    SdkErrorCode,
    specTypeSchemas,
    type CallToolRequest,
    type CallToolResult,
    type ElicitRequest,
    type ElicitResult,
    type GetPromptRequest,
    type GetPromptResult,
    type InputRequiredResult,
    type InputResponse,
    type Progress,
    type ReadResourceRequest,
    type ReadResourceResult,
} from "@modelcontextprotocol/client";
import type {
    ClientInteractionRequest,
    ClientInteractionResolution,
} from "@plurnk/plurnk-contracts";
import { setTimeout as delay } from "node:timers/promises";
import { addAbortListener } from "node:events";

type ValidatedValue<S> = S extends { readonly "~standard": { validate(input: unknown): infer R } }
    ? R extends { readonly issues?: undefined; readonly value: infer V } ? V : never
    : never;

type SamplingMessageRequest = ValidatedValue<typeof specTypeSchemas.CreateMessageRequest>;
export type SamplingMessageParams = SamplingMessageRequest["params"];
export type SamplingMessageResult = ValidatedValue<typeof specTypeSchemas.CreateMessageResult>;

export type ClientInteractionHandler = (
    request: ClientInteractionRequest,
    signal?: AbortSignal,
) => Promise<ClientInteractionResolution>;

export type SamplingHandler = (
    request: SamplingMessageParams,
    signal?: AbortSignal,
) => Promise<SamplingMessageResult>;

type InputRequiredMethod = "tools/call" | "resources/read" | "prompts/get" | "tasks/update";
type CoreInputRequiredParams = CallToolRequest["params"]
    | ReadResourceRequest["params"]
    | GetPromptRequest["params"];
type InputRequiredCompleteResult = CallToolResult | ReadResourceResult | GetPromptResult;

interface InputRequiredLegOptions {
    readonly signal?: AbortSignal;
    readonly timeout: number;
    readonly maxTotalTimeout: number;
    readonly allowInputRequired: true;
    readonly onprogress?: (progress: Progress) => void;
}

type InputRequiredLeg<T, P extends object> = (
    params: P,
    options: InputRequiredLegOptions,
    retry: boolean,
) => Promise<T | InputRequiredResult>;

interface InputRequiredRequestOptions<T, P extends object> {
    readonly server: string;
    readonly operation: InputRequiredMethod;
    readonly originalParams: P;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: Progress) => void;
    readonly interact?: ClientInteractionHandler;
    readonly sample?: SamplingHandler;
    readonly meta?: Readonly<Record<string, unknown>>;
    readonly timeout: number;
    readonly requestLeg: InputRequiredLeg<T, P>;
}

interface ResolveInputRequestsOptions {
    readonly server: string;
    readonly operation: InputRequiredMethod;
    readonly inputRequests: Readonly<Record<string, unknown>>;
    readonly interact?: ClientInteractionHandler;
    readonly sample?: SamplingHandler;
    readonly meta?: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
    readonly deadline: number;
}

export const INPUT_REQUIRED_MAX_ROUNDS = 10;
const REQUEST_STATE_ONLY_PACING_MS = 250;
const INPUT_REQUIRED_TOOL = "mcp_input_required";

const timeoutError = (operation: string): SdkError => new SdkError(
    SdkErrorCode.RequestTimeout,
    `MCP '${operation}' exceeded its operation timeout.`,
);

export const remainingTimeout = (deadline: number, operation: string): number => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timeoutError(operation);
    return remaining;
};

const formatValidationIssues = (issues: readonly { message: string; path?: readonly unknown[] }[]): string =>
    issues.map((issue) => issue.path?.length
        ? `${issue.path.map(String).join(".")}: ${issue.message}`
        : issue.message).join(", ");

type EmbeddedInputRequest =
    | { readonly kind: "elicitation"; readonly key: string; readonly request: ElicitRequest }
    | { readonly kind: "sampling"; readonly key: string; readonly request: SamplingMessageRequest };

const supportedInputRequests = (
    server: string,
    operation: InputRequiredMethod,
    inputRequests: Readonly<Record<string, unknown>>,
): EmbeddedInputRequest[] => Object.entries(inputRequests).map(([key, candidate]) => {
    const method = isRecord(candidate) ? candidate.method : undefined;
    if (method === "elicitation/create") {
        const parsed = specTypeSchemas.ElicitRequest["~standard"].validate(candidate);
        if (parsed.issues !== undefined) {
            throw new Error(
                `MCP server '${server}' supplied invalid elicitation '${key}' during '${operation}': ${formatValidationIssues(parsed.issues)}.`,
            );
        }
        return { kind: "elicitation", key, request: parsed.value };
    }
    if (method === "sampling/createMessage") {
        const parsed = specTypeSchemas.CreateMessageRequest["~standard"].validate(candidate);
        if (parsed.issues !== undefined) {
            throw new Error(
                `MCP server '${server}' supplied invalid sampling request '${key}' during '${operation}': ${formatValidationIssues(parsed.issues)}.`,
            );
        }
        return { kind: "sampling", key, request: parsed.value };
    }
    throw new Error(
        `MCP server '${server}' requested unsupported embedded input method '${String(method)}' during '${operation}'; Plurnk advertises only elicitation (form and URL) and sampling.`,
    );
});

const interactionRequest = (
    request: ElicitRequest,
): ClientInteractionRequest => {
    const params = request.params;
    if (params.mode === "url") {
        return {
            toolName: INPUT_REQUIRED_TOOL,
            mode: "url",
            message: params.message,
            elicitationId: params.elicitationId,
            url: params.url,
        };
    }
    return {
        toolName: INPUT_REQUIRED_TOOL,
        mode: "form",
        message: params.message,
        requestedSchema: params.requestedSchema,
    };
};

export const resolveInputRequests = async ({
    server,
    operation,
    inputRequests,
    interact,
    sample,
    meta,
    signal,
    deadline,
}: ResolveInputRequestsOptions): Promise<Record<string, InputResponse>> => {
    signal?.throwIfAborted();
    const entries = supportedInputRequests(server, operation, inputRequests);
    if (entries.length === 0) return {};
    if (entries.some((entry) => entry.kind === "elicitation") && interact === undefined) {
        throw new Error(
            `MCP server '${server}' requires client input during '${operation}', but this operation has no client interaction owner.`,
        );
    }
    if (entries.some((entry) => entry.kind === "sampling") && sample === undefined) {
        throw new Error(
            `MCP server '${server}' requires sampling during '${operation}', but this operation has no sampling owner.`,
        );
    }
    const controller = new AbortController();
    const inputSignal = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(timeoutError(operation)), remainingTimeout(deadline, operation));
    timer.unref();
    const cancelled = Promise.withResolvers<never>();
    const listener = addAbortListener(inputSignal, () => cancelled.reject(inputSignal.reason));
    try {
        const pairs = await Promise.all(entries.map(async (entry): Promise<[string, InputResponse]> => {
            if (entry.kind === "sampling") {
                const mergedMeta = meta !== undefined || isRecord(entry.request.params._meta)
                    ? { ...meta, ...(isRecord(entry.request.params._meta) ? entry.request.params._meta : {}) }
                    : undefined;
                const params: SamplingMessageParams = mergedMeta === undefined
                    ? entry.request.params
                    : { ...entry.request.params, _meta: mergedMeta };
                const result = await Promise.race([sample!(params, inputSignal), cancelled.promise]);
                inputSignal.throwIfAborted();
                const parsed = specTypeSchemas.CreateMessageResult["~standard"].validate(result);
                if (parsed.issues !== undefined) {
                    throw new Error(
                        `MCP sampling response '${entry.key}' is invalid: ${formatValidationIssues(parsed.issues)}.`,
                    );
                }
                return [entry.key, parsed.value];
            }
            const request = interactionRequest(entry.request);
            const resolution = await Promise.race([interact!(request, inputSignal), cancelled.promise]);
            inputSignal.throwIfAborted();
            return [entry.key, await resolvedInputResponse(entry.key, request, resolution)];
        }));
        return Object.fromEntries(pairs);
    } catch (error) {
        controller.abort(error);
        throw error;
    } finally {
        clearTimeout(timer);
        listener[Symbol.dispose]();
    }
};

const resolvedInputResponse = async (
    key: string,
    request: ClientInteractionRequest,
    resolution: ClientInteractionResolution,
): Promise<ElicitResult> => {
    if (resolution.action === "cancel" || resolution.action === "decline") {
        return { action: resolution.action };
    }
    if (request.mode === "url") {
        if (resolution.content !== undefined) {
            throw new Error(
                `MCP client interaction response '${key}' is invalid: URL elicitation accepts no content.`,
            );
        }
        return { action: "accept" };
    }
    const validator = fromJsonSchema<Record<string, unknown>>(
        request.requestedSchema,
    );
    const validation = await validator["~standard"].validate(resolution.content);
    if (validation.issues !== undefined) {
        throw new Error(
            `MCP client interaction response '${key}' is invalid: ${formatValidationIssues(validation.issues)}.`,
        );
    }
    const parsed = specTypeSchemas.ElicitResult["~standard"].validate({
        action: "accept",
        content: validation.value,
    });
    if (parsed.issues !== undefined) {
        throw new Error(
            `MCP client interaction response '${key}' is invalid: ${formatValidationIssues(parsed.issues)}.`,
        );
    }
    return parsed.value;
};

export const runInputRequiredRequest = async <
    T = InputRequiredCompleteResult,
    P extends object = CoreInputRequiredParams,
>({
    server,
    operation,
    originalParams,
    signal,
    onProgress,
    interact,
    sample,
    meta,
    timeout,
    requestLeg,
}: InputRequiredRequestOptions<T, P>): Promise<T> => {
    const deadline = Date.now() + timeout;
    const options = {
        signal,
        timeout,
        maxTotalTimeout: timeout,
        allowInputRequired: true as const,
        ...(onProgress === undefined ? {} : { onprogress: onProgress }),
    };
    let result = await requestLeg(originalParams, options, false);
    let round = 0;
    while (isInputRequiredResult(result)) {
        round += 1;
        if (round > INPUT_REQUIRED_MAX_ROUNDS) {
            throw new SdkError(
                SdkErrorCode.InputRequiredRoundsExceeded,
                `Multi-round-trip request '${operation}' still required input after ${INPUT_REQUIRED_MAX_ROUNDS} rounds.`,
                {
                    rounds: INPUT_REQUIRED_MAX_ROUNDS,
                    lastResult: result,
                },
            );
        }
        onProgress?.({
            progress: round,
            message: `Fulfilling input required by '${operation}' (round ${round})`,
        });
        let inputResponses: Record<string, InputResponse> | undefined;
        const inputRequests = result.inputRequests ?? {};
        if (Object.keys(inputRequests).length === 0) {
            await delay(
                REQUEST_STATE_ONLY_PACING_MS,
                undefined,
                signal === undefined ? {} : { signal },
            );
        } else {
            inputResponses = await resolveInputRequests({
                server,
                operation,
                inputRequests,
                interact,
                sample,
                meta,
                signal,
                deadline,
            });
            signal?.throwIfAborted();
        }
        const remaining = remainingTimeout(deadline, operation);
        const retryParams = {
            ...originalParams,
            ...(inputResponses === undefined || Object.keys(inputResponses).length === 0
                ? {}
                : { inputResponses }),
            ...(result.requestState === undefined
                ? {}
                : { requestState: result.requestState }),
        } as P;
        result = await requestLeg(
            retryParams,
            {
                ...options,
                timeout: Math.min(timeout, remaining),
                maxTotalTimeout: remaining,
            },
            true,
        );
    }
    return result;
};
