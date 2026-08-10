import {
    MimetypeClassifier,
    Results,
    type ChannelProducerResult,
    type EntryData,
    type ProjectedText,
    type ProjectionCaps,
} from "@plurnk/plurnk-schemes";
import Guard, { GuardBlockedError } from "./Guard.ts";
import { responseMimetype } from "./ContentType.ts";
import {
    tavilyConfiguration,
    tavilyExtract,
    tavilyExtractIdentity,
    type TavilyExtractFailure,
    type TavilyExtractResult,
} from "./TavilyExtract.ts";
import { requirePositiveIntegerEnv } from "./Config.ts";
import ErrorDetail from "./ErrorDetail.ts";

export const DEFAULT_WEB_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
export const MARKDOWN_ACCEPT = "text/markdown, text/html;q=0.9, */*;q=0.1";
export const PROJECTION_ID_HEADER = "x-plurnk-projection-id";
export const CACHE_VARIANT_HEADER = "x-plurnk-cache-variant";
export const MATERIALIZER_ID_HEADER = "x-plurnk-materializer-id";
export const TAVILY_REQUEST_ID_HEADER = "x-plurnk-tavily-request-id";
export const TAVILY_CREDITS_HEADER = "x-plurnk-tavily-credits";
export const TAVILY_STATUS_HEADER = "x-plurnk-tavily-status";
export const TAVILY_REASON_HEADER = "x-plurnk-tavily-reason";
export const TAVILY_RETRY_AFTER_HEADER = "x-plurnk-tavily-retry-after";
export const TAVILY_ELAPSED_HEADER = "x-plurnk-tavily-elapsed-ms";
export const TAVILY_ERROR_HEADER = "x-plurnk-tavily-error";
export const TAVILY_SOURCE_URL_HEADER = "x-plurnk-tavily-source-url";
const ORIGIN_MARKDOWN_MATERIALIZER_ID = "origin-markdown:v1";
const LOCAL_UNCONFIGURED_MATERIALIZER_ID = "local-projection:v1:unconfigured";
const LOCAL_INELIGIBLE_MATERIALIZER_ID = "local-projection:v1:ineligible";

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

export const rewriteAcquisitionTarget = (url: string): string => {
    const gh = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url);
    return gh === null
        ? url
        : `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}`;
};

export interface WebResponseBody {
    readonly chunks: AsyncIterable<Uint8Array>;
    text(): Promise<string>;
    cancel(): Promise<void>;
}

export interface WebChannelFailure {
    readonly status: number;
    readonly code: string;
    readonly detail: string;
    readonly retryable: boolean;
    readonly facts?: Readonly<Record<string, unknown>>;
}

export interface WebChannelOutcome {
    readonly status: number;
    readonly failure?: WebChannelFailure;
}

export interface WebFetchResult {
    readonly url: string;
    readonly body: string | WebResponseBody;
    readonly mimetype: string;
    readonly status?: number;
    readonly statusText?: string;
    readonly responseHeaders?: ReadonlyArray<readonly [string, string]>;
    readonly response?: Response;
    readonly header?: string;
    readonly requestHeaders?: ReadonlyArray<readonly [string, string]>;
    readonly html?: { readonly content: string; readonly mimetype: string };
    readonly htmlFailure?: WebChannelFailure;
    readonly originFailure?: WebChannelFailure;
    readonly allowTavily?: boolean;
    readonly originUnavailable?: boolean;
}

export interface WebMaterializedResult {
    readonly body?: { content: string; mimetype: string };
    readonly html?: { content: string; mimetype: string };
    readonly header?: string;
    readonly bodyOutcome: WebChannelOutcome;
    readonly htmlOutcome?: WebChannelOutcome;
    readonly projection?: { sourceMimetype: string; identity: string };
}

export class WebMaterializationError extends Error {
    readonly stage = "projection";
    readonly mimetype: string;

    constructor(mimetype: string, cause: unknown) {
        super(`Web projection failed for ${mimetype}.`, { cause });
        this.name = "WebMaterializationError";
        this.mimetype = mimetype;
    }
}

const success = (status = 200): WebChannelOutcome => ({ status });
const failure = (
    status: number,
    code: string,
    detail: string,
    retryable: boolean,
    facts?: Readonly<Record<string, unknown>>,
): WebChannelOutcome => ({
    status,
    failure: { status, code, detail, retryable, ...(facts === undefined ? {} : { facts }) },
});

const safeEvidence = (value: string): string => value.replace(/[\r\n]+/g, " ").trim();

const hasHeader = (headers: ReadonlyArray<readonly [string, string]>, name: string): boolean => headers.some(
    ([candidate]) => candidate.toLowerCase() === name,
);

const replaceHeader = (
    headers: ReadonlyArray<readonly [string, string]>,
    name: string,
    value: string,
): Array<[string, string]> => [
    ...headers.filter(([candidate]) => candidate.toLowerCase() !== name)
        .map(([candidate, member]): [string, string] => [candidate, member]),
    [name, value],
];

export default class WebFetcher {
    static validateConfiguration(): void {
        requirePositiveIntegerEnv("PLURNK_SCHEMES_HTTP_FETCH_TIMEOUT");
        tavilyConfiguration();
    }

    static unavailable(url: string, cause: unknown, allowTavily: boolean): WebFetchResult {
        const detail = ErrorDetail.preview(cause, ErrorDetail.configuredLimit());
        const originFailure = {
            status: 502,
            code: "fetch-failed",
            detail: `HTTP GET ${url} failed: ${detail}`,
            retryable: true,
        } as const;
        return {
            url,
            body: "",
            mimetype: "application/octet-stream",
            header: [
                "Origin unavailable",
                "x-plurnk-request-method: GET",
                `x-plurnk-fetched-at: ${new Date().toISOString()}`,
                cacheVariantEvidence("default"),
                `x-plurnk-origin-error: ${safeEvidence(detail)}`,
            ].join("\n"),
            requestHeaders: [],
            allowTavily,
            originUnavailable: true,
            originFailure,
        };
    }

    static materializedChannels(
        materialized: WebMaterializedResult,
        source?: { readonly url: string; readonly method: string },
    ): EntryData["channels"] {
        const channels: EntryData["channels"] = {};
        if (materialized.body !== undefined) {
            channels.body = {
                ...materialized.body,
                ...(materialized.bodyOutcome.failure === undefined ? {} : { state: "errored" }),
            };
        } else if (materialized.bodyOutcome.failure !== undefined) {
            channels.body = { content: "", mimetype: "text/markdown", state: "errored" };
        }
        if (materialized.header !== undefined) {
            channels.header = { content: materialized.header, mimetype: "text/plain" };
        }
        if (materialized.html !== undefined) {
            channels.html = {
                ...materialized.html,
                ...(materialized.htmlOutcome?.failure === undefined ? {} : { state: "errored" }),
            };
        } else if (materialized.htmlOutcome?.failure !== undefined) {
            channels.html = { content: "", mimetype: "text/html", state: "errored" };
        }
        if (source === undefined) return channels;

        const outcomes: Readonly<Record<string, WebChannelOutcome>> = {
            body: materialized.bodyOutcome,
            header: materialized.header === undefined
                ? failure(502, "header-unavailable", `Acquisition evidence for ${source.url} was unavailable.`, true)
                : success(),
            html: materialized.htmlOutcome ?? (materialized.html === undefined
                ? failure(502, "html-unavailable", `Server-source HTML for ${source.url} was unavailable.`, true)
                : success()),
        };
        const defaults = {
            body: "text/markdown",
            header: "text/plain",
            html: "text/html",
        } as const;
        for (const [channel, outcome] of Object.entries(outcomes)) {
            const existing = channels[channel] ?? {
                content: "",
                mimetype: defaults[channel as keyof typeof defaults],
            };
            const producerResult = WebFetcher.#producerResult(source, outcome);
            channels[channel] = {
                ...existing,
                ...(outcome.failure === undefined ? {} : { state: "errored" as const }),
                ...(producerResult === undefined ? {} : { producerResult }),
            };
        }
        return channels;
    }

    static #producerResult(
        source: { readonly url: string; readonly method: string },
        outcome: WebChannelOutcome,
    ): ChannelProducerResult | undefined {
        if (outcome.failure === undefined) {
            return outcome.status === 200
                ? undefined
                : Results.assertChannelProducerResult({ status: outcome.status });
        }
        const { status, code, detail, retryable, facts } = outcome.failure;
        return Results.assertChannelProducerResult(Results.failure(
            "scheme:http",
            code,
            status,
            detail,
            {},
            {
                target: source.url,
                method: source.method,
                stage: "materialization",
                retryable,
                ...(facts ?? {}),
            },
        ) as ChannelProducerResult);
    }

    static async materialize(
        fetched: Pick<WebFetchResult,
            "url" | "body" | "mimetype" | "status" | "statusText" | "header" | "html" | "htmlFailure" | "originFailure" | "allowTavily" | "originUnavailable">,
        projection: ProjectionCaps,
        signal?: AbortSignal,
    ): Promise<WebMaterializedResult | null> {
        // One materializer owns page-body production and independent channel
        // outcomes {§html-materialization}/{§http-channel-outcomes}.
        if (fetched.originUnavailable === true) {
            return WebFetcher.#materializeHtml(fetched, projection, signal);
        }
        const originOutcome = WebFetcher.#originOutcome(fetched);
        if (typeof fetched.body !== "string") {
            const binary = await WebFetcher.classifyBinary(
                fetched.body,
                fetched.mimetype,
                projection,
            );
            if (binary) {
                const projected = await WebFetcher.projectBytes(
                    fetched.body,
                    fetched.mimetype,
                    projection,
                );
                if (projected === null) return null;
                return WebFetcher.#materialized(projected, {
                    html: fetched.html,
                    header: fetched.header,
                    bodyOutcome: originOutcome,
                });
            }
            const content = await fetched.body.text();
            return {
                body: { content, mimetype: fetched.mimetype },
                ...(fetched.html === undefined ? {} : { html: fetched.html }),
                ...(fetched.header === undefined ? {} : { header: fetched.header }),
                bodyOutcome: originOutcome,
                ...(fetched.html === undefined ? {} : { htmlOutcome: success() }),
            };
        }
        if (fetched.mimetype === "text/markdown") {
            const materializedHeader = WebFetcher.#appendEvidence(fetched.header, [
                WebFetcher.materializerEvidence(ORIGIN_MARKDOWN_MATERIALIZER_ID),
            ]);
            return {
                body: { content: fetched.body, mimetype: "text/markdown" },
                ...(fetched.html === undefined ? {} : { html: fetched.html }),
                ...(materializedHeader === undefined ? {} : { header: materializedHeader }),
                bodyOutcome: originOutcome,
                htmlOutcome: fetched.html === undefined
                    ? { status: fetched.htmlFailure?.status ?? 502, failure: fetched.htmlFailure ?? {
                        status: 502,
                        code: "html-variant-unavailable",
                        detail: `The HTML variant of ${fetched.url} was unavailable.`,
                        retryable: true,
                    } }
                    : success(),
            };
        }
        if (!MimetypeClassifier.isHtml(fetched.mimetype)) {
            return {
                body: { content: fetched.body, mimetype: fetched.mimetype },
                ...(fetched.header === undefined ? {} : { header: fetched.header }),
                bodyOutcome: originOutcome,
            };
        }
        return WebFetcher.#materializeHtml(fetched, projection, signal);
    }

    static async #materializeHtml(
        fetched: Pick<WebFetchResult,
            "url" | "body" | "mimetype" | "status" | "statusText" | "header" | "originFailure" | "allowTavily" | "originUnavailable">,
        projection: ProjectionCaps,
        signal?: AbortSignal,
    ): Promise<WebMaterializedResult | null> {
        const html = fetched.originUnavailable === true
            ? undefined
            : { content: fetched.body as string, mimetype: fetched.mimetype };
        const originOutcome = WebFetcher.#originOutcome(fetched);
        const tavilyIdentity = fetched.allowTavily === true
            ? tavilyExtractIdentity()
            : null;
        if (tavilyIdentity !== null) {
            const tavily = await tavilyExtract(fetched.url, { signal });
            if (tavily === null) throw new Error("Tavily configuration disappeared during materialization.");
            const evidence = [
                WebFetcher.materializerEvidence(tavily.outcome === "success"
                    ? tavilyIdentity
                    : `local-fallback:${tavilyIdentity}`),
                ...WebFetcher.#tavilyEvidence(tavily),
            ];
            if (tavily.outcome === "success") {
                const header = WebFetcher.#appendEvidence(fetched.header, evidence);
                return {
                    body: { content: tavily.markdown, mimetype: "text/markdown" },
                    ...(html === undefined ? {} : { html }),
                    ...(header === undefined ? {} : { header }),
                    bodyOutcome: success(),
                    htmlOutcome: html === undefined
                        ? failure(502, "html-unavailable", `Server-source HTML for ${fetched.url} was unavailable.`, true)
                        : originOutcome,
                };
            }
            if (tavily.outcome === "hard" || html === undefined) {
                const header = WebFetcher.#appendEvidence(fetched.header, [
                    WebFetcher.materializerEvidence(tavilyIdentity),
                    ...WebFetcher.#tavilyEvidence(tavily),
                ]);
                return {
                    ...(html === undefined ? {} : { html }),
                    ...(header === undefined ? {} : { header }),
                    bodyOutcome: WebFetcher.#tavilyFailure(fetched.url, tavily),
                    htmlOutcome: html === undefined
                        ? failure(502, "html-unavailable", `Server-source HTML for ${fetched.url} was unavailable.`, true)
                        : originOutcome,
                };
            }
            const projected = await WebFetcher.#project(html, projection);
            if (projected === null) {
                return {
                    html,
                    header: WebFetcher.#appendEvidence(fetched.header, evidence),
                    bodyOutcome: WebFetcher.#tavilyFailure(fetched.url, tavily),
                    htmlOutcome: originOutcome,
                };
            }
            return WebFetcher.#materialized(
                projected,
                {
                    html,
                    header: fetched.header,
                    materializerIdentity: `local-fallback:${tavilyIdentity}`,
                    additionalEvidence: WebFetcher.#tavilyEvidence(tavily),
                    bodyOutcome: originOutcome.failure === undefined
                        ? success(203)
                        : originOutcome,
                    htmlOutcome: originOutcome,
                },
            );
        }

        if (html === undefined) {
            return {
                ...(fetched.header === undefined ? {} : { header: fetched.header }),
                bodyOutcome: fetched.originFailure === undefined
                    ? failure(502, "origin-unavailable", `The origin ${fetched.url} was unavailable.`, true)
                    : { status: fetched.originFailure.status, failure: fetched.originFailure },
                htmlOutcome: failure(502, "html-unavailable", `Server-source HTML for ${fetched.url} was unavailable.`, true),
            };
        }
        const projected = await WebFetcher.#project(html, projection);
        const materializerIdentity = fetched.allowTavily === true
            ? LOCAL_UNCONFIGURED_MATERIALIZER_ID
            : LOCAL_INELIGIBLE_MATERIALIZER_ID;
        if (projected === null) {
            return {
                html,
                header: WebFetcher.#appendEvidence(fetched.header, [
                    WebFetcher.materializerEvidence(materializerIdentity),
                ]),
                bodyOutcome: failure(
                    422,
                    "no-readable-projection",
                    `The HTML representation of ${fetched.url} produced no readable body.`,
                    false,
                ),
                htmlOutcome: originOutcome,
            };
        }
        return WebFetcher.#materialized(
            projected,
            {
                html,
                header: fetched.header,
                materializerIdentity,
                bodyOutcome: originOutcome,
                htmlOutcome: originOutcome,
            },
        );
    }

    static #originOutcome(
        fetched: Pick<WebFetchResult, "url" | "status" | "statusText">,
    ): WebChannelOutcome {
        const status = fetched.status ?? 200;
        if (status < 400) return success(status);
        const statusText = fetched.statusText?.trim() ?? "";
        return failure(
            status,
            "http-response-status",
            `HTTP GET ${fetched.url} returned ${status}${statusText === "" ? "" : ` ${statusText}`}.`,
            status === 408 || status === 425 || status === 429 || status >= 500,
            {
                originStatus: status,
                ...(statusText === "" ? {} : { originStatusText: statusText }),
            },
        );
    }

    static #tavilyFailure(url: string, result: TavilyExtractFailure): WebChannelOutcome {
        const facts = {
            provider: "tavily",
            reason: result.reason,
            ...(result.status === undefined ? {} : { providerStatus: result.status }),
            ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
            ...(result.retryAfter === undefined ? {} : { retryAfter: result.retryAfter }),
        };
        if (result.reason === "rate-limit") {
            return failure(429, "tavily-rate-limited", `Tavily Extract rate-limited ${url}.`, true, facts);
        }
        if (result.reason === "timeout") {
            return failure(504, "tavily-timeout", `Tavily Extract timed out for ${url}.`, true, facts);
        }
        if (result.reason === "authentication") {
            return failure(502, "tavily-authentication-failed", "Tavily rejected the configured API credentials.", false, facts);
        }
        if (result.reason === "malformed-response") {
            return failure(502, "tavily-invalid-response", "Tavily returned an invalid Extract response.", false, facts);
        }
        if (result.reason === "provider-rejection") {
            return failure(502, "tavily-provider-rejected", `Tavily rejected extraction for ${url}.`, false, facts);
        }
        return failure(502, `tavily-${result.reason}`, `Tavily Extract failed for ${url}.`, true, facts);
    }

    static #tavilyEvidence(result: TavilyExtractResult): string[] {
        return [
            `${TAVILY_STATUS_HEADER}: ${result.status ?? "transport-failure"}`,
            `${TAVILY_ELAPSED_HEADER}: ${result.elapsedMs}`,
            result.requestId === undefined ? null : `${TAVILY_REQUEST_ID_HEADER}: ${safeEvidence(result.requestId)}`,
            result.credits === undefined ? null : `${TAVILY_CREDITS_HEADER}: ${result.credits}`,
            result.outcome === "success" || result.retryAfter === undefined
                ? null
                : `${TAVILY_RETRY_AFTER_HEADER}: ${safeEvidence(result.retryAfter)}`,
            result.outcome === "success"
                ? result.sourceUrl === undefined ? null : `${TAVILY_SOURCE_URL_HEADER}: ${safeEvidence(result.sourceUrl)}`
                : `${TAVILY_REASON_HEADER}: ${result.reason}`,
            result.outcome === "success" || result.error === undefined
                ? null
                : `${TAVILY_ERROR_HEADER}: ${safeEvidence(result.error)}`,
        ].filter((line): line is string => line !== null);
    }

    static async classifyBinary(
        body: Pick<WebResponseBody, "chunks" | "cancel">,
        mimetype: string,
        projection: ProjectionCaps,
    ): Promise<boolean> {
        try {
            return await projection.isBinary(mimetype);
        } catch (cause) {
            return await WebFetcher.#projectionFailure(body, mimetype, cause);
        }
    }

    static async projectBytes(
        body: Pick<WebResponseBody, "chunks" | "cancel">,
        mimetype: string,
        projection: ProjectionCaps,
    ): Promise<ProjectedText | null> {
        let projected: ProjectedText | null;
        try {
            projected = await projection.readableBytes(body.chunks, mimetype);
        } catch (cause) {
            return await WebFetcher.#projectionFailure(body, mimetype, cause);
        }
        try {
            await body.cancel();
        } catch (cause) {
            throw new WebMaterializationError(mimetype, cause);
        }
        return projected;
    }

    static async #projectionFailure(
        body: Pick<WebResponseBody, "cancel">,
        mimetype: string,
        cause: unknown,
    ): Promise<never> {
        let failureCause = cause;
        try {
            await body.cancel();
        } catch (cleanupCause) {
            failureCause = new AggregateError(
                [cause, cleanupCause],
                `Projection and response-body cleanup both failed for ${mimetype}.`,
            );
        }
        throw new WebMaterializationError(mimetype, failureCause);
    }

    static async #project(
        html: { content: string; mimetype: string },
        projection: ProjectionCaps,
    ): Promise<ProjectedText | null> {
        try {
            return await projection.readable(html.content, html.mimetype);
        } catch (cause) {
            throw new WebMaterializationError(html.mimetype, cause);
        }
    }

    static #materialized(projected: ProjectedText, options: {
        readonly html?: { content: string; mimetype: string };
        readonly header?: string;
        readonly materializerIdentity?: string;
        readonly additionalEvidence?: ReadonlyArray<string>;
        readonly bodyOutcome?: WebChannelOutcome;
        readonly htmlOutcome?: WebChannelOutcome;
    } = {}): WebMaterializedResult {
        const {
            html,
            header,
            materializerIdentity,
            additionalEvidence = [],
            bodyOutcome = success(),
            htmlOutcome = success(),
        } = options;
        const evidence = [
            ...(materializerIdentity === undefined
                ? []
                : [WebFetcher.materializerEvidence(materializerIdentity)]),
            ...additionalEvidence,
            WebFetcher.projectionEvidence(projected.projectionIdentity),
        ];
        const materializedHeader = WebFetcher.#appendEvidence(header, evidence);
        return {
            body: { content: projected.content, mimetype: projected.mimetype },
            ...(html === undefined ? {} : { html }),
            ...(materializedHeader === undefined
                ? {}
                : { header: materializedHeader }),
            bodyOutcome,
            ...(html === undefined ? {} : { htmlOutcome }),
            projection: {
                sourceMimetype: projected.sourceMimetype,
                identity: projected.projectionIdentity,
            },
        };
    }

    static #appendEvidence(header: string | undefined, evidence: ReadonlyArray<string>): string | undefined {
        const lines = [header, ...evidence].filter((line): line is string => line !== undefined && line.length > 0);
        return lines.length === 0 ? undefined : lines.join("\n");
    }

    static projectionEvidence(identity: string): string {
        return `${PROJECTION_ID_HEADER}: ${identity}`;
    }

    static materializerEvidence(identity: string): string {
        return `${MATERIALIZER_ID_HEADER}: ${identity}`;
    }

    static materializerCurrent(storedIdentity: string): boolean {
        const tavilyIdentity = tavilyExtractIdentity();
        if (storedIdentity === ORIGIN_MARKDOWN_MATERIALIZER_ID
            || storedIdentity === LOCAL_INELIGIBLE_MATERIALIZER_ID) return true;
        if (storedIdentity === LOCAL_UNCONFIGURED_MATERIALIZER_ID) return tavilyIdentity === null;
        return tavilyIdentity !== null
            && (storedIdentity === tavilyIdentity
                || storedIdentity === `local-fallback:${tavilyIdentity}`);
    }

    async fetch(url: string, opts?: {
        signal?: AbortSignal;
        headers?: ReadonlyArray<readonly [string, string]>;
        conditionalHeaders?: ReadonlyArray<readonly [string, string]>;
        guarded?: boolean;
        acceptHttpErrors?: boolean;
        preserveUnavailable?: boolean;
    }): Promise<WebFetchResult | null> {
        opts?.signal?.throwIfAborted();
        const target = rewriteAcquisitionTarget(url);
        const requestHeaders = opts?.headers ?? [];
        const authoredAccept = hasHeader(requestHeaders, "accept");
        const conditionalHeaders = opts?.conditionalHeaders ?? [];
        let transportHeaders: Array<[string, string]> = requestHeaders.map(
            ([name, value]): [string, string] => [name, value],
        );
        if (!hasHeader(transportHeaders, "accept")) {
            transportHeaders = [["Accept", MARKDOWN_ACCEPT], ...transportHeaders];
        }
        if (!hasHeader(transportHeaders, "user-agent")) {
            transportHeaders = [["User-Agent", DEFAULT_WEB_UA], ...transportHeaders];
        }
        transportHeaders.push(...conditionalHeaders.map(
            ([name, value]): [string, string] => [name, value],
        ));

        const fetchTimeout = requirePositiveIntegerEnv("PLURNK_SCHEMES_HTTP_FETCH_TIMEOUT");
        const timeout = AbortSignal.timeout(fetchTimeout);
        const signal = opts?.signal === undefined ? timeout : AbortSignal.any([opts.signal, timeout]);
        const guarded = opts?.guarded !== false;
        const request = async (requestUrl: string, headers: ReadonlyArray<readonly [string, string]>): Promise<Response> => guarded
            ? Guard.fetch(requestUrl, { method: "GET", body: undefined, headers }, signal)
            : fetch(requestUrl, {
                method: "GET",
                headers: headers.map(([name, value]): [string, string] => [name, value]),
                signal,
                redirect: "follow",
            });

        let response: Response;
        try {
            response = await request(target, transportHeaders);
        } catch (cause) {
            if (opts?.signal?.aborted === true) throw opts.signal.reason;
            if (cause instanceof GuardBlockedError) return null;
            const publiclyAdmitted = guarded || await Guard.isPublicUrl(target);
            const allowTavily = requestHeaders.length === 0 && publiclyAdmitted;
            return (allowTavily && tavilyExtractIdentity() !== null)
                || opts?.preserveUnavailable === true
                ? WebFetcher.unavailable(url, cause, allowTavily)
                : null;
        }

        if (opts?.acceptHttpErrors !== true && !response.ok) {
            await response.body?.cancel();
            return null;
        }
        const responseHeaders = [...response.headers];
        const mimetype = responseMimetype(response.headers.get("content-type"));
        const tavilyConfigured = tavilyExtractIdentity() !== null;
        const publiclyAdmitted = guarded
            || !tavilyConfigured
            || (requestHeaders.length === 0 && await Guard.isPublicUrl(target));
        const allowTavily = requestHeaders.length === 0 && publiclyAdmitted;
        const header = WebFetcher.#header(response, requestHeaders, url);
        const common = {
            url,
            mimetype,
            status: response.status,
            statusText: response.statusText,
            responseHeaders,
            response,
            header,
            requestHeaders,
            allowTavily,
        };
        const unavailableAfterResponse = (cause: unknown): WebFetchResult | null => {
            if (opts?.signal?.aborted === true) throw opts.signal.reason;
            if (!(allowTavily && tavilyConfigured) && opts?.preserveUnavailable !== true) return null;
            const unavailable = WebFetcher.unavailable(url, cause, allowTavily);
            const detail = unavailable.originFailure?.detail ?? `HTTP GET ${url} failed.`;
            return {
                ...common,
                body: "",
                header: WebFetcher.#appendEvidence(common.header, [
                    `x-plurnk-origin-error: ${safeEvidence(detail)}`,
                ]),
                originUnavailable: true,
                originFailure: unavailable.originFailure,
            };
        };

        let pageBody: string | undefined;
        if (MimetypeClassifier.isHtml(mimetype) || mimetype === "text/markdown") {
            try {
                pageBody = await response.text();
            } catch (cause) {
                return unavailableAfterResponse(cause);
            }
        }

        if (MimetypeClassifier.isHtml(mimetype)) {
            return { ...common, body: pageBody! };
        }
        if (mimetype === "text/markdown") {
            const markdown = pageBody!;
            if (authoredAccept) return { ...common, body: markdown };
            let html: WebFetchResult["html"];
            let htmlFailure: WebChannelFailure | undefined;
            const variantHeaders = replaceHeader(transportHeaders, "accept", "text/html");
            try {
                const variant = await request(target, variantHeaders);
                const variantMimetype = responseMimetype(variant.headers.get("content-type"));
                if (variant.ok && MimetypeClassifier.isHtml(variantMimetype)) {
                    html = { content: await variant.text(), mimetype: variantMimetype };
                    common.header = WebFetcher.#appendEvidence(common.header, WebFetcher.#htmlVariantEvidence(variant, url))!;
                } else {
                    await variant.body?.cancel();
                    htmlFailure = {
                        status: 502,
                        code: "html-variant-unavailable",
                        detail: `The origin did not provide an HTML variant of ${url}.`,
                        retryable: true,
                    };
                }
            } catch (cause) {
                if (opts?.signal?.aborted === true) throw opts.signal.reason;
                htmlFailure = {
                    status: 502,
                    code: "html-variant-unavailable",
                    detail: `The HTML variant of ${url} could not be acquired: ${ErrorDetail.preview(cause, ErrorDetail.configuredLimit())}`,
                    retryable: true,
                };
            }
            return {
                ...common,
                body: markdown,
                ...(html === undefined ? {} : { html }),
                ...(htmlFailure === undefined ? {} : { htmlFailure }),
            };
        }
        if (response.body === null) return { ...common, body: "" };
        const responseBody = response.body;
        return {
            ...common,
            body: {
                chunks: responseBody as AsyncIterable<Uint8Array>,
                text: () => response.text(),
                cancel: () => responseBody.cancel(),
            },
        };
    }

    static #header(
        response: Response,
        requestHeaders: ReadonlyArray<readonly [string, string]>,
        addressedUrl: string,
    ): string {
        const responseHeaders = [...response.headers];
        return [
            `HTTP ${response.status} ${response.statusText}`,
            ...responseHeaders.map(([key, value]) => `${key}: ${value}`),
            "x-plurnk-request-method: GET",
            `x-plurnk-fetched-at: ${new Date().toISOString()}`,
            `x-plurnk-response-url: ${safeEvidence(response.url || addressedUrl)}`,
            cacheVariantEvidence(classifyCacheVariant(requestHeaders, responseHeaders)),
        ].join("\n");
    }

    static #htmlVariantEvidence(response: Response, addressedUrl: string): string[] {
        return [
            `x-plurnk-html-status: ${response.status}`,
            `x-plurnk-html-response-url: ${safeEvidence(response.url || addressedUrl)}`,
            `x-plurnk-html-fetched-at: ${new Date().toISOString()}`,
            ...[...response.headers].map(([name, value]) =>
                `x-plurnk-html-response-header: ${safeEvidence(name)}: ${safeEvidence(value)}`),
        ];
    }
}
