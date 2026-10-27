// One outbound HTTP request from a statement, with its bounded error detail. Split out of Http.
import type {
    PassthroughResult,
    SchemeCtx,
    SchemeManifest,
    SubscriptionHandle,
    UrlPath,
} from "@plurnk/plurnk-schemes";
import { MimetypeClassifier, NetworkAddress, Results } from "@plurnk/plurnk-schemes";
import { outboundFetch } from "@plurnk/plurnk-meta";
import { HostPolicy } from "./Guard.ts";
import {
    BODY,
    LiveAcquisitions,
    errorDetail,
    httpAddress,
    httpBad,
    httpCancelled,
    httpMaterializationFailure,
    httpPassthrough,
    parseRequestHeaders,
    responseHeader,
    responseMimetype,
    seedEntry,
    webUserAgent,
    writeProjectionIdentity,
} from "./HttpShared.ts";
import WebFetcher, { WebMaterializationError } from "./WebFetcher.ts";

export default class HttpRequester {
    readonly #manifest: SchemeManifest;
    readonly #live: LiveAcquisitions;

    constructor({ live, manifest }: {
        live: LiveAcquisitions;
        manifest: SchemeManifest;
    }) {
        this.#live = live;
        this.#manifest = manifest;
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
        const address = httpAddress(target);
        if (!(address instanceof NetworkAddress)) return address;
        const { url } = address;
        const { pathname } = address;
        const headers = parseRequestHeaders(metadata);
        if (!Array.isArray(headers)) return headers;
        const publishedChannel = target.fragment ?? this.#manifest.defaultChannel;
        if (!Object.hasOwn(this.#manifest.channels, publishedChannel)) {
            const availableChannels = Object.keys(this.#manifest.channels);
            return httpBad(
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

        // Local AbortController: the subscription handle and a KILL of the address both abort it ({§revalidation}).
        const local = new AbortController();
        const release = this.#live.track(LiveAcquisitions.key(ctx.workspaceId, url), local);
        const handle: SubscriptionHandle = { cancel: () => local.abort() };

        // {§http-lifecycle} open() binds an existing entry, so the handler seeds
        // its manifest-owned channel shape before subscribing.
        const written = await ctx.entries.write(pathname, seedEntry());
        if (Results.isErrorStatus(written.status)) return httpPassthrough(written);

        // open() returns the session+teardown-composed signal — fires on loop.cancel
        // OR our local teardown. Wire it so either path aborts acquisition.
        const subscription = await ctx.subscriptions.open(pathname, handle);
        const onAbort = () => local.abort();
        subscription.addEventListener("abort", onAbort, { once: true });
        let pendingJson: { content: string; mimetype: string } | undefined;
        try {
            const response = await outboundFetch(url, {
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
                return httpBad(403, "http", "host-not-permitted", `${new URL(response.url).hostname} is outside the operator's web host policy.`, {
                    target: url,
                    stage: "acquisition",
                    retryable: false,
                });
            }

            const responseMime = responseMimetype(response.headers.get("content-type"));

            // {§http-lifecycle} — completed binary input uses ordinary entry byte storage;
            // text responses retain their incremental subscription path.
            const header = responseHeader(method, response.status, response.statusText, [...response.headers], headers);
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
                const stored = await ctx.entries.write(pathname, {
                    channels: {
                        body: { content: "", bytes: projected.bytes, mimetype: bodyMime, state: "active" },
                        header: { content: header, mimetype: "text/plain", state: "active" },
                        ...(projected.readable === null ? {} : {
                            readable: {
                                content: projected.readable.content, mimetype: projected.readable.mimetype, state: "active" as const,
                            },
                        }),
                    },
                });
                if (Results.isErrorStatus(stored.status)) {
                    const result = httpPassthrough(stored);
                    await subscription.close(result, result.problem?.detail);
                    return result;
                }
                await writeProjectionIdentity(subscription, projected.projectionIdentity);
                await subscription.close({ status: 200 }, `HTTP ${response.status}; ${projected.bytes.byteLength} bytes`);
                return { shape: "passthrough", status: 102 };
            }
            // {§http-lifecycle} Fetch text is replacement-mode UTF-8;
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
                const result = httpCancelled(url, method);
                await subscription.close(result, result.problem?.detail);
                return result;
            }
            if (err instanceof WebMaterializationError) {
                const result = httpMaterializationFailure(url, method, err);
                await subscription.close(result, result.problem?.detail);
                return result;
            }
            console.error("HTTP acquisition failed", { method, url, err });
            const cause = errorDetail.preview(err);
            const reason = `HTTP ${method} ${url} failed: ${cause}`;
            const result = httpBad(
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
