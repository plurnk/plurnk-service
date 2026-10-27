import { createParser, type ParseError } from "eventsource-parser";
import { ErrorDetail, Knob } from "@plurnk/plurnk-meta";
import {
    MetadataOptions,
    NetworkAddress,
    ProjectionInputLimitError,
    Results,
    type ChannelProducerResult,
    type EntryData,
    type PassthroughResult,
    type SchemeResult,
    type StreamSubscription,
    type UrlPath,
    type WebMaterializationError,
} from "@plurnk/plurnk-schemes";
import { MIMEType } from "node:util";
import { HostPolicy } from "./Guard.ts";

export const BODY = "body";
export const HEADER = "header";
export const FETCHED_AT = "x-plurnk-fetched-at";
export const REQUEST_METHOD = "x-plurnk-request-method";
export const PROJECTION_ID_HEADER = "x-plurnk-projection-id";
export const CACHE_VARIANT_HEADER = "x-plurnk-cache-variant";
export const MATERIALIZER_ID_HEADER = "x-plurnk-materializer-id";
export const OUTBOUND_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "DELETE"]);

export const HTTP_CHANNELS: Readonly<Record<string, string>> = {
    [BODY]: "application/octet-stream",
    [HEADER]: "text/plain",
    readable: "text/markdown",
};

// {§env-knob} — the panel states the value; an unset key is a broken floor. A text knob this
// scheme reads is never blank: a blank user agent or origin is a misconfiguration, not a value.
export const requireTextEnv = (key: string): string => {
    const raw = Knob.text(key);
    if (raw.trim().length === 0) throw new Error(`${key} must not be blank; got ${JSON.stringify(raw)}.`);
    return raw;
};

export const requireFlagEnv = (key: string): boolean => Knob.flag(key);

export const requireNonNegativeIntegerEnv = (key: string): number => Knob.integer(key, 0);

export const requirePositiveIntegerEnv = (key: string): number => Knob.integer(key, 1);

export const webUserAgent = (): string => requireTextEnv("PLURNK_SCHEMES_HTTP_USER_AGENT");

export type CacheVariant = "default" | "bypass";

export const classifyCacheVariant = (
    requestHeaders: ReadonlyArray<readonly [string, string]>,
    responseHeaders: ReadonlyArray<readonly [string, string]>,
): CacheVariant => requestHeaders.length === 0
    && !responseHeaders.some(([name]) => name.toLowerCase() === "vary")
    ? "default"
    : "bypass";

export const cacheVariantEvidence = (variant: CacheVariant): string =>
    `${CACHE_VARIANT_HEADER}: ${variant}`;

const UNKNOWN_RESPONSE_MIMETYPE = "application/octet-stream";

export const responseMimetype = (contentType: string | null): string => {
    if (contentType === null) return UNKNOWN_RESPONSE_MIMETYPE;
    try {
        return new MIMEType(contentType).essence;
    } catch {
        return UNKNOWN_RESPONSE_MIMETYPE;
    }
};

export const ERROR_DETAIL_LIMIT = "PLURNK_SCHEMES_HTTP_ERROR_DETAIL_LIMIT";

export const errorDetail = new ErrorDetail(ERROR_DETAIL_LIMIT);

// {§revalidation} Addressed cancellation reaches every local acquisition of the resource.
export class LiveAcquisitions {
    readonly #controllers = new Map<string, Set<AbortController>>();

    static key(workspaceId: number, url: string): string {
        return `${workspaceId}:${url}`;
    }

    static composed(outer: AbortSignal | undefined, local: AbortSignal): AbortSignal {
        return outer === undefined ? local : AbortSignal.any([outer, local]);
    }

    track(key: string, controller: AbortController): () => void {
        const controllers = this.#controllers.get(key) ?? new Set<AbortController>();
        controllers.add(controller);
        this.#controllers.set(key, controllers);
        return () => {
            controllers.delete(controller);
            if (controllers.size === 0 && this.#controllers.get(key) === controllers) this.#controllers.delete(key);
        };
    }

    cancel(key: string): boolean {
        const controllers = this.#controllers.get(key);
        if (controllers === undefined) return false;
        this.#controllers.delete(key);
        for (const controller of controllers) controller.abort();
        return true;
    }
}

export const httpBad = (
    status: number,
    scheme: string,
    kind: string,
    message: string,
    extensions: Readonly<Record<string, unknown>> = {},
): PassthroughResult & ChannelProducerResult => Results.failure(
    `scheme:${scheme}`,
    kind,
    status,
    message,
    { shape: "passthrough" },
    extensions,
);

export const httpPassthrough = (result: SchemeResult): PassthroughResult & ChannelProducerResult =>
    Results.assertChannelProducerResult({ ...result, shape: "passthrough" });

export const httpCancelled = (url: string, method: string): PassthroughResult & ChannelProducerResult =>
    httpBad(
        499,
        "http",
        "cancelled",
        `HTTP ${method} ${url} was cancelled.`,
        {
            target: url,
            method,
            stage: "acquisition",
            retryable: false,
        },
    );

export const httpMaterializationFailure = (
    url: string,
    method: string,
    error: WebMaterializationError,
): PassthroughResult & ChannelProducerResult => {
    if (error.stage === "projection" && error.cause instanceof ProjectionInputLimitError) {
        return httpBad(
            413,
            "http",
            "projection-input-limit",
            `HTTP ${method} ${url} exceeded the ${error.cause.maximumBytes}-byte binary input limit.`,
            {
                target: url,
                method,
                mimetype: error.cause.mimetype,
                maximumBytes: error.cause.maximumBytes,
                observedBytes: error.cause.observedBytes,
                stage: "projection",
                retryable: false,
            },
        );
    }
    console.error("HTTP materialization failed", { method, url, error });
    return httpBad(
        500,
        "http",
        "projection-failed",
        `HTTP ${method} ${url} response materialization failed.`,
        {
            target: url,
            method,
            mimetype: error.mimetype,
            stage: "projection",
            retryable: false,
        },
    );
};

export const httpAddress = (target: UrlPath): NetworkAddress | PassthroughResult => {
    let address: NetworkAddress;
    try {
        address = NetworkAddress.from(target);
    } catch {
        return httpBad(400, "http", "bad-target", "HTTP operations require an http(s):// URL with an authority.", {
            stage: "target-validation",
            recovery: "Provide an http(s):// URL with a host.",
            retryable: false,
        });
    }
    if (address.scheme !== "http" && address.scheme !== "https") {
        return httpBad(400, "http", "bad-target", "HTTP operations require an http(s):// URL target.", {
            stage: "target-validation",
            recovery: "Provide an http(s):// URL target.",
            retryable: false,
        });
    }
    if (address.hasCredentials) {
        return httpBad(400, "http", "userinfo-not-allowed", "HTTP URL userinfo is not allowed.", {
            target: address.url,
            stage: "target-validation",
            recovery: "Remove credentials from the URL and use request metadata where authorization is required.",
            retryable: false,
        });
    }
    if (!HostPolicy.permits(address.url)) {
        return httpBad(403, "http", "host-not-permitted", `${new URL(address.url).hostname} is outside the operator's web host policy.`, {
            target: address.url,
            stage: "target-validation",
            retryable: false,
        });
    }
    return address;
};

export const parseRequestHeaders = (
    metadata: readonly string[] | null,
): Array<[string, string]> | (PassthroughResult & ChannelProducerResult) => {
    const read = MetadataOptions.parse(metadata, "scheme:http");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a metadata refusal has no shape; the method's result type names the success's passthrough shape
    if ("failure" in read) return read.failure as PassthroughResult & ChannelProducerResult;
    const headers: Array<[string, string]> = [];
    for (const [name, value] of Object.entries(read.options)) {
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) {
            return httpBad(400, "http", "metadata-header-name", `HTTP metadata key '${name}' is not a valid header name.`, { retryable: false });
        }
        if (typeof value !== "string") {
            return httpBad(400, "http", "metadata-header-shape", `HTTP header '${name}' requires a string value.`, { retryable: false });
        }
        headers.push([name, value.trim()]);
    }
    return headers;
};

export const seedEntry = (): EntryData => {
    const channels = Object.fromEntries(
        Object.entries(HTTP_CHANNELS).map(([name, mimetype]) => [name, {
            content: "",
            mimetype,
            state: "active" as const,
        }]),
    );
    return { channels };
};

export const responseHeader = (
    method: string,
    status: number,
    statusText: string,
    responseHeaders: ReadonlyArray<readonly [string, string]>,
    requestHeaders: ReadonlyArray<readonly [string, string]>,
): string => {
    const lines = [`HTTP ${status} ${statusText}`];
    for (const [k, v] of responseHeaders) lines.push(`${k}: ${v}`);
    lines.push(`${REQUEST_METHOD}: ${method}`);
    lines.push(`${FETCHED_AT}: ${new Date().toISOString()}`);
    lines.push(cacheVariantEvidence(classifyCacheVariant(requestHeaders, responseHeaders)));
    return lines.join("\n");
};

export const writeProjectionIdentity = async (
    subscription: StreamSubscription,
    identity: string,
): Promise<void> => {
    await subscription.notifyChunk(
        HEADER,
        `\n${PROJECTION_ID_HEADER}: ${identity}`,
        "text/plain",
    );
};

const streamEvents = async (subscription: StreamSubscription, response: Response): Promise<number> => {
    if (response.body === null) return 0;
    const decoder = new TextDecoder();
    const pending: string[] = [];
    let fatal: ParseError | null = null;
    let events = 0;
    const parser = createParser({
        maxBufferSize: requireNonNegativeIntegerEnv("PLURNK_SCHEMES_HTTP_SSE_MAX_BUFFER_CHARS"),
        onEvent: ({ data }) => pending.push(data),
        onError: (error) => {
            if (error.type === "max-buffer-size-exceeded") fatal = error;
        },
    });
    const publish = async () => {
        for (const data of pending.splice(0)) {
            events += 1;
            await subscription.notifyChunk(BODY, `${data}\n`, "text/plain");
        }
    };
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        parser.feed(decoder.decode(chunk, { stream: true }));
        if (fatal !== null) throw fatal;
        await publish();
    }
    const tail = decoder.decode();
    if (tail.length > 0) parser.feed(tail);
    parser.reset({ consume: true });
    if (fatal !== null) throw fatal;
    await publish();
    return events;
};

export const settleEventStream = async (
    subscription: StreamSubscription,
    response: Response,
    options: { url: string; method: string; signal: AbortSignal },
): Promise<void> => {
    try {
        const events = await streamEvents(subscription, response);
        if (options.signal.aborted) {
            const result = httpCancelled(options.url, options.method);
            await subscription.close(result, result.problem?.detail);
            return;
        }
        await subscription.close({ status: 200 }, `SSE stream; ${events} events`);
    } catch (error) {
        if (options.signal.aborted) {
            const result = httpCancelled(options.url, options.method);
            await subscription.close(result, result.problem?.detail);
            return;
        }
        console.error("HTTP SSE stream failed", { method: options.method, url: options.url, error });
        const cause = errorDetail.preview(error);
        const reason = `HTTP ${options.method} ${options.url} failed: ${cause}`;
        const result = httpBad(
            502,
            "http",
            "fetch-failed",
            reason,
            {
                target: options.url,
                method: options.method,
                stage: "transfer",
                retryable: false,
            },
        );
        await subscription.close(result, reason);
    }
};
