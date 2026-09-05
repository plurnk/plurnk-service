// One outbound HTTP request from a statement, with its bounded error detail. Split out of Http.
import type { SchemeCtx, SubscriptionHandle, StreamSubscription, ChannelProducerResult, PassthroughResult, SchemeManifest, UrlPath, EntryData, SchemeResult } from "@plurnk/plurnk-schemes";
import { NetworkAddress, Results } from "@plurnk/plurnk-schemes";
import ErrorDetail from "./ErrorDetail.ts";
import WebFetcher, { DEFAULT_WEB_UA, WebMaterializationError } from "./WebFetcher.ts";
import { responseMimetype } from "./ContentType.ts";
import { BODY } from "./http-names.ts";
import LiveAcquisitions from "./LiveAcquisitions.ts";

export default class HttpRequester {
    readonly #manifest: SchemeManifest;
    readonly #errorDetailLimit: number;
    readonly #address: (target: UrlPath) => NetworkAddress | PassthroughResult;
    readonly #requestHeaders: (metadata: readonly string[] | null) => Array<[string, string]> | (PassthroughResult & ChannelProducerResult);
    readonly #bad: (status: number, scheme: string, kind: string, message: string, extensions?: Readonly<Record<string, unknown>>) => PassthroughResult & ChannelProducerResult;
    readonly #seedEntry: () => EntryData;
    readonly #passthrough: (result: SchemeResult) => PassthroughResult & ChannelProducerResult;
    readonly #writeHeader: (subscription: StreamSubscription, method: string, status: number, statusText: string, responseHeaders: ReadonlyArray<readonly [string, string]>, requestHeaders: ReadonlyArray<readonly [string, string]>) => Promise<void>;
    readonly #writeProjectionIdentity: (subscription: StreamSubscription, identity: string) => Promise<void>;
    readonly #cancelled: (url: string, method: string) => PassthroughResult & ChannelProducerResult;
    readonly #materializationFailure: (url: string, method: string, error: WebMaterializationError) => PassthroughResult & ChannelProducerResult;

    readonly #live: LiveAcquisitions;
    constructor({ live, manifest, errorDetailLimit, address, requestHeaders, bad, seedEntry, passthrough, writeHeader, writeProjectionIdentity, cancelled, materializationFailure }: {
        manifest: SchemeManifest;
        errorDetailLimit: number;
        address: (target: UrlPath) => NetworkAddress | PassthroughResult;
        requestHeaders: (metadata: readonly string[] | null) => Array<[string, string]> | (PassthroughResult & ChannelProducerResult);
        bad: (status: number, scheme: string, kind: string, message: string, extensions?: Readonly<Record<string, unknown>>) => PassthroughResult & ChannelProducerResult;
        seedEntry: () => EntryData;
        passthrough: (result: SchemeResult) => PassthroughResult & ChannelProducerResult;
        writeHeader: (subscription: StreamSubscription, method: string, status: number, statusText: string, responseHeaders: ReadonlyArray<readonly [string, string]>, requestHeaders: ReadonlyArray<readonly [string, string]>) => Promise<void>;
        writeProjectionIdentity: (subscription: StreamSubscription, identity: string) => Promise<void>;
        cancelled: (url: string, method: string) => PassthroughResult & ChannelProducerResult;
        materializationFailure: (url: string, method: string, error: WebMaterializationError) => PassthroughResult & ChannelProducerResult;
        live: LiveAcquisitions;
    }) {
        this.#live = live;
        this.#manifest = manifest;
        this.#errorDetailLimit = errorDetailLimit;
        this.#address = address;
        this.#requestHeaders = requestHeaders;
        this.#bad = bad;
        this.#seedEntry = seedEntry;
        this.#passthrough = passthrough;
        this.#writeHeader = writeHeader;
        this.#writeProjectionIdentity = writeProjectionIdentity;
        this.#cancelled = cancelled;
        this.#materializationFailure = materializationFailure;
    }

    // Mutation responses use the same entry/channel and subscription primitives
    // as every live producer; GET acquisition belongs solely to
    // prepareRepresentation.
    async request(
        target: UrlPath,
        metadata: readonly string[] | null,
        ctx: SchemeCtx,
        method: string,
        body: string | undefined,
    ): Promise<PassthroughResult> {
        const address = this.#address(target);
        if (!(address instanceof NetworkAddress)) return address;
        const { url } = address;
        const { pathname } = address;
        const headers = this.#requestHeaders(metadata);
        if (!Array.isArray(headers)) return headers;
        const publishedChannel = target.fragment ?? this.#manifest.defaultChannel;
        if (!Object.hasOwn(this.#manifest.channels, publishedChannel)) {
            const availableChannels = Object.keys(this.#manifest.channels);
            return this.#bad(
                404,
                "http",
                "channel-not-found",
                `Channel #${publishedChannel} does not exist on HTTP responses.`,
                {
                    requestedChannel: publishedChannel,
                    availableChannels,
                    recovery: `Use one of the available channels: ${availableChannels.map((channel) => `#${channel}`).join(", ")}.`,
                    retryable: false,
                },
            );
        }

        // Local AbortController: the subscription handle and a KILL of the address both abort it ({§http-kill}).
        const local = new AbortController();
        const release = this.#live.track(LiveAcquisitions.key(ctx.workerId, url), local);
        const handle: SubscriptionHandle = { cancel: () => local.abort() };

        // {§http-lifecycle} open() binds an existing entry, so the handler seeds
        // its manifest-owned channel shape before subscribing.
        const written = await ctx.entries.write(pathname, this.#seedEntry());
        if (Results.isErrorStatus(written.status)) return this.#passthrough(written);

        // open() returns the worker+teardown-composed signal — fires on loop.cancel
        // OR our local teardown. Wire it so either path aborts acquisition.
        const subscription = await ctx.subscriptions.open(pathname, handle);
        const onAbort = () => local.abort();
        subscription.addEventListener("abort", onAbort, { once: true });
        try {
            const response = await fetch(url, {
                method,
                body,
                headers: headers.some(([k]) => k.toLowerCase() === "user-agent")
                    ? headers
                    : [["User-Agent", DEFAULT_WEB_UA] as [string, string], ...headers],
                signal: local.signal,
                redirect: "follow",
            });

            const responseMime = responseMimetype(response.headers.get("content-type"));

            // {§http-lifecycle}/{§mimetype-classifier} String channels retain
            // textual response data. Binary input is transient: an installed
            // reader may derive Unicode, otherwise the durable body is a typed
            // empty marker rather than a fabricated byte channel.
            await this.#writeHeader(subscription, method, response.status, response.statusText, [...response.headers], headers);
            const bodyMime = responseMime;
            if (response.body === null) {
                await subscription.close({ status: 200 }, `HTTP ${response.status}; empty body`);
                return { shape: "passthrough", status: 102 };
            }
            const responseBody = response.body;
            const byteBody = {
                chunks: responseBody as AsyncIterable<Uint8Array>,
                cancel: () => responseBody.cancel(),
            };
            const binary = await WebFetcher.classifyBinary(byteBody, bodyMime, ctx.projection);
            if (binary) {
                let projected;
                try {
                    projected = await WebFetcher.projectBytes(
                        byteBody,
                        bodyMime,
                        ctx.projection,
                    );
                } catch (error) {
                    await subscription.notifyChunk(BODY, "", bodyMime);
                    throw error;
                }
                if (projected !== null) {
                    await this.#writeProjectionIdentity(subscription, projected.projectionIdentity);
                    await subscription.notifyChunk(BODY, projected.content, projected.mimetype);
                    await subscription.close(
                        { status: 200 },
                        `HTTP ${response.status}; ${projected.content.length} readable chars from ${bodyMime}`,
                    );
                    return { shape: "passthrough", status: 102 };
                }
                await subscription.notifyChunk(BODY, "", bodyMime);
                const detail = `HTTP ${method} ${url} returned ${bodyMime}. The remote response was received, but its binary body cannot be represented in a Plurnk text channel.`;
                const result = this.#bad(
                    415,
                    "http",
                    "binary-response-unsupported",
                    detail,
                    {
                        target: url,
                        method,
                        mimetype: bodyMime,
                        stage: "materialization",
                        recovery: "Do not retry the request solely to retrieve this body; inspect #header or use a byte-capable client.",
                        retryable: false,
                    },
                );
                await subscription.close(result, detail);
                return result;
            }
            // {§http-text-decoding} Fetch text is replacement-mode UTF-8;
            // Content-Type charset remains response evidence, not a second decoder.
            let bytes = 0;
            const decoder = new TextDecoder();
            for await (const chunk of responseBody as AsyncIterable<Uint8Array>) {
                bytes += chunk.length;
                await subscription.notifyChunk(BODY, decoder.decode(chunk, { stream: true }), bodyMime);
            }
            const tail = decoder.decode();
            if (tail.length > 0) await subscription.notifyChunk(BODY, tail, bodyMime);

            await subscription.close({ status: 200 }, `HTTP ${response.status}; ${bytes} bytes`);
            return { shape: "passthrough", status: 102 };
        } catch (err) {
            const aborted = local.signal.aborted;
            if (aborted) {
                const result = this.#cancelled(url, method);
                await subscription.close(result, result.problem?.detail);
                return result;
            }
            if (err instanceof WebMaterializationError) {
                const result = this.#materializationFailure(url, method, err);
                await subscription.close(result, result.problem?.detail);
                return result;
            }
            console.error("HTTP acquisition failed", { method, url, err });
            const cause = ErrorDetail.preview(err, this.#errorDetailLimit);
            const reason = `HTTP ${method} ${url} failed: ${cause}`;
            // The remaining catch owns acquisition failure; cancellation and
            // typed materialization failures settled above.
            const result = this.#bad(
                502,
                "http",
                "fetch-failed",
                reason,
                {
                    target: url,
                    method,
                    stage: "acquisition",
                    retryable: method !== "POST",
                },
            );
            await subscription.close(result, reason);
            return result;
        } finally {
            release();
            subscription.removeEventListener("abort", onAbort);
        }
    }

}
