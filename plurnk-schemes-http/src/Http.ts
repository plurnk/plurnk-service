// HTTP(S) handler. Operation-to-method semantics live in {§op-surface};
// acquisition, materialization, publication, and query flow live in
// {§http-lifecycle}. The implementation depends only on SchemeCtx capabilities.

import { createParser, type ParseError } from "eventsource-parser";
import type {
    SchemeCtx,
    SubscriptionHandle,
    StreamSubscription,
    PassthroughResult,
    SchemeManifest,
    SchemeHandler,
    ReadStatement,
    SendStatement,
    EditStatement,
    KillStatement,
    UrlPath,
    EntryData,
    StoredEntryData,
    FindStatement,
    SchemeResult,
    ProjectionCaps,
} from "@plurnk/plurnk-schemes";
import {
    MimetypeClassifier,
    NetworkAddress,
    PathSyntax,
    ProjectionInputLimitError,
    Results,
} from "@plurnk/plurnk-schemes";
import { readFile } from "node:fs/promises";
import Browser, { BROWSER_UA, requireNumEnv, type RenderResult } from "./Browser.ts";
import ErrorDetail from "./ErrorDetail.ts";
import WebFetcher, {
    CACHE_VARIANT_HEADER,
    PROJECTION_ID_HEADER,
    cacheVariantEvidence,
    classifyCacheVariant,
    rewriteAcquisitionTarget,
    WebMaterializationError,
    type CacheVariant,
    type WebFetchResult,
    type WebMaterializedResult,
} from "./WebFetcher.ts";
import { responseMimetype } from "./ContentType.ts";

// The channel the response body streams into, and the header metadata channel.
const BODY = "body";
const HEADER = "header";
// Package-owned metadata appended after untrusted origin headers. Readers take
// the last value so an origin using the same field name cannot override it.
const FETCHED_AT = "x-plurnk-fetched-at";
const REQUEST_METHOD = "x-plurnk-request-method";

const lastHeaderValue = (header: string, name: string): string | undefined => {
    const lines = header.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]!;
        const colon = line.indexOf(":");
        if (colon < 0 || line.slice(0, colon).trim().toLowerCase() !== name) continue;
        return line.slice(colon + 1).trim();
    }
    return undefined;
};

const replaceLastHeaderValue = (header: string, name: string, value: string): string => {
    const lines = header === "" ? [] : header.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]!;
        const colon = line.indexOf(":");
        if (colon < 0 || line.slice(0, colon).trim().toLowerCase() !== name) continue;
        lines[index] = `${name}: ${value}`;
        return lines.join("\n");
    }
    return [...lines, `${name}: ${value}`].join("\n");
};

// The package-shipped model teaching is loaded verbatim and fails hard if absent.
// The relative path is identical from src/ during development and dist/ after build.
const documentation = await readFile(new URL("../docs/http.md", import.meta.url), "utf-8");

// What Http needs from the render foundation — narrow, so tests inject a fake.
interface Renderer {
    ready?(): Promise<string>;
    render(url: string, opts: { workerId: number; signal?: AbortSignal; headers?: ReadonlyArray<readonly [string, string]> }): Promise<RenderResult>;
    close?(): Promise<void>;
}

export default class Http implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "http",
        // Channel mimetypes here are SEED DEFAULTS (pre-fetch placeholders).
        // body is retyped per-call via notifyChunk's mimetype arg — to the real
        // response Content-Type or the configured readable projection type;
        // octet-stream is the honest "unknown until fetched". header is always the status
        // line + headers (text/plain).
        channels: { [BODY]: "application/octet-stream", [HEADER]: "text/plain", html: "text/html" },
        defaultChannel: BODY,
        category: "data",
        writableBy: ["model", "client"],
        volatile: true,        // remote content can change between fetches
        modelVisible: true,
        example: "<<READ(https://example.com/page)::READ",
        documentation,
        flags: {
            requiresWeb: true, // excluded under the loop's noWeb flag
        },
    };

    // The render foundation (lazy chromium). Injectable for tests; one warm
    // pool per Http instance, shared across this scheme's fetches.
    readonly #browser: Renderer;
    readonly #errorDetailLimit: number;
    readonly #webFetcher: WebFetcher;
    constructor(browser: Renderer = new Browser()) {
        this.#browser = browser;
        this.#errorDetailLimit = ErrorDetail.configuredLimit();
        this.#webFetcher = new WebFetcher(browser);
    }

    async ready(): Promise<void> {
        const mode = await this.#browser.ready?.();
        if (mode !== undefined) console.info(`http renderer: ${mode}`);
    }

    async close(): Promise<void> {
        await this.#webFetcher.close();
    }

    // FIND itself is the consumer's standard entry query. This hook owns only
    // HTTP's prerequisite: an exact URL that is not already an entry must be
    // acquired through the same checked byte and lazy-render path used by search
    // prefetch. Glob targets only query already-known web entries.
    async prepareFind(statement: FindStatement, ctx: SchemeCtx): Promise<PassthroughResult> {
        const target = statement.target;
        if (target === null || target.kind !== "url") return { shape: "passthrough", status: 200 };
        const address = Http.#address(target);
        if (!(address instanceof NetworkAddress)) return address;
        const { pathname, url } = address;
        const requestHeaders = target.headers ?? [];
        if (PathSyntax.hasGlob(target.pathname)) return { shape: "passthrough", status: 200 };
        const prior = await ctx.entries.read(pathname);
        if (prior.entry !== null) {
            const priorHeader = prior.entry.channels[HEADER]?.content ?? "";
            const priorMethod = Http.#requestMethod(priorHeader);
            if (priorMethod === undefined) {
                return { shape: "passthrough", status: 200 };
            }
            try {
                if (await Http.#reusableGetRepresentation(prior.entry, requestHeaders, ctx.projection)) {
                    return { shape: "passthrough", status: 200 };
                }
            } catch (cause) {
                return Http.#materializationFailure(
                    url,
                    "GET",
                    new WebMaterializationError(
                        "projection",
                        Http.#sourceMimetype(priorHeader),
                        cause,
                    ),
                );
            }
        }
        if (Results.isErrorStatus(prior.status) && prior.status !== 404) {
            return Http.#passthrough(prior);
        }
        // {§prefetch} WebFetcher preserves caller cancellation as rejection;
        // this operation owns its one model-facing 499 projection.
        let fetched: WebFetchResult | null;
        try {
            fetched = await this.#webFetcher.fetch(url, {
                signal: ctx.signal,
                headers: requestHeaders,
            });
        } catch (err) {
            if (ctx.signal?.aborted === true && err === ctx.signal.reason) {
                return Http.#cancelled(url, "GET");
            }
            throw err;
        }
        if (fetched === null) {
            return Http.#bad(
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
        let materialized: WebMaterializedResult | null;
        try {
            materialized = await WebFetcher.materialize(fetched, ctx.projection);
        } catch (err) {
            if (ctx.signal?.aborted === true) return Http.#cancelled(url, "GET");
            if (err instanceof WebMaterializationError) {
                return Http.#materializationFailure(url, "GET", err);
            }
            throw err;
        }
        if (materialized === null) return Http.#noReadableProjection(url);
        const channels: EntryData["channels"] = {
            [BODY]: materialized.body,
            ...(materialized.html === undefined ? {} : { html: materialized.html }),
            ...(materialized.header === undefined
                ? {}
                : { [HEADER]: { content: materialized.header, mimetype: "text/plain" } }),
        };
        const written = await ctx.entries.write(pathname, { channels, tags: [] });
        return Http.#passthrough(written);
    }

    // An unscoped READ fetches/revalidates. A scoped READ observes its selected
    // already-materialized channel through universal READ: refetching would
    // discard the requested range and return another asynchronous whole-body 102.
    async read(statement: ReadStatement, ctx: SchemeCtx): Promise<PassthroughResult> {
        if (statement.target === null || statement.target.kind !== "url") {
            return Http.#bad(400, "http", "bad-target", "READ requires an http(s):// URL target.", {
                stage: "target-validation",
                recovery: "Provide an http(s):// URL target.",
                retryable: false,
            });
        }
        if (statement.lineMarker !== null) {
            const address = Http.#address(statement.target);
            if (!(address instanceof NetworkAddress)) return address;
            return Http.#passthrough(await ctx.entries.operations.read(statement));
        }
        return this.#fetchStream(statement.target, ctx, "GET", undefined);
    }

    // EDIT -> PUT the body (full-resource replace). `<L>` has no meaning against a
    // remote resource - reject rather than silently ignore the model's intent.
    async editBatch(statements: readonly EditStatement[], ctx: SchemeCtx): Promise<PassthroughResult> {
        if (statements.length !== 1) {
            return Http.#bad(
                409,
                "http",
                "non-atomic-edit-batch",
                `${statements.length} EDIT statements cannot be committed atomically to one remote resource.`,
                {
                    statements: statements.length,
                    stage: "mutation",
                    recovery: "Submit one whole-resource EDIT.",
                    retryable: false,
                },
            );
        }
        const statement = statements[0];
        if (statement.target === null || statement.target.kind !== "url") {
            return Http.#bad(400, "http", "bad-target", "EDIT requires an http(s):// URL target.", {
                stage: "target-validation",
                recovery: "Provide an http(s):// URL target.",
                retryable: false,
            });
        }
        if (statement.lineMarker !== null) {
            return Http.#bad(
                400,
                "http",
                "line-edit-unsupported",
                "HTTP EDIT replaces the whole remote resource and does not accept a line range.",
                {
                    stage: "mutation",
                    recovery: "Remove the line range and submit the complete replacement body.",
                    retryable: false,
                },
            );
        }
        return this.#fetchStream(statement.target, ctx, "PUT", statement.body ?? "");
    }

    async edit(statement: EditStatement, ctx: SchemeCtx): Promise<PassthroughResult> {
        return this.editBatch([statement], ctx);
    }

    // KILL -> DELETE the resource. Distinct from SEND[410] (which drops the local
    // cached entry): KILL is an HTTP DELETE request to the remote.
    async kill(statement: KillStatement, ctx: SchemeCtx): Promise<PassthroughResult> {
        if (statement.target === null || statement.target.kind !== "url") {
            return Http.#bad(400, "http", "bad-target", "KILL requires an http(s):// URL target.", {
                stage: "target-validation",
                recovery: "Provide an http(s):// URL target.",
                retryable: false,
            });
        }
        return this.#fetchStream(statement.target, ctx, "DELETE", statement.body ?? undefined);
    }

    // SEND dispatch — status-code-as-verb (SPEC {§op-surface}).
    //   200 -> request with body (POST), stream response
    //   410 -> delete the cached entry
    //   499 -> cancel in-flight (handled by the subscription's force-cancel;
    //         the engine routes 499 to the registered SubscriptionHandle, so a
    //         scheme-level no-op here is correct — teardown already happened)
    async send(statement: SendStatement, ctx: SchemeCtx): Promise<PassthroughResult> {
        if (statement.target === null || statement.target.kind !== "url") {
            return Http.#bad(400, "http", "bad-target", "SEND requires an http(s):// URL target.", {
                stage: "target-validation",
                recovery: "Provide an http(s):// URL target.",
                retryable: false,
            });
        }
        const status = statement.signal;
        if (status === 200) {
            const body = statement.body?.raw ?? "";
            return this.#fetchStream(statement.target, ctx, "POST", body);
        }
        if (status === 410) {
            const address = Http.#address(statement.target);
            if (!(address instanceof NetworkAddress)) return address;
            return Http.#passthrough(await ctx.entries.delete(address.pathname));
        }
        if (status === 499) {
            // Cancellation is routed by the engine to the subscription's
            // SubscriptionHandle.cancel (registered in #fetchStream). Nothing
            // for the scheme to do at the op level.
            return { shape: "passthrough", status: 200 };
        }
        // Entry-bearing schemes return 501 for status codes they don't interpret.
        return Http.#bad(
            501,
            "http",
            "send-status-unsupported",
            `The HTTP scheme does not interpret SEND status ${status}.`,
            {
                requestedStatus: status,
                stage: "dispatch",
                retryable: false,
            },
        );
    }

    // {§http-lifecycle} One direct-operation path owns seeding,
    // subscription cancellation, response materialization, and settlement.
    async #fetchStream(target: UrlPath, ctx: SchemeCtx, method: string, body: string | undefined): Promise<PassthroughResult> {
        const address = Http.#address(target);
        if (!(address instanceof NetworkAddress)) return address;
        const url = method === "GET" ? rewriteAcquisitionTarget(address.url) : address.url;
        const { pathname } = address;
        const headers = target.headers ?? [];
        const publishedChannel = target.fragment ?? Http.manifest.defaultChannel;
        if (!(publishedChannel in Http.manifest.channels)) {
            const availableChannels = Object.keys(Http.manifest.channels);
            return Http.#bad(
                400,
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

        // {§revalidation} — recover only a GET-marked representation and its
        // validators before the seed write replaces the stored channels.
        let cached: { header: string; body: { content: string; mimetype: string }; html?: { content: string; mimetype: string } } | undefined;
        const conditional: Array<[string, string]> = [];
        if (method === "GET") {
            const prior = await ctx.entries.read(pathname);
            if (Results.isErrorStatus(prior.status) && prior.status !== 404) {
                return Http.#passthrough(prior);
            }
            const pb = prior.entry?.channels[BODY];
            const ph = prior.entry?.channels[HEADER];
            if (prior.entry !== null && pb !== undefined && ph !== undefined) {
                try {
                    if (await Http.#reusableGetRepresentation(prior.entry, headers, ctx.projection)) {
                        const html = prior.entry.channels.html;
                        cached = {
                            header: ph.content,
                            body: { content: pb.content, mimetype: pb.mimetype },
                            ...(html === undefined || html.content.length === 0 ? {} : { html: { content: html.content, mimetype: html.mimetype } }),
                        };
                        conditional.push(...Http.#validators(ph.content));
                    }
                } catch (cause) {
                    return Http.#materializationFailure(
                        url,
                        method,
                        new WebMaterializationError(
                            "projection",
                            Http.#sourceMimetype(ph.content),
                            cause,
                        ),
                    );
                }
            }
        }

        // {§revalidation} TTL fast path. Serving does not refresh the stamp;
        // only a network acquisition or 304 vouches for a new acquisition time.
        if (cached !== undefined && Http.#storedCopyServable(Http.#fetchedAt(cached.header), null)) {
            const written = await ctx.entries.write(pathname, Http.#seedEntry());
            if (Results.isErrorStatus(written.status)) return Http.#passthrough(written);
            const subscription = await ctx.subscriptions.open(pathname, { cancel: () => {} }, { publishedChannel });
            await subscription.notifyChunk(HEADER, cached.header, "text/plain");
            if (cached.html !== undefined) await subscription.notifyChunk("html", cached.html.content, cached.html.mimetype);
            await subscription.notifyChunk(BODY, cached.body.content, cached.body.mimetype);
            await subscription.close({ status: 200 }, `ttl-fresh; ${cached.body.content.length} chars from cache`);
            return { shape: "passthrough", status: 102 };
        }

        // Local AbortController for force-cancel from outside (SEND[499]).
        const local = new AbortController();
        const handle: SubscriptionHandle = { cancel: () => local.abort() };

        // {§http-lifecycle} open() binds an existing entry, so the handler seeds
        // its manifest-owned channel shape before subscribing.
        const written = await ctx.entries.write(pathname, Http.#seedEntry());
        if (Results.isErrorStatus(written.status)) return Http.#passthrough(written);

        // open() returns the worker+teardown-composed signal — fires on loop.cancel
        // OR our local teardown. Wire it so either path aborts the fetch/render.
        const subscription = await ctx.subscriptions.open(pathname, handle, { publishedChannel });
        const onAbort = () => local.abort();
        subscription.addEventListener("abort", onAbort, { once: true });
        let detached = false;

        try {
            const response = await fetch(url, {
                method,
                body,
                // One browser identity on the wire (never Node's default "node"
                // UA — a loud automated-client fingerprint). The model's own
                // {User-Agent: …} block wins when present.
                headers: headers.some(([k]) => k.toLowerCase() === "user-agent")
                    ? [...headers, ...conditional]
                    : [["User-Agent", BROWSER_UA] as [string, string], ...headers, ...conditional],
                signal: local.signal,
                redirect: "follow",
            });

            // {§revalidation} A 304 restores the GET representation into the
            // freshly seeded channels and remains an ordinary streaming READ.
            if (cached !== undefined && Http.#storedCopyServable(Http.#fetchedAt(cached.header), response)) {
                await subscription.notifyChunk(
                    HEADER,
                    Http.#stamp(
                        cached.header,
                        classifyCacheVariant(headers, [...response.headers]),
                    ),
                    "text/plain",
                );
                if (cached.html !== undefined) await subscription.notifyChunk("html", cached.html.content, cached.html.mimetype);
                await subscription.notifyChunk(BODY, cached.body.content, cached.body.mimetype);
                await subscription.close({ status: 200 }, `revalidated 304; ${cached.body.content.length} chars from cache`);
                return { shape: "passthrough", status: 102 };
            }

            const responseMime = responseMimetype(response.headers.get("content-type"));

            // Always-render: a GET of an HTML page is re-acquired through the
            // browser so the body is projected from the final rendered DOM. The probe-fetch
            // body is discarded — the browser does its own navigation. Only GET
            // renders; POST/PUT/DELETE can't be replayed as a browser navigation.
            const isHtml = method === "GET" && MimetypeClassifier.isHtml(responseMime);
            if (isHtml) {
                await response.body?.cancel();
                let result: RenderResult;
                try {
                    result = await this.#browser.render(url, {
                        workerId: ctx.workerId,
                        signal: local.signal,
                        headers,
                    });
                } catch (cause) {
                    throw new WebMaterializationError("render", responseMime, cause);
                }
                await Http.#writeHeader(subscription, method, result.status, result.statusText, result.headers, headers);
                await subscription.notifyChunk("html", result.html, "text/html");
                const materialized = await WebFetcher.materialize(
                    { body: result.html, mimetype: "text/html" },
                    ctx.projection,
                );
                if (materialized === null) {
                    const failure = Http.#noReadableProjection(url);
                    await subscription.close(failure, failure.problem?.detail);
                    return failure;
                }
                if (materialized.projection !== undefined) {
                    await Http.#writeProjectionIdentity(subscription, materialized.projection.identity);
                }
                await subscription.notifyChunk(BODY, materialized.body.content, materialized.body.mimetype);
                await subscription.close({ status: 200 }, `rendered HTTP ${result.status}; ${materialized.body.content.length} readable chars`);
                return { shape: "passthrough", status: 102 };
            }

            // SSE: an event stream is parsed into its `data` payloads (SPEC {§sse}),
            // one notifyChunk per event with the `data:`/comment framing stripped,
            // so the model reads event content and not the transport. A long-lived
            // GET; events land in the body channel as they arrive across turns,
            // until the origin closes. Only GET — a POST reply is never an SSE READ.
            if (method === "GET" && responseMime === "text/event-stream") {
                await Http.#writeHeader(subscription, method, response.status, response.statusText, [...response.headers], headers);
                if (response.body === null) {
                    await subscription.close({ status: 200 }, "SSE stream; empty body");
                    return { shape: "passthrough", status: 102 };
                }
                detached = true;
                void Http.#settleEventStream(subscription, response, {
                    url,
                    method,
                    signal: local.signal,
                    errorDetailLimit: this.#errorDetailLimit,
                }).catch((error: unknown) => {
                    console.error("HTTP SSE terminal cleanup failed", { url, error });
                }).finally(() => subscription.removeEventListener("abort", onAbort));
                return { shape: "passthrough", status: 102 };
            }

            // {§http-lifecycle}/{§mimetype-classifier} String channels retain
            // textual response data. Binary input is transient: an installed
            // reader may derive Unicode, otherwise the durable body is a typed
            // empty marker rather than a fabricated byte channel.
            await Http.#writeHeader(subscription, method, response.status, response.statusText, [...response.headers], headers);
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
                    await Http.#writeProjectionIdentity(subscription, projected.projectionIdentity);
                    await subscription.notifyChunk(BODY, projected.content, projected.mimetype);
                    await subscription.close(
                        { status: 200 },
                        `HTTP ${response.status}; ${projected.content.length} readable chars from ${bodyMime}`,
                    );
                    return { shape: "passthrough", status: 102 };
                }
                await subscription.notifyChunk(BODY, "", bodyMime);
                const detail = `HTTP ${method} ${url} returned ${bodyMime}. The remote response was received, but its binary body cannot be represented in a Plurnk text channel.`;
                const result = Http.#bad(
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
                const result = Http.#cancelled(url, method);
                await subscription.close(result, result.problem?.detail);
                return result;
            }
            if (err instanceof WebMaterializationError) {
                const result = Http.#materializationFailure(url, method, err);
                await subscription.close(result, result.problem?.detail);
                return result;
            }
            console.error("HTTP acquisition failed", { method, url, err });
            const cause = ErrorDetail.preview(err, this.#errorDetailLimit);
            const reason = `HTTP ${method} ${url} failed: ${cause}`;
            // The remaining catch owns acquisition failure; cancellation and
            // typed materialization failures settled above.
            const result = Http.#bad(
                502,
                "http",
                "fetch-failed",
                reason,
                {
                    target: url,
                    method,
                    stage: "acquisition",
                    retryable: true,
                },
            );
            await subscription.close(result, reason);
            return result;
        } finally {
            if (!detached) subscription.removeEventListener("abort", onAbort);
        }
    }

    // {§http-manifest}/{§http-lifecycle} Seed the declared channel shape before
    // open(); notifyChunk later welds acquired content to its actual mimetype.
    static #seedEntry(): EntryData {
        const channels = Object.fromEntries(
            Object.entries(Http.manifest.channels).map(([name, mimetype]) => [name, {
                content: "",
                mimetype,
                state: "active" as const,
            }]),
        );
        return { channels, tags: [] };
    }

    // {§revalidation} `static` exact materializations and successfully `closed`
    // streams are final. Active or failed channels cannot vouch for a reusable
    // representation, regardless of whether partial content is non-empty.
    static #representationComplete(entry: StoredEntryData): boolean {
        return Object.values(entry.channels).every(({ state }) => state === "static" || state === "closed");
    }

    // {§revalidation} Direct READ and exact FIND share the complete reusable
    // representation predicate; freshness only decides how READ uses a match.
    static async #reusableGetRepresentation(
        entry: StoredEntryData,
        requestHeaders: ReadonlyArray<readonly [string, string]>,
        projection: ProjectionCaps,
    ): Promise<boolean> {
        const body = entry.channels[BODY];
        const header = entry.channels[HEADER];
        return body !== undefined
            && header !== undefined
            && Http.#representationComplete(entry)
            && Http.#requestMethod(header.content) === "GET"
            && requestHeaders.length === 0
            && Http.#cacheVariant(header.content) === "default"
            && await Http.#projectionCurrent(header.content, projection);
    }

    // {§revalidation} Origin headers come first; authoritative package method
    // and acquisition metadata are appended last.
    static async #writeHeader(
        subscription: StreamSubscription,
        method: string,
        status: number,
        statusText: string,
        responseHeaders: ReadonlyArray<readonly [string, string]>,
        requestHeaders: ReadonlyArray<readonly [string, string]>,
    ): Promise<void> {
        const lines = [`HTTP ${status} ${statusText}`];
        for (const [k, v] of responseHeaders) lines.push(`${k}: ${v}`);
        lines.push(`${REQUEST_METHOD}: ${method}`);
        lines.push(`${FETCHED_AT}: ${new Date().toISOString()}`);
        lines.push(cacheVariantEvidence(classifyCacheVariant(requestHeaders, responseHeaders)));
        await subscription.notifyChunk(HEADER, lines.join("\n"), "text/plain");
    }

    static async #writeProjectionIdentity(
        subscription: StreamSubscription,
        identity: string,
    ): Promise<void> {
        await subscription.notifyChunk(
            HEADER,
            `\n${WebFetcher.projectionEvidence(identity)}`,
            "text/plain",
        );
    }

    // Drain an acquired SSE body and settle its retained subscription. The READ
    // has already returned 102, so terminal failure is durable stream state.
    static async #settleEventStream(
        subscription: StreamSubscription,
        response: Response,
        options: { url: string; method: string; signal: AbortSignal; errorDetailLimit: number },
    ): Promise<void> {
        try {
            const events = await Http.#streamEvents(subscription, response);
            await subscription.close({ status: 200 }, `SSE stream; ${events} events`);
        } catch (error) {
            if (options.signal.aborted) {
                const result = Http.#cancelled(options.url, options.method);
                await subscription.close(result, result.problem?.detail);
                return;
            }
            console.error("HTTP SSE stream failed", { method: options.method, url: options.url, error });
            const cause = ErrorDetail.preview(error, options.errorDetailLimit);
            const reason = `HTTP ${options.method} ${options.url} failed: ${cause}`;
            const result = Http.#bad(
                502,
                "http",
                "fetch-failed",
                reason,
                {
                    target: options.url,
                    method: options.method,
                    stage: "transfer",
                    retryable: true,
                },
            );
            await subscription.close(result, reason);
        }
    }

    // event/id/retry/comments remain transport metadata: this projection
    // publishes event data, not the wire, and does not reconnect.
    static async #streamEvents(subscription: StreamSubscription, response: Response): Promise<number> {
        if (response.body === null) return 0;
        const decoder = new TextDecoder();
        const pending: string[] = [];
        let fatal: ParseError | null = null;
        let events = 0;
        const parser = createParser({
            maxBufferSize: requireNumEnv("PLURNK_SCHEMES_HTTP_SSE_MAX_BUFFER_CHARS"),
            onEvent: ({ data }) => pending.push(data),
            // Unknown fields and invalid retry hints are irrelevant to this
            // non-reconnecting data projection. Buffer exhaustion is fatal.
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
    }

    static #address(target: UrlPath): NetworkAddress | PassthroughResult {
        let address: NetworkAddress;
        try {
            address = NetworkAddress.from(target);
        } catch {
            return Http.#bad(400, "http", "bad-target", "HTTP operations require an http(s):// URL with an authority.", {
                stage: "target-validation",
                recovery: "Provide an http(s):// URL with a host.",
                retryable: false,
            });
        }
        if (address.scheme !== "http" && address.scheme !== "https") {
            return Http.#bad(400, "http", "bad-target", "HTTP operations require an http(s):// URL target.", {
                stage: "target-validation",
                recovery: "Provide an http(s):// URL target.",
                retryable: false,
            });
        }
        if (address.hasCredentials) {
            return Http.#bad(400, "http", "userinfo-not-allowed", "HTTP URL userinfo is not allowed.", {
                target: address.url,
                stage: "target-validation",
                recovery: "Remove credentials from the URL and use request metadata where authorization is required.",
                retryable: false,
            });
        }
        return address;
    }

    // {§revalidation} One predicate owns the TTL pre-fetch decision and the
    // post-fetch 304 decision.
    static #storedCopyServable(fetchedAtMs: number | undefined, response: Response | null): boolean {
        if (response === null) {
            const ttl = requireNumEnv("PLURNK_SCHEMES_HTTP_TTL_MS");
            return ttl > 0 && fetchedAtMs !== undefined && Date.now() - fetchedAtMs < ttl;
        }
        return response.status === 304;
    }

    // Package metadata is appended after origin headers, so the last value wins.
    static #fetchedAt(priorHeader: string): number | undefined {
        const value = lastHeaderValue(priorHeader, FETCHED_AT);
        if (value === undefined) return undefined;
        const ms = Date.parse(value);
        return Number.isNaN(ms) ? undefined : ms;
    }

    static #requestMethod(priorHeader: string): string | undefined {
        return lastHeaderValue(priorHeader, REQUEST_METHOD)?.toUpperCase();
    }

    // Package evidence is authoritative only after the package acquisition
    // stamp. An origin field with the same name remains inert.
    static #packageHeaderValue(priorHeader: string, field: string): string | undefined {
        const lines = priorHeader.split(/\r?\n/);
        let stampIndex = -1;
        for (const [index, line] of lines.entries()) {
            const colon = line.indexOf(":");
            if (colon < 0) continue;
            const name = line.slice(0, colon).trim().toLowerCase();
            if (name === FETCHED_AT) stampIndex = index;
        }
        if (stampIndex < 0) return undefined;
        let value: string | undefined;
        for (const line of lines.slice(stampIndex + 1)) {
            const colon = line.indexOf(":");
            if (colon < 0 || line.slice(0, colon).trim().toLowerCase() !== field) continue;
            value = line.slice(colon + 1).trim();
        }
        return value === "" ? undefined : value;
    }

    static #projectionIdentity(priorHeader: string): string | undefined {
        return Http.#packageHeaderValue(priorHeader, PROJECTION_ID_HEADER);
    }

    static #cacheVariant(priorHeader: string): CacheVariant | undefined {
        const value = Http.#packageHeaderValue(priorHeader, CACHE_VARIANT_HEADER);
        return value === "default" || value === "bypass" ? value : undefined;
    }

    static #sourceMimetype(header: string): string {
        return responseMimetype(lastHeaderValue(header, "content-type") ?? null);
    }

    static async #projectionCurrent(header: string, projection: ProjectionCaps): Promise<boolean> {
        const storedIdentity = Http.#projectionIdentity(header);
        if (storedIdentity === undefined) return true;
        return await projection.identity(Http.#sourceMimetype(header)) === storedIdentity;
    }

    // Re-stamp package evidence when the origin vouches with 304. A newly
    // observed Vary field can only retire reuse; #198 owns other 304 updates.
    static #stamp(header: string, variant: CacheVariant): string {
        return replaceLastHeaderValue(
            replaceLastHeaderValue(header, FETCHED_AT, new Date().toISOString()),
            CACHE_VARIANT_HEADER,
            variant,
        );
    }

    // Conditional-request headers from the prior fetch's stored response headers
    // (the HEADER channel text #writeHeader wrote): ETag → If-None-Match,
    // Last-Modified → If-Modified-Since. Empty when neither is present — the
    // origin then just 200s with a full body, which is correct.
    static #validators(priorHeader: string): Array<[string, string]> {
        const out: Array<[string, string]> = [];
        const etag = /^etag:[ \t]*(.+)$/im.exec(priorHeader);
        if (etag !== null) out.push(["If-None-Match", etag[1].trim()]);
        const lastModified = /^last-modified:[ \t]*(.+)$/im.exec(priorHeader);
        if (lastModified !== null) out.push(["If-Modified-Since", lastModified[1].trim()]);
        return out;
    }

    static #passthrough(result: SchemeResult): PassthroughResult {
        return Results.assert({ ...result, shape: "passthrough" }) as PassthroughResult;
    }

    static #cancelled(url: string, method: string): PassthroughResult {
        return Http.#bad(
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
    }

    static #materializationFailure(
        url: string,
        method: string,
        error: WebMaterializationError,
    ): PassthroughResult {
        if (error.stage === "projection" && error.cause instanceof ProjectionInputLimitError) {
            return Http.#bad(
                413,
                "http",
                "projection-input-limit",
                `HTTP ${method} ${url} exceeded the ${error.cause.maximumBytes}-byte readable-projection input limit.`,
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
        const projection = error.stage === "projection";
        return Http.#bad(
            projection ? 500 : 502,
            "http",
            projection ? "projection-failed" : "render-failed",
            projection
                ? `HTTP ${method} ${url} acquired content, but its readable projection failed.`
                : `HTTP ${method} ${url} could not render HTML.`,
            {
                target: url,
                method,
                mimetype: error.mimetype,
                stage: error.stage,
                retryable: !projection,
            },
        );
    }

    static #noReadableProjection(url: string): PassthroughResult {
        return Http.#bad(
            422,
            "http",
            "no-readable-projection",
            `The URL ${url} has no readable projection.`,
            {
                target: url,
                stage: "projection",
                retryable: false,
            },
        );
    }

    static #bad(
        status: number,
        scheme: string,
        kind: string,
        message: string,
        extensions: Readonly<Record<string, unknown>> = {},
    ): PassthroughResult {
        return Results.failure(
            `scheme:${scheme}`,
            kind,
            status,
            message,
            { shape: "passthrough" },
            extensions,
        ) as PassthroughResult;
    }
}
