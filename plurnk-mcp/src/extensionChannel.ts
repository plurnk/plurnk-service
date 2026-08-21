import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    PROTOCOL_VERSION_META_KEY,
    ProtocolError,
    SdkError,
    SdkErrorCode,
    type ClientCapabilities,
    type Implementation,
    type JSONRPCMessage,
    type Progress,
    type Transport,
} from "@modelcontextprotocol/client";

const REQUEST_ID_PREFIX = "plurnk-extension:";

interface RequestOptions {
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

interface ExtensionChannelOptions {
    readonly protocolVersion: string;
    readonly clientInfo: Implementation;
    readonly clientCapabilities: ClientCapabilities;
    readonly cancelRequest: (requestId: string) => Promise<void>;
    readonly onError?: (error: Error) => void;
}

type TaskNotificationHandler = (params: unknown) => void;
type MessageExtra = Parameters<NonNullable<Transport["onmessage"]>>[1];

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;

const asError = (cause: unknown): Error => cause instanceof Error
    ? cause
    : new Error(String(cause));

export default class ExtensionChannel {
    readonly #transport: Transport;
    readonly #options: ExtensionChannelOptions;
    readonly #pending = new Map<string, PendingRequest>();
    readonly #taskHandlers = new Set<TaskNotificationHandler>();
    readonly #priorMessage: Transport["onmessage"];
    readonly #priorClose: Transport["onclose"];
    readonly #messageHandler: NonNullable<Transport["onmessage"]>;
    readonly #closeHandler: NonNullable<Transport["onclose"]>;
    #nextId = 0;
    #closed = false;

    constructor(transport: Transport, options: ExtensionChannelOptions) {
        this.#transport = transport;
        this.#options = options;
        this.#priorMessage = transport.onmessage;
        this.#priorClose = transport.onclose;
        this.#messageHandler = (message, extra): void => this.#receive(message, extra);
        this.#closeHandler = (): void => {
            this.#rejectAll(new SdkError(SdkErrorCode.ConnectionClosed, "MCP extension channel closed."));
            this.#priorClose?.();
        };
        transport.onmessage = this.#messageHandler;
        transport.onclose = this.#closeHandler;
    }

    onTaskNotification(handler: TaskNotificationHandler): () => void {
        if (this.#closed) throw new Error("MCP extension channel is closed.");
        this.#taskHandlers.add(handler);
        return () => this.#taskHandlers.delete(handler);
    }

    async request(
        method: string,
        params: Readonly<Record<string, unknown>>,
        options: RequestOptions,
    ): Promise<unknown> {
        if (this.#closed) throw new Error("MCP extension channel is closed.");
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
                    && this.#transport.hasPerRequestStream !== true
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
                        && this.#transport.hasPerRequestStream !== true
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
                    [PROTOCOL_VERSION_META_KEY]: this.#options.protocolVersion,
                    [CLIENT_INFO_META_KEY]: this.#options.clientInfo,
                    [CLIENT_CAPABILITIES_META_KEY]: this.#options.clientCapabilities,
                    ...(options.onProgress === undefined ? {} : { progressToken: id }),
                    ...asRecord(params._meta),
                },
            },
        };
        void this.#transport.send(message, {
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
            await this.#options.cancelRequest(id);
        } catch (cause) {
            this.#options.onError?.(asError(cause));
        }
    }

    #receive(message: JSONRPCMessage, extra?: MessageExtra): void {
        const record = asRecord(message);
        if (record === undefined) {
            this.#priorMessage?.(message, extra);
            return;
        }
        const id = record.id;
        if (typeof id === "string" && id.startsWith(REQUEST_ID_PREFIX)) {
            const pending = this.#pending.get(id);
            if (pending === undefined) return;
            if ("error" in record) {
                const error = asRecord(record.error);
                this.#settle(id, ProtocolError.fromError(
                    typeof error?.code === "number" ? error.code : -32603,
                    typeof error?.message === "string" ? error.message : "MCP extension request failed.",
                    error?.data,
                ));
                return;
            }
            if (!("result" in record)) {
                this.#settle(id, new ProtocolError(-32600, "MCP extension response omitted its result."));
                return;
            }
            this.#settle(id, undefined, record.result);
            return;
        }
        if (record.method === "notifications/tasks") {
            for (const handler of this.#taskHandlers) {
                try {
                    handler(record.params);
                } catch (cause) {
                    this.#options.onError?.(asError(cause));
                }
            }
            return;
        }
        if (record.method === "notifications/progress") {
            const params = asRecord(record.params);
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
                    this.#options.onError?.(new Error("MCP extension progress omitted numeric progress."));
                }
                return;
            }
        }
        if (record.id !== undefined && ("result" in record || "error" in record)) {
            // {§mcp-core-matrix} The SDK defers notification callbacks but
            // settles responses synchronously. A microtask checkpoint keeps
            // coalesced notification/response frames in their wire order.
            queueMicrotask(() => {
                try {
                    this.#priorMessage?.(message, extra);
                } catch (cause) {
                    this.#options.onError?.(asError(cause));
                }
            });
            return;
        }
        this.#priorMessage?.(message, extra);
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

    #rejectAll(error: Error): void {
        for (const id of [...this.#pending.keys()]) this.#settle(id, error);
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#taskHandlers.clear();
        this.#rejectAll(new SdkError(SdkErrorCode.ConnectionClosed, "MCP extension channel closed."));
        if (this.#transport.onmessage === this.#messageHandler) {
            this.#transport.onmessage = this.#priorMessage;
        }
        if (this.#transport.onclose === this.#closeHandler) {
            this.#transport.onclose = this.#priorClose;
        }
    }
}
