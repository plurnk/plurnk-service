// One outbound HTTP request from a statement, with its bounded error detail. Split out of Http.
import type { SchemeCtx, SubscriptionHandle, StreamSubscription, ChannelProducerResult, PassthroughResult, SchemeManifest, UrlPath, EntryData, SchemeResult } from "@plurnk/plurnk-schemes";
import { MimetypeClassifier, NetworkAddress, Results } from "@plurnk/plurnk-schemes";
import ErrorDetail from "./ErrorDetail.ts";
import WebFetcher, { webUserAgent, WebMaterializationError } from "./WebFetcher.ts";
import { responseMimetype } from "./ContentType.ts";
import { BODY } from "./http-names.ts";
import LiveAcquisitions from "./LiveAcquisitions.ts";
import HostPolicy from "./HostPolicy.ts";

export default class HttpRequester {
    readonly #manifest: SchemeManifest;
    readonly #errorDetailLimit: number;
    readonly #address: (target: UrlPath) => NetworkAddress | PassthroughResult;
    readonly #requestHeaders: (metadata: readonly string[] | null) => Array<[string, string]> | (PassthroughResult & ChannelProducerResult);
    readonly #bad: (status: number, scheme: string, kind: string, message: string, extensions?: Readonly<Record<string, unknown>>) => PassthroughResult & ChannelProducerResult;
    readonly #seedEntry: () => EntryData;
    readonly #passthrough: (result: SchemeResult) => PassthroughResult & ChannelProducerResult;
    readonly #responseHeader: (method: string, status: number, statusText: string, responseHeaders: ReadonlyArray<readonly [string, string]>, requestHeaders: ReadonlyArray<readonly [string, string]>) => string;
    readonly #writeProjectionIdentity: (subscription: StreamSubscription, identity: string) => Promise<void>;
    readonly #cancelled: (url: string, method: string) => PassthroughResult & ChannelProducerResult;
    readonly #materializationFailure: (url: string, method: string, error: WebMaterializationError) => PassthroughResult & ChannelProducerResult;

    readonly #live: LiveAcquisitions;
    constructor({ live, manifest, errorDetailLimit, address, requestHeaders, bad, seedEntry, passthrough, responseHeader, writeProjectionIdentity, cancelled, materializationFailure }: {
        manifest: SchemeManifest;
        errorDetailLimit: number;
        address: (target: UrlPath) => NetworkAddress | PassthroughResult;
        requestHeaders: (metadata: readonly string[] | null) => Array<[string, string]> | (PassthroughResult & ChannelProducerResult);
        bad: (status: number, scheme: string, kind: string, message: string, extensions?: Readonly<Record<string, unknown>>) => PassthroughResult & ChannelProducerResult;
        seedEntry: () => EntryData;
        passthrough: (result: SchemeResult) => PassthroughResult & ChannelProducerResult;
        responseHeader: (method: string, status: number, statusText: string, responseHeaders: ReadonlyArray<readonly [string, string]>, requestHeaders: ReadonlyArray<readonly [string, string]>) => string;
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
        this.#responseHeader = responseHeader;
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
        const release = this.#live.track(LiveAcquisitions.key(ctx.workspaceId, url), local);
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
        let pendingJson: { content: string; mimetype: string } | undefined;
        try {
            const response = await fetch(url, {
                method,
                body,
                headers: headers.some(([k]) => k.toLowerCase() === "user-agent")
                    ? headers
                    : [["User-Agent", webUserAgent()] as [string, string], ...headers],
                signal: local.signal,
                redirect: "follow",
            });
            // {§http-host-policy} — a followed redirect may not leave the operator's hosts.
            if (response.url !== "" && !HostPolicy.permits(response.url)) {
                await response.body?.cancel();
                return this.#bad(403, "http", "host-not-permitted", `${new URL(response.url).hostname} is outside the operator's web host policy.`, {
                    target: url,
                    stage: "acquisition",
                    retryable: false,
                });
            }

            const responseMime = responseMimetype(response.headers.get("content-type"));

            // {§http-binary-source} — completed binary input uses ordinary entry byte storage;
            // text responses retain their incremental subscription path.
            const header = this.#responseHeader(method, response.status, response.statusText, [...response.headers], headers);
            await subscription.notifyChunk("header", header, "text/plain");
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
                const stored = await ctx.entries.write(pathname, { channels: {
                    body: { content: "", bytes: projected.bytes, mimetype: bodyMime, state: "active" },
                    header: { content: header, mimetype: "text/plain", state: "active" },
                    ...(projected.readable === null ? {} : { readable: {
                        content: projected.readable.content, mimetype: projected.readable.mimetype, state: "active" as const,
                    } }),
                } });
                if (Results.isErrorStatus(stored.status)) {
                    const result = this.#passthrough(stored);
                    await subscription.close(result, result.problem?.detail);
                    return result;
                }
                await this.#writeProjectionIdentity(subscription, projected.projectionIdentity);
                await subscription.close({ status: 200 }, `HTTP ${response.status}; ${projected.bytes.byteLength} bytes`);
                return { shape: "passthrough", status: 102 };
            }
            // {§http-text-decoding} Fetch text is replacement-mode UTF-8;
            // Content-Type charset remains response evidence, not a second decoder.
            let bytes = 0;
            const decoder = new TextDecoder();
            if (MimetypeClassifier.isJson(bodyMime)) pendingJson = { content: "", mimetype: bodyMime };
            for await (const chunk of responseBody as AsyncIterable<Uint8Array>) {
                bytes += chunk.length;
                const text = decoder.decode(chunk, { stream: true });
                if (pendingJson !== undefined) pendingJson.content += text;
                else await subscription.notifyChunk(BODY, text, bodyMime);
            }
            const tail = decoder.decode();
            if (pendingJson !== undefined) {
                const content = WebFetcher.readableText(pendingJson.content + tail, bodyMime);
                pendingJson = undefined;
                await subscription.notifyChunk(BODY, content, bodyMime);
            } else if (tail.length > 0) await subscription.notifyChunk(BODY, tail, bodyMime);

            await subscription.close({ status: 200 }, `HTTP ${response.status}; ${bytes} bytes`);
            return { shape: "passthrough", status: 102 };
        } catch (err) {
            if (pendingJson !== undefined && pendingJson.content.length > 0) {
                await subscription.notifyChunk(BODY, pendingJson.content, pendingJson.mimetype);
            }
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
