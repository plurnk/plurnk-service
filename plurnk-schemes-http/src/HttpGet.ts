// The GET path of the http scheme: the fetch, event-stream opening, and the llms.txt piggyback. Split out of Http.
import type { SchemeCtx, SubscriptionHandle, StreamSubscription, ChannelProducerResult, PassthroughResult, RepresentationPreparationResult, UrlPath, EntryData, StoredEntryData, SchemeResult, ProjectionCaps } from "@plurnk/plurnk-schemes";
import { NetworkAddress, Results } from "@plurnk/plurnk-schemes";
import WebFetcher, { WebMaterializationError, type WebFetchResult, type WebMaterializedResult } from "./WebFetcher.ts";
import { BODY, HEADER } from "./http-names.ts";

const LLMS_TEXT_ATTEMPT_TTL_MS = 3_600_000;

export default class HttpGet {
    readonly #errorDetailLimit: number;
    readonly #webFetcher: WebFetcher;
    readonly #address: (target: UrlPath) => NetworkAddress | PassthroughResult;
    readonly #requestHeaders: (metadata: readonly string[] | null) => Array<[string, string]> | (PassthroughResult & ChannelProducerResult);
    readonly #passthrough: (result: SchemeResult) => PassthroughResult & ChannelProducerResult;
    readonly #requestMethod: (priorHeader: string) => string | undefined;
    readonly #reusableGetRepresentation: (entry: StoredEntryData, requestHeaders: ReadonlyArray<readonly [string, string]>, projection: ProjectionCaps) => Promise<boolean>;
    readonly #materializerIdentity: (priorHeader: string) => string | undefined;
    readonly #validators: (priorHeader: string) => Array<[string, string]>;
    readonly #materializationFailure: (url: string, method: string, error: WebMaterializationError) => PassthroughResult & ChannelProducerResult;
    readonly #sourceMimetype: (header: string) => string;
    readonly #fresh: (header: string, now?: number) => boolean;
    readonly #cancelled: (url: string, method: string) => PassthroughResult & ChannelProducerResult;
    readonly #bad: (status: number, scheme: string, kind: string, message: string, extensions?: Readonly<Record<string, unknown>>) => PassthroughResult & ChannelProducerResult;
    readonly #revalidationCorresponds: (priorHeader: string, responseHeaders: Headers) => boolean;
    readonly #refreshAfter304: (header: string, responseHeaders: ReadonlyArray<readonly [string, string]>, requestHeaders: ReadonlyArray<readonly [string, string]>) => string;
    readonly #seedEntry: () => EntryData;
    readonly #settleEventStream: (subscription: StreamSubscription, response: Response, options: { url: string; method: string; signal: AbortSignal; errorDetailLimit: number }) => Promise<void>;
    readonly #llmsTextAttempts = new Map<string, number>();

    constructor({ errorDetailLimit, webFetcher, address, requestHeaders, passthrough, requestMethod, reusableGetRepresentation, materializerIdentity, validators, materializationFailure, sourceMimetype, fresh, cancelled, bad, revalidationCorresponds, refreshAfter304, seedEntry, settleEventStream }: {
        errorDetailLimit: number;
        webFetcher: WebFetcher;
        address: (target: UrlPath) => NetworkAddress | PassthroughResult;
        requestHeaders: (metadata: readonly string[] | null) => Array<[string, string]> | (PassthroughResult & ChannelProducerResult);
        passthrough: (result: SchemeResult) => PassthroughResult & ChannelProducerResult;
        requestMethod: (priorHeader: string) => string | undefined;
        reusableGetRepresentation: (entry: StoredEntryData, requestHeaders: ReadonlyArray<readonly [string, string]>, projection: ProjectionCaps) => Promise<boolean>;
        materializerIdentity: (priorHeader: string) => string | undefined;
        validators: (priorHeader: string) => Array<[string, string]>;
        materializationFailure: (url: string, method: string, error: WebMaterializationError) => PassthroughResult & ChannelProducerResult;
        sourceMimetype: (header: string) => string;
        fresh: (header: string, now?: number) => boolean;
        cancelled: (url: string, method: string) => PassthroughResult & ChannelProducerResult;
        bad: (status: number, scheme: string, kind: string, message: string, extensions?: Readonly<Record<string, unknown>>) => PassthroughResult & ChannelProducerResult;
        revalidationCorresponds: (priorHeader: string, responseHeaders: Headers) => boolean;
        refreshAfter304: (header: string, responseHeaders: ReadonlyArray<readonly [string, string]>, requestHeaders: ReadonlyArray<readonly [string, string]>) => string;
        seedEntry: () => EntryData;
        settleEventStream: (subscription: StreamSubscription, response: Response, options: { url: string; method: string; signal: AbortSignal; errorDetailLimit: number }) => Promise<void>;
    }) {
        this.#errorDetailLimit = errorDetailLimit;
        this.#webFetcher = webFetcher;
        this.#address = address;
        this.#requestHeaders = requestHeaders;
        this.#passthrough = passthrough;
        this.#requestMethod = requestMethod;
        this.#reusableGetRepresentation = reusableGetRepresentation;
        this.#materializerIdentity = materializerIdentity;
        this.#validators = validators;
        this.#materializationFailure = materializationFailure;
        this.#sourceMimetype = sourceMimetype;
        this.#fresh = fresh;
        this.#cancelled = cancelled;
        this.#bad = bad;
        this.#revalidationCorresponds = revalidationCorresponds;
        this.#refreshAfter304 = refreshAfter304;
        this.#seedEntry = seedEntry;
        this.#settleEventStream = settleEventStream;
    }

    async prepareGet(
        target: UrlPath,
        metadata: readonly string[] | null,
        pathname: string,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult> {
        const address = this.#address(target);
        if (!(address instanceof NetworkAddress)) return address;
        const { url } = address;
        const requestHeaders = this.#requestHeaders(metadata);
        if (!Array.isArray(requestHeaders)) return requestHeaders;
        let cached: StoredEntryData | undefined;
        const conditional: Array<[string, string]> = [];
        const prior = await ctx.entries.read(pathname);
        if (Results.isErrorStatus(prior.status) && prior.status !== 404) {
            return this.#passthrough(prior);
        }
        const priorBody = prior.entry?.channels[BODY];
        const priorHeader = prior.entry?.channels[HEADER];
        if (prior.entry !== null && this.#requestMethod(priorHeader?.content ?? "") === undefined) {
            return { status: 200 };
        }
        if (prior.entry !== null && priorBody !== undefined && priorHeader !== undefined) {
            try {
                if (await this.#reusableGetRepresentation(prior.entry, requestHeaders, ctx.projection)) {
                    cached = prior.entry;
                    if (this.#materializerIdentity(priorHeader.content) === undefined) {
                        conditional.push(...this.#validators(priorHeader.content));
                    }
                }
            } catch (cause) {
                return this.#materializationFailure(
                    url,
                    "GET",
                    new WebMaterializationError(this.#sourceMimetype(priorHeader.content), cause),
                );
            }
        }
        if (cached !== undefined && this.#fresh(cached.channels[HEADER]!.content)) {
            return { status: 200 };
        }

        let fetched: WebFetchResult | null;
        try {
            fetched = await this.#webFetcher.fetch(url, {
                signal: ctx.signal,
                headers: requestHeaders,
                ...(conditional.length > 0
                    ? { conditionalHeaders: conditional }
                    : {}),
                guarded: false,
                acceptHttpErrors: true,
                preserveUnavailable: true,
            });
        } catch (error) {
            if (ctx.signal?.aborted === true && error === ctx.signal.reason) {
                return this.#cancelled(url, "GET");
            }
            throw error;
        }
        if (fetched === null) {
            return this.#bad(
                404,
                "http",
                "not-materialized",
                `The URL ${url} could not be materialized.`,
                {
                    target: url,
                    stage: "acquisition",
                    retryable: true,
                },
            );
        }

        if (fetched.status === 304) {
            if (cached === undefined) {
                return this.#bad(
                    502,
                    "http",
                    "fetch-failed",
                    `HTTP GET ${url} returned 304 without a reusable stored representation.`,
                    {
                        target: url,
                        method: "GET",
                        stage: "acquisition",
                        retryable: true,
                    },
                );
            }
            const cachedHeader = cached.channels[HEADER]!.content;
            if (this.#materializerIdentity(cachedHeader) !== undefined) {
                return this.#bad(
                    502,
                    "http",
                    "fetch-failed",
                    `HTTP GET ${url} returned 304 for a stored representation that requires full reacquisition.`,
                    {
                        target: url,
                        method: "GET",
                        stage: "acquisition",
                        retryable: true,
                    },
                );
            }
            const responseHeaders = fetched.responseHeaders ?? [];
            if (this.#revalidationCorresponds(
                cachedHeader,
                new Headers(responseHeaders.map(([name, value]) => [name, value])),
            )) {
                const channels: EntryData["channels"] = {
                    ...cached.channels,
                    [HEADER]: {
                        ...cached.channels[HEADER]!,
                        content: this.#refreshAfter304(cachedHeader, responseHeaders, requestHeaders),
                    },
                };
                const written = await ctx.entries.write(pathname, {
                    channels,
                });
                if (Results.isErrorStatus(written.status)) return this.#passthrough(written);
                return { status: 200 };
            }
            // {§revalidation} — a genuinely mismatched 304 (different opaque
            // tags): the conditional is the problem, so fall back to one
            // unconditional GET and acquire normally instead of surfacing
            // an unrecoverable 502. A second 304 has no way out and is the
            // honest failure.
            try {
                fetched = await this.#webFetcher.fetch(url, {
                    signal: ctx.signal,
                    headers: requestHeaders,
                    guarded: false,
                    acceptHttpErrors: true,
                    preserveUnavailable: true,
                });
            } catch (error) {
                if (ctx.signal?.aborted === true && error === ctx.signal.reason) {
                    return this.#cancelled(url, "GET");
                }
                throw error;
            }
            if (fetched === null) {
                return this.#bad(
                    404,
                    "http",
                    "not-materialized",
                    `The URL ${url} could not be materialized.`,
                    {
                        target: url,
                        stage: "acquisition",
                        retryable: true,
                    },
                );
            }
            if (fetched.status === 304) {
                return this.#bad(
                    502,
                    "http",
                    "fetch-failed",
                    `HTTP GET ${url} returned 304 without identifying the stored representation nominated for revalidation.`,
                    {
                        target: url,
                        method: "GET",
                        stage: "acquisition",
                        retryable: true,
                    },
                );
            }
            // Non-304: fall through to ordinary acquisition below.
        }

        if (fetched.mimetype === "text/event-stream"
            && fetched.response?.body !== null
            && fetched.response?.body !== undefined) {
            return this.#openEventStream(address, fetched, ctx);
        }

        let materialized: WebMaterializedResult | null;
        try {
            materialized = await WebFetcher.materialize(fetched, ctx.projection, ctx.signal);
        } catch (error) {
            if (ctx.signal?.aborted === true) return this.#cancelled(url, "GET");
            if (error instanceof WebMaterializationError) {
                return this.#materializationFailure(url, "GET", error);
            }
            throw error;
        }
        if (materialized === null) {
            return this.#bad(
                415,
                "http",
                "binary-response-unsupported",
                `HTTP GET ${url} returned ${fetched.mimetype}. The remote response was received, but its binary body cannot be represented in a Plurnk text channel.`,
                {
                    target: url,
                    method: "GET",
                    mimetype: fetched.mimetype,
                    stage: "materialization",
                    recovery: "Inspect #header or use a byte-capable client.",
                    retryable: false,
                },
            );
        }
        const written = await ctx.entries.write(pathname, {
            channels: WebFetcher.materializedChannels(materialized, { url, method: "GET" }),
        });
        if (Results.isErrorStatus(written.status)) return this.#passthrough(written);
        await this.#piggybackLlmsText(address, ctx);
        return { status: 200 };
    }


    async #openEventStream(
        address: NetworkAddress,
        fetched: WebFetchResult,
        ctx: SchemeCtx,
    ): Promise<PassthroughResult> {
        const response = fetched.response;
        if (response?.body === null || response?.body === undefined) {
            throw new Error("SSE preparation lost its response body.");
        }
        const local = new AbortController();
        const handle: SubscriptionHandle = {
            cancel: async () => {
                local.abort();
                await response.body?.cancel().catch(() => {});
            },
        };
        const written = await ctx.entries.write(address.pathname, this.#seedEntry());
        if (Results.isErrorStatus(written.status)) return this.#passthrough(written);
        const subscription = await ctx.subscriptions.open(address.pathname, handle);
        if (fetched.header !== undefined) {
            await subscription.notifyChunk(HEADER, fetched.header, "text/plain");
        }
        void this.#settleEventStream(subscription, response, {
            url: address.url,
            method: "GET",
            signal: local.signal,
            errorDetailLimit: this.#errorDetailLimit,
        }).catch((error: unknown) => {
            console.error("HTTP SSE terminal cleanup failed", { url: address.url, error });
        });
        return { shape: "passthrough", status: 102 };
    }


    // {§http-llms-txt} — after a successful generic GET materialization,
    // acquire <origin>/llms.txt once per TTL window and materialize it as its
    // own https entry. Any failure is quiet: the companion never fails the
    // READ that piggybacked it, and the companion itself never recurses.
    async #piggybackLlmsText(address: NetworkAddress, ctx: SchemeCtx): Promise<void> {
        const url = new URL(address.url);
        if (url.pathname === "/llms.txt") return;
        const origin = url.origin;
        const last = this.#llmsTextAttempts.get(origin);
        if (last !== undefined && Date.now() - last < LLMS_TEXT_ATTEMPT_TTL_MS) return;
        this.#llmsTextAttempts.set(origin, Date.now());
        const llmsUrl = `${origin}/llms.txt`;
        try {
            const fetched = await this.#webFetcher.fetch(llmsUrl, {
                signal: ctx.signal,
                guarded: false,
                acceptHttpErrors: true,
                preserveUnavailable: true,
            });
            if (fetched === null) return;
            // A missing companion (404) or any non-2xx is quiet — no entry.
            if ((fetched.status ?? 200) >= 400) return;
            const materialized = await WebFetcher.materialize(fetched, ctx.projection, ctx.signal);
            if (materialized === null) return;
            await ctx.entries.write("/llms.txt", {
                channels: WebFetcher.materializedChannels(materialized, { url: llmsUrl, method: "GET" }),
            });
        } catch {
            // Quiet by contract: 404, guard rejection, network error, binary.
        }
    }

}
