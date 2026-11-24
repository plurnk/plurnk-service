// {§provider-sdk-boundary} Stream completion forensics, failure evidence attachment, and result projection.

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRecord } from "@plurnk/plurnk-contracts";
import { ProviderHttpError } from "../errors.ts";
import {
    abortFailure,
    attachFailureEvidence,
    collectChunkForensics,
    extractFromAssistantMessage,
    serializeError,
    toUsageFromPiMessage,
} from "../stream-forensics.ts";
import type {
    AssistantMessageReplay,
    ProviderAttemptFinishReason,
    ProviderChargeEvidence,
    ProviderModel,
    ProviderToolCall,
    ProviderUsage,
    TokenLogprob,
} from "../types.ts";

const BEDROCK_ERROR_CODE_STATUS: Readonly<Record<string, number>> = {
    ValidationException: 400,
    UnrecognizedClientException: 401,
    ExpiredTokenException: 401,
    AccessDeniedException: 403,
    ResourceNotFoundException: 404,
    ModelTimeoutException: 408,
    ModelNotReadyException: 429,
    ThrottlingException: 429,
    TooManyRequestsException: 429,
    ServiceQuotaExceededException: 429,
    InternalServerException: 500,
    ModelErrorException: 500,
    ModelStreamErrorException: 500,
    ServiceUnavailableException: 503,
};

export interface PiTransportStreamResult {
    readonly id: string | undefined;
    readonly model: string;
    content: string;
    reasoning: string;
    readonly reasoningProjected: boolean;
    readonly finishReason: ProviderAttemptFinishReason;
    readonly rawFinishReason?: string;
    readonly usage: ProviderUsage | undefined;
    readonly exceededOutputTokens?: number;
    readonly chargeEvidence: ProviderChargeEvidence;
    readonly logprobs: TokenLogprob[];
    readonly metadata: Record<string, unknown>;
    readonly wire: {
        readonly chunks: number;
        readonly emptyChunks: number;
        readonly fields: Record<string, unknown>;
        readonly channels: Record<string, string>;
        readonly toolCalls: ProviderToolCall[];
        readonly replay?: AssistantMessageReplay;
        readonly unmappedChunks: never[];
    };
    readonly rawBody?: unknown[];
}

export const finalizePiTransportOutcome = (args: {
    readonly effectiveModel: ProviderModel;
    readonly requestUrl: string;
    readonly rawChunks: unknown[];
    readonly httpResponse?: { readonly status: number; readonly headers: Record<string, string>; readonly ok: boolean };
    readonly httpErrorBody?: string;
    readonly capturedTransportError?: unknown;
    readonly operationSignal?: AbortSignal;
    readonly outputObserved: boolean;
    readonly exceededOutputTokens?: number;
    readonly finalMessage?: AssistantMessage;
    readonly lastErrorMessage?: AssistantMessage;
    readonly streamError?: string;
    readonly rawBody: boolean;
}): PiTransportStreamResult => {
    const {
        effectiveModel,
        requestUrl,
        rawChunks,
        httpResponse,
        capturedTransportError,
        operationSignal,
        outputObserved,
        exceededOutputTokens,
        finalMessage,
        lastErrorMessage,
        streamError,
        rawBody,
    } = args;
    let httpErrorBody = args.httpErrorBody;

    const forensics = collectChunkForensics(rawChunks);
    const messageInfo = extractFromAssistantMessage(finalMessage ?? lastErrorMessage);
    let diagnosticStatus: number | undefined;
    let diagnosticRequestId: string | undefined;
    for (const diag of lastErrorMessage?.diagnostics ?? []) {
        if (!isRecord(diag) || diag.type !== "bedrock_response_failure" || !isRecord(diag.details)) continue;
        if (typeof diag.details.status === "number") {
            diagnosticStatus = diag.details.status;
        } else if (typeof diag.details.errorCode === "string") {
            diagnosticStatus = BEDROCK_ERROR_CODE_STATUS[diag.details.errorCode];
        }
        if (typeof diag.details.requestId === "string" && diag.details.requestId.length > 0) {
            diagnosticRequestId = diag.details.requestId;
        }
    }
    const responseHeaders = diagnosticRequestId !== undefined && httpResponse?.headers["x-amzn-requestid"] === undefined
        ? { ...httpResponse?.headers, "x-amzn-requestid": diagnosticRequestId }
        : httpResponse?.headers;
    const responseId = finalMessage?.responseId ?? lastErrorMessage?.responseId ?? forensics.id ?? diagnosticRequestId;

    if (finalMessage === undefined) {
        let statusCode = httpResponse !== undefined && !httpResponse.ok
            ? httpResponse.status
            : diagnosticStatus;
        if (httpErrorBody === undefined && streamError !== undefined) {
            const googleStreamMatch = /^got status: [A-Z_]+\. (\{[\s\S]+\})$/u.exec(streamError);
            if (googleStreamMatch !== null) {
                httpErrorBody = googleStreamMatch[1];
                if (statusCode === undefined) {
                    try {
                        const parsed: unknown = JSON.parse(httpErrorBody);
                        const code = isRecord(parsed) && isRecord(parsed.error) ? parsed.error.code : undefined;
                        if (typeof code === "number" && code >= 400 && code < 600) statusCode = code;
                    } catch {
                        // ignore non-JSON chunk
                    }
                }
            } else {
                const statusBodyMatch = /^(?:[A-Za-z][A-Za-z0-9 _-]*: )?(\d{3}): (\{[\s\S]+\}|<[\s\S]+>|[^\n]+)$/u.exec(streamError);
                if (statusBodyMatch !== null) {
                    const parsedCode = Number(statusBodyMatch[1]);
                    if (statusCode === undefined && parsedCode >= 400 && parsedCode < 600) {
                        statusCode = parsedCode;
                    }
                    if (statusBodyMatch[2].startsWith("{") || statusBodyMatch[2].startsWith("<")) {
                        httpErrorBody = statusBodyMatch[2];
                    }
                }
            }
        }
        const failureRawBody = rawChunks.length > 0
            ? rawChunks
            : httpErrorBody !== undefined && httpErrorBody.length > 0
                ? httpErrorBody
                : undefined;
        if (operationSignal?.aborted) {
            const abortError = abortFailure(operationSignal);
            const usage = toUsageFromPiMessage(lastErrorMessage, forensics.rawUsage);
            attachFailureEvidence(abortError, {
                status: httpResponse?.status ?? diagnosticStatus,
                usage,
                chargeEvidence: {
                    ...(forensics.charge === undefined ? {} : { charge: forensics.charge }),
                    ...(forensics.rawUsage === undefined ? {} : { usage: forensics.rawUsage }),
                    response: {
                        ...(responseId === undefined ? {} : { id: responseId }),
                        ...(responseHeaders === undefined ? {} : { headers: responseHeaders }),
                    },
                },
                content: messageInfo.content,
                reasoning: messageInfo.reasoning,
                error: serializeError(abortError),
                ...(failureRawBody === undefined ? {} : { rawBody: failureRawBody }),
                outputObserved: outputObserved || messageInfo.content.length > 0 || messageInfo.reasoning.length > 0,
            });
            throw abortError;
        }
        if (capturedTransportError !== undefined && statusCode === undefined) {
            const usage = toUsageFromPiMessage(lastErrorMessage, forensics.rawUsage);
            attachFailureEvidence(capturedTransportError, {
                status: httpResponse?.status,
                usage,
                chargeEvidence: {
                    ...(forensics.charge === undefined ? {} : { charge: forensics.charge }),
                    ...(forensics.rawUsage === undefined ? {} : { usage: forensics.rawUsage }),
                    response: {
                        ...(responseId === undefined ? {} : { id: responseId }),
                        ...(responseHeaders === undefined ? {} : { headers: responseHeaders }),
                    },
                },
                content: messageInfo.content,
                reasoning: messageInfo.reasoning,
                error: serializeError(capturedTransportError),
                ...(failureRawBody === undefined ? {} : { rawBody: failureRawBody }),
                outputObserved: outputObserved || messageInfo.content.length > 0 || messageInfo.reasoning.length > 0,
            });
            throw capturedTransportError;
        }
        let parsedErrorData: unknown;
        let errorMessage = streamError ?? `HTTP ${statusCode ?? "error"}`;
        if (httpErrorBody !== undefined && httpErrorBody.length > 0) {
            try {
                parsedErrorData = JSON.parse(httpErrorBody);
                if (isRecord(parsedErrorData)) {
                    const errField = parsedErrorData.error;
                    if (isRecord(errField) && typeof errField.message === "string" && errField.message.length > 0) {
                        errorMessage = errField.message;
                    } else if (typeof errField === "string" && errField.length > 0) {
                        errorMessage = errField;
                    } else if (typeof parsedErrorData.message === "string" && parsedErrorData.message.length > 0) {
                        errorMessage = parsedErrorData.message;
                    } else {
                        errorMessage = httpErrorBody;
                    }
                }
            } catch {
                errorMessage = httpErrorBody;
            }
        }
        const apiError = new ProviderHttpError({
            message: errorMessage,
            url: requestUrl,
            statusCode,
            responseHeaders,
            responseBody: httpErrorBody,
        });
        const usage = toUsageFromPiMessage(lastErrorMessage, forensics.rawUsage);
        let charge: unknown = forensics.charge;
        if (parsedErrorData !== undefined && isRecord(parsedErrorData) && isRecord(parsedErrorData.usage)) {
            charge = parsedErrorData.usage.cost ?? charge;
        }
        attachFailureEvidence(apiError, {
            status: statusCode,
            usage,
            chargeEvidence: {
                ...(charge === undefined ? {} : { charge }),
                ...(forensics.rawUsage === undefined ? {} : { usage: forensics.rawUsage }),
                response: {
                    ...(responseId === undefined ? {} : { id: responseId }),
                    ...(responseHeaders === undefined ? {} : { headers: responseHeaders }),
                },
            },
            content: messageInfo.content,
            reasoning: messageInfo.reasoning,
            error: serializeError(apiError),
            ...(failureRawBody === undefined ? {} : { rawBody: failureRawBody }),
            outputObserved: outputObserved || messageInfo.content.length > 0 || messageInfo.reasoning.length > 0,
        });
        throw apiError;
    }

    const usage = toUsageFromPiMessage(finalMessage, forensics.rawUsage);
    const chargeEvidence: ProviderChargeEvidence = {
        ...(forensics.charge === undefined ? {} : { charge: forensics.charge }),
        ...(forensics.rawUsage === undefined ? {} : { usage: forensics.rawUsage }),
        response: {
            ...(responseId === undefined ? {} : { id: responseId }),
            ...(responseHeaders === undefined ? {} : { headers: responseHeaders }),
        },
    };
    return {
        id: responseId,
        model: forensics.model ?? finalMessage.model ?? effectiveModel.id,
        content: messageInfo.content,
        reasoning: messageInfo.reasoning,
        reasoningProjected: messageInfo.reasoningProjected,
        finishReason: exceededOutputTokens !== undefined && messageInfo.finishReason === null
            ? "length"
            : messageInfo.finishReason,
        ...(messageInfo.rawFinishReason === undefined ? {} : { rawFinishReason: messageInfo.rawFinishReason }),
        usage,
        ...(exceededOutputTokens === undefined ? {} : { exceededOutputTokens }),
        chargeEvidence,
        logprobs: forensics.logprobs,
        metadata: forensics.metadata,
        wire: {
            chunks: rawChunks.length,
            emptyChunks: 0,
            fields: {},
            channels: forensics.channels,
            toolCalls: messageInfo.toolCalls,
            replay: {
                api: effectiveModel.api,
                provider: effectiveModel.provider,
                model: effectiveModel.id,
                ...(messageInfo.thinking.length > 0 ? { thinking: messageInfo.thinking } : {}),
                ...(messageInfo.textSignature === undefined ? {} : { textSignature: messageInfo.textSignature }),
            },
            unmappedChunks: [],
        },
        ...(rawBody ? { rawBody: rawChunks } : {}),
    };
};
