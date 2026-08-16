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
    type JsonSchemaType,
    type Progress,
    type ReadResourceRequest,
    type ReadResourceResult,
} from "@modelcontextprotocol/client";
import type {
    ClientInteractionRequest,
    ClientInteractionResolution,
} from "@plurnk/plurnk-contracts";
import { setTimeout as delay } from "node:timers/promises";

export type ClientInteractionHandler = (
    request: ClientInteractionRequest,
) => Promise<ClientInteractionResolution>;

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
    readonly timeout: number;
    readonly requestLeg: InputRequiredLeg<T, P>;
}

interface ResolveInputRequestsOptions {
    readonly server: string;
    readonly operation: InputRequiredMethod;
    readonly inputRequests: Readonly<Record<string, unknown>>;
    readonly interact?: ClientInteractionHandler;
    readonly arguments?: Readonly<Record<string, unknown>>;
}

export const INPUT_REQUIRED_MAX_ROUNDS = 10;
const REQUEST_STATE_ONLY_PACING_MS = 250;
const INPUT_REQUIRED_TOOL = "mcp_input_required";

const formatValidationIssues = (issues: readonly { message: string; path?: readonly unknown[] }[]): string =>
    issues.map((issue) => issue.path?.length
        ? `${issue.path.map(String).join(".")}: ${issue.message}`
        : issue.message).join(", ");

const elicitationResponseSchema = (request: ElicitRequest): Record<string, unknown> => {
    const params = request.params;
    if (params.mode === "url") {
        return {
            type: "object",
            required: ["action"],
            additionalProperties: false,
            properties: {
                action: { enum: ["accept", "decline", "cancel"] },
            },
        };
    }
    return {
        oneOf: [
            {
                type: "object",
                required: ["action", "content"],
                additionalProperties: false,
                properties: {
                    action: { const: "accept" },
                    content: params.requestedSchema,
                },
            },
            {
                type: "object",
                required: ["action"],
                additionalProperties: false,
                properties: {
                    action: { enum: ["decline", "cancel"] },
                },
            },
        ],
    };
};

const supportedElicitations = (
    server: string,
    operation: InputRequiredMethod,
    inputRequests: Readonly<Record<string, unknown>>,
): [string, ElicitRequest][] => Object.entries(inputRequests).map(([key, candidate]) => {
    const request = candidate as { method?: unknown };
    if (request.method !== "elicitation/create") {
        throw new Error(
            `MCP server '${server}' requested unsupported embedded input method '${String(request.method)}' during '${operation}'; Plurnk advertises only elicitation form and URL modes.`,
        );
    }
    const parsed = specTypeSchemas.ElicitRequest["~standard"].validate(candidate);
    if (parsed.issues !== undefined) {
        throw new Error(
            `MCP server '${server}' supplied invalid elicitation '${key}' during '${operation}': ${formatValidationIssues(parsed.issues)}.`,
        );
    }
    return [key, parsed.value];
});

const interactionRequest = (
    server: string,
    operation: InputRequiredMethod,
    entries: readonly [string, ElicitRequest][],
    args: Readonly<Record<string, unknown>> = {},
): ClientInteractionRequest => {
    const properties = Object.fromEntries(entries.map(([key, request]) => [
        key,
        elicitationResponseSchema(request),
    ]));
    return {
        toolName: INPUT_REQUIRED_TOOL,
        arguments: {
            server,
            operation,
            ...args,
            requests: Object.fromEntries(entries),
        },
        message: entries.length === 1
            ? entries[0]![1].params.message
            : `MCP server '${server}' requires ${entries.length} responses to continue '${operation}'.`,
        responseSchema: {
            type: "object",
            required: entries.map(([key]) => key),
            additionalProperties: false,
            properties,
        },
    };
};

export const resolveInputRequests = async ({
    server,
    operation,
    inputRequests,
    interact,
    arguments: args,
}: ResolveInputRequestsOptions): Promise<Record<string, InputResponse>> => {
    const entries = supportedElicitations(server, operation, inputRequests);
    if (entries.length === 0) return {};
    if (interact === undefined) {
        throw new Error(
            `MCP server '${server}' requires client input during '${operation}', but this operation has no client interaction owner.`,
        );
    }
    const request = interactionRequest(server, operation, entries, args);
    return resolvedInputResponses(request, await interact(request));
};

const cancelledInputResponses = (
    entries: readonly [string, ElicitRequest][],
): Record<string, ElicitResult> => Object.fromEntries(entries.map(([key]) => [
    key,
    { action: "cancel" },
]));

const resolvedInputResponses = async (
    request: ClientInteractionRequest,
    resolution: ClientInteractionResolution,
): Promise<Record<string, InputResponse>> => {
    if (resolution.status === "cancelled") {
        const entries = Object.entries(
            request.arguments.requests as Record<string, ElicitRequest>,
        );
        return cancelledInputResponses(entries);
    }
    const validator = fromJsonSchema<Record<string, unknown>>(
        request.responseSchema as JsonSchemaType,
    );
    const validation = await validator["~standard"].validate(resolution.payload);
    if (validation.issues !== undefined) {
        throw new Error(
            `MCP client interaction response is invalid: ${formatValidationIssues(validation.issues)}.`,
        );
    }
    const responses: Record<string, InputResponse> = {};
    for (const [key, value] of Object.entries(validation.value)) {
        const parsed = specTypeSchemas.ElicitResult["~standard"].validate(value);
        if (parsed.issues !== undefined) {
            throw new Error(
                `MCP client interaction response '${key}' is invalid: ${formatValidationIssues(parsed.issues)}.`,
            );
        }
        responses[key] = parsed.value;
    }
    return responses;
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
    timeout,
    requestLeg,
}: InputRequiredRequestOptions<T, P>): Promise<T> => {
    const startedAt = Date.now();
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
            });
            signal?.throwIfAborted();
        }
        const elapsed = Date.now() - startedAt;
        const remaining = timeout - elapsed;
        if (remaining <= 0) {
            throw new SdkError(
                SdkErrorCode.RequestTimeout,
                `MCP '${operation}' exceeded its ${timeout}ms operation timeout.`,
                { maxTotalTimeout: timeout, totalElapsed: elapsed },
            );
        }
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
