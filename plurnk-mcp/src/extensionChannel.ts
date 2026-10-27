import { isRecord } from "@plurnk/plurnk-contracts";
import {
    Client,
    ProtocolError,
    SdkError,
    SdkErrorCode,
    type JSONRPCMessage,
    type JSONRPCNotification,
    type JSONRPCResponse,
    type MessageExtraInfo,
    type Progress,
} from "@modelcontextprotocol/client";

const REQUEST_ID_PREFIX = "plurnk-extension:";

interface ExtensionRequestOptions {
    readonly signal?: AbortSignal;
    readonly timeout: number;
    readonly headers?: Readonly<Record<string, string>>;
    readonly cancelRequestOnSharedTransport?: boolean;
    readonly onProgress?: (progress: Progress) => void;
}

interface PendingRequest {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: unknown) => void;
    readonly requestAbort: AbortController;
    readonly timer: NodeJS.Timeout;
    readonly signal?: AbortSignal;
    readonly onAbort?: () => void;
    readonly onProgress?: (progress: Progress) => void;
}

type TaskNotificationHandler = (params: unknown) => void;

const asRecord = (value: unknown): Record<string, unknown> | undefined => isRecord(value) ? value : undefined;

const asError = (cause: unknown): Error => cause instanceof Error
    ? cause
    : new Error(String(cause));

export default class ExtensionChannel extends Client {
    readonly #pending = new Map<string, PendingRequest>();
    readonly #taskHandlers = new Set<TaskNotificationHandler>();
    #nextId = 0;
    #closed = false;

    onTaskNotification(handler: TaskNotificationHandler): () => void {
        if (this.#closed) throw new Error("MCP extension channel is closed.");
        this.#taskHandlers.add(handler);
        return () => this.#taskHandlers.delete(handler);
    }

    async requestExtension(
        method: string,
        params: Readonly<Record<string, unknown>>,
        options: ExtensionRequestOptions,
    ): Promise<unknown> {
        const transport = this.transport;
        const metaEnvelope = this._outboundMetaEnvelope();
        if (this.#closed || transport === undefined) throw new Error("MCP extension channel is closed.");
        if (metaEnvelope === undefined) throw new Error("MCP extension channel requires a modern protocol connection.");
        options.signal?.throwIfAborted();
        const id = `${REQUEST_ID_PREFIX}${this.#nextId += 1}`;
        const requestAbort = new AbortController();
        const result = new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#settle(id, new SdkError(
                    SdkErrorCode.RequestTimeout,
                    `MCP extension request '${method}' exceeded its ${options.timeout}ms timeout.`,
                    { method, timeout: options.timeout },
                ));
                requestAbort.abort(new Error(`MCP extension request '${method}' timed out.`));
                if (
                    options.cancelRequestOnSharedTransport === true
                    && transport.hasPerRequestStream !== true
                ) {
                    void this.#cancelSharedRequest(id);
                }
            }, options.timeout);
            timer.unref();
            const onAbort = options.signal === undefined
                ? undefined
                : (): void => {
                    const reason = options.signal?.reason ?? new Error("MCP extension request aborted.");
                    this.#settle(id, reason);
                    requestAbort.abort(reason);
                    if (
                        options.cancelRequestOnSharedTransport === true
                        && transport.hasPerRequestStream !== true
                    ) {
                        void this.#cancelSharedRequest(id);
                    }
                };
            this.#pending.set(id, {
                resolve,
                reject,
                requestAbort,
                timer,
                signal: options.signal,
                onAbort,
                onProgress: options.onProgress,
            });
            options.signal?.addEventListener("abort", onAbort!, { once: true });
        });
        const message: JSONRPCMessage = {
            jsonrpc: "2.0",
            id,
            method,
            params: {
                ...params,
                _meta: {
                    ...metaEnvelope,
                    ...(options.onProgress === undefined ? {} : { progressToken: id }),
                    ...asRecord(params._meta),
                },
            },
        };
        void transport.send(message, {
            requestSignal: requestAbort.signal,
            headers: options.headers,
            onRequestStreamEnd: () => this.#settle(
                id,
                new SdkError(
                    SdkErrorCode.ConnectionClosed,
                    `MCP extension request '${method}' stream ended before its response.`,
                ),
            ),
        }).catch((cause: unknown) => this.#settle(id, cause));
        return result;
    }

    async #cancelSharedRequest(id: string): Promise<void> {
        try {
            await this.notification({
                method: "notifications/cancelled",
                params: { requestId: id },
            });
        } catch (cause) {
            this.onerror?.(asError(cause));
        }
    }

    protected override _onnotification(raw: JSONRPCNotification, extra?: MessageExtraInfo): void {
        if (raw.method === "notifications/tasks") {
            for (const handler of this.#taskHandlers) {
                try {
                    handler(raw.params);
                } catch (cause) {
                    this.onerror?.(asError(cause));
                }
            }
            return;
        }
        if (raw.method === "notifications/progress") {
            const params = asRecord(raw.params);
            const token = params?.progressToken;
            if (typeof token === "string" && token.startsWith(REQUEST_ID_PREFIX)) {
                const pending = this.#pending.get(token);
                if (pending === undefined) return;
                if (params !== undefined && typeof params.progress === "number") {
                    pending.onProgress?.({
                        progress: params.progress,
                        ...(typeof params.total === "number" ? { total: params.total } : {}),
                        ...(typeof params.message === "string" ? { message: params.message } : {}),
                    });
                } else {
                    this.onerror?.(new Error("MCP extension progress omitted numeric progress."));
                }
                return;
            }
        }
        super._onnotification(raw, extra);
    }

    protected override _onresponse(response: JSONRPCResponse): void {
        const record = asRecord(response);
        const id = record?.id;
        if (typeof id === "string" && id.startsWith(REQUEST_ID_PREFIX)) {
            const pending = this.#pending.get(id);
            if (pending === undefined) return;
            if ("error" in record!) {
                const error = asRecord(record.error);
                this.#settle(id, ProtocolError.fromError(
                    typeof error?.code === "number" ? error.code : -32603,
                    typeof error?.message === "string" ? error.message : "MCP extension request failed.",
                    error?.data,
                ));
                return;
            }
            if (!("result" in record!)) {
                this.#settle(id, new ProtocolError(-32600, "MCP extension response omitted its result."));
                return;
            }
            this.#settle(id, undefined, record.result);
            return;
        }
        if (typeof id === "string" || this.getProtocolEra() !== "modern") {
            super._onresponse(response);
            return;
        }
        // {§mcp-authority} The SDK defers notification callbacks but
        // settles responses synchronously. A microtask checkpoint keeps
        // coalesced notification/response frames in their wire order.
        queueMicrotask(() => {
            try {
                super._onresponse(response);
            } catch (cause) {
                this.onerror?.(asError(cause));
            }
        });
    }

    protected override _onclose(): void {
        this.#closeChannel();
        super._onclose();
    }

    override async close(): Promise<void> {
        this.#closeChannel();
        await super.close();
    }

    #closeChannel(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#taskHandlers.clear();
        for (const id of [...this.#pending.keys()]) {
            this.#settle(id, new SdkError(SdkErrorCode.ConnectionClosed, "MCP extension channel closed."));
        }
    }

    #settle(id: string, error?: unknown, value?: unknown): void {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        if (pending.onAbort !== undefined) {
            pending.signal?.removeEventListener("abort", pending.onAbort);
        }
        if (error === undefined) pending.resolve(value);
        else pending.reject(error);
    }
}
