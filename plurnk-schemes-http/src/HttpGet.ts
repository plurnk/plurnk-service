// The GET path of the http scheme: the fetch, event-stream opening, and the llms.txt piggyback. Split out of Http.
import type {
    EntryData,
    PassthroughResult,
    RepresentationPreparationResult,
    SchemeCtx,
    StoredEntryData,
    SubscriptionHandle,
    UrlPath,
} from "@plurnk/plurnk-schemes";
import { NetworkAddress, Results } from "@plurnk/plurnk-schemes";
import {
    fresh,
    materializerIdentity,
    refreshAfter304,
    requestMethod,
    reusableGetRepresentation,
    revalidationCorresponds,
    sourceMimetype,
    validators,
} from "./HttpCache.ts";
import {
    BODY,
    HEADER,
    LiveAcquisitions,
    httpAddress,
    httpBad,
    httpCancelled,
    httpMaterializationFailure,
    httpPassthrough,
    parseRequestHeaders,
    requireFlagEnv,
    seedEntry,
    settleEventStream,
} from "./HttpShared.ts";
import WebFetcher, { WebMaterializationError, type WebFetchResult } from "./WebFetcher.ts";

const LLMS_TEXT_ATTEMPT_TTL_MS = 3_600_000;

export default class HttpGet {
    readonly #webFetcher: WebFetcher;
    readonly #llmsTextAttempts = new Map<string, number>();
    readonly #live: LiveAcquisitions;

    constructor({ live, webFetcher }: {
        live: LiveAcquisitions;
        webFetcher: WebFetcher;
    }) {
        this.#live = live;
        this.#webFetcher = webFetcher;
    }

    async prepareGet(
        target: UrlPath,
        metadata: readonly string[] | null,
        pathname: string,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult> {
        const address = httpAddress(target);
        if (!(address instanceof NetworkAddress)) return address;
        const { url } = address;
        const requestHeaders = parseRequestHeaders(metadata);
        if (!Array.isArray(requestHeaders)) return requestHeaders;
        let cached: StoredEntryData | undefined;
        const conditional: Array<[string, string]> = [];
        const prior = await ctx.entries.read(pathname);
        if (Results.isErrorStatus(prior.status) && prior.status !== 404) {
            return httpPassthrough(prior);
        }
        const priorBody = prior.entry?.channels[BODY];
        const priorHeader = prior.entry?.channels[HEADER];
        if (prior.entry !== null && requestMethod(priorHeader?.content ?? "") === undefined) {
            return { status: 200 };
        }
        if (prior.entry !== null && priorBody !== undefined && priorHeader !== undefined) {
            try {
                if (await reusableGetRepresentation(prior.entry, requestHeaders, ctx.projection)) {
                    cached = prior.entry;
                    if (materializerIdentity(priorHeader.content) === undefined) {
                        conditional.push(...validators(priorHeader.content));
                    }
                }
            } catch (cause) {
                return httpMaterializationFailure(
                    url,
                    "GET",
                    new WebMaterializationError(sourceMimetype(priorHeader.content), cause),
                );
            }
        }
        if (cached !== undefined && fresh(cached.channels[HEADER].content)) {
            return { status: 200 };
        }

        // {§revalidation} — a KILL of the address aborts this acquisition through the tracked controller.
        const liveKey = LiveAcquisitions.key(ctx.workspaceId, url);
        const local = new AbortController();
        const release = this.#live.track(liveKey, local);
        const signal = LiveAcquisitions.composed(ctx.signal, local.signal);
        try {
            let fetched = await this.#webFetcher.fetch(url, {
                signal,
                headers: requestHeaders,
                ...(conditional.length > 0
                    ? { conditionalHeaders: conditional }
                    : {}),
                guarded: false,
                acceptHttpErrors: true,
                preserveUnavailable: true,
            });
            if (fetched === null) {
                return httpBad(
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
                    return httpBad(
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
                const cachedHeader = cached.channels[HEADER].content;
                if (materializerIdentity(cachedHeader) !== undefined) {
                    return httpBad(
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
                if (revalidationCorresponds(
                    cachedHeader,
                    new Headers(responseHeaders.map(([name, value]) => [name, value])),
                )) {
                    const channels: EntryData["channels"] = {
                        ...cached.channels,
                        [HEADER]: {
                            ...cached.channels[HEADER],
                            content: refreshAfter304(cachedHeader, responseHeaders, requestHeaders),
                        },
                    };
                    const written = await ctx.entries.write(pathname, {
                        channels,
                    });
                    if (Results.isErrorStatus(written.status)) return httpPassthrough(written);
                    return { status: 200 };
                }
                // {§revalidation}: reacquire once without conditionals when
                // the 304 cannot identify the stored response.
                fetched = await this.#webFetcher.fetch(url, {
                    signal,
                    headers: requestHeaders,
                    guarded: false,
                    acceptHttpErrors: true,
                    preserveUnavailable: true,
                });
                if (fetched === null) {
                    return httpBad(
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
                    return httpBad(
                        502,
                        "http",
                        "fetch-failed",
                        `HTTP GET ${url} returned 304 again after retrying without conditional headers.`,
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

            const materialized = await WebFetcher.materialize(fetched, ctx.projection, signal);
            const written = await ctx.entries.write(pathname, {
                channels: WebFetcher.materializedChannels(materialized, { url, method: "GET" }),
            });
            if (Results.isErrorStatus(written.status)) return httpPassthrough(written);
            await this.#piggybackLlmsText(address, ctx);
            return { status: 200 };
        } catch (error) {
            const cause = error instanceof WebMaterializationError ? error.cause : error;
            if (signal.aborted && cause === signal.reason) return httpCancelled(url, "GET");
            if (error instanceof WebMaterializationError) {
                return httpMaterializationFailure(url, "GET", error);
            }
            throw error;
        } finally {
            release();
        }
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
        // {§revalidation} — the open stream stays cancellable by a KILL of its address until it settles.
        const releaseStream = this.#live.track(LiveAcquisitions.key(ctx.workspaceId, address.url), local);
        const written = await ctx.entries.write(address.pathname, seedEntry());
        if (Results.isErrorStatus(written.status)) return httpPassthrough(written);
        const subscription = await ctx.subscriptions.open(address.pathname, handle);
        if (fetched.header !== undefined) {
            await subscription.notifyChunk(HEADER, fetched.header, "text/plain");
        }
        void settleEventStream(subscription, response, {
            url: address.url,
            method: "GET",
            signal: local.signal,
        }).catch((error: unknown) => {
            console.error("HTTP SSE terminal cleanup failed", { url: address.url, error });
        }).finally(() => releaseStream());
        return { shape: "passthrough", status: 102 };
    }

    // {§http-lifecycle} — after a successful generic GET materialization,
    // acquire <origin>/llms.txt once per TTL window and materialize it as its
    // own https entry. Any failure is quiet: the companion never fails the
    // READ that piggybacked it, and the companion itself never recurses.
    async #piggybackLlmsText(address: NetworkAddress, ctx: SchemeCtx): Promise<void> {
        // An outbound request nobody asked for is the operator's to allow.
        if (!requireFlagEnv("PLURNK_SCHEMES_HTTP_LLMS_TXT")) return;
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
            if ((fetched.status ?? 200) >= 400 || await ctx.projection.isBinary(fetched.mimetype)) {
                if (typeof fetched.body !== "string") await fetched.body.cancel();
                return;
            }
            const materialized = await WebFetcher.materialize(fetched, ctx.projection, ctx.signal);
            await ctx.entries.write("/llms.txt", {
                channels: WebFetcher.materializedChannels(materialized, { url: llmsUrl, method: "GET" }),
            });
        } catch {
            // Quiet by contract: 404, guard rejection, network error, binary.
        }
    }
}
