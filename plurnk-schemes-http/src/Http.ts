// HTTP(S) handler. Operation-to-method semantics live in {§op-surface};
// acquisition, materialization, publication, and query flow live in
// {§http-lifecycle}. The implementation depends only on SchemeCtx capabilities.

import { createParser, type ParseError } from "eventsource-parser";
import type {
    SchemeCtx,
    SubscriptionHandle,
    PassthroughResult,
    SchemeManifest,
    SchemeHandler,
    ReadStatement,
    SendStatement,
    EditStatement,
    KillStatement,
    UrlPath,
    EntryData,
    FindStatement,
    SchemeResult,
} from "@plurnk/plurnk-schemes";
import { MimetypeClassifier, NetworkAddress, PathSyntax, Results } from "@plurnk/plurnk-schemes";
import { readFile } from "node:fs/promises";
import Browser, { BROWSER_UA, requireNumEnv, type RenderResult } from "./Browser.ts";
import ErrorDetail from "./ErrorDetail.ts";
import Guard, {
    GuardBlockedError,
    GuardResolutionError,
    type GuardAdmission,
} from "./Guard.ts";
import WebFetcher, {
    rewriteAcquisitionTarget,
    WebMaterializationError,
    type WebFetchResult,
    type WebMaterializedResult,
} from "./WebFetcher.ts";

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
    render(url: string, opts: { workerId: number; signal?: AbortSignal; headers?: ReadonlyArray<readonly [string, string]>; guard: (url: string) => Promise<GuardAdmission> }): Promise<RenderResult>;
    close?(): Promise<void>;
}

export default class Http implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "http",
        // Channel mimetypes here are SEED DEFAULTS (pre-fetch placeholders).
        // body is retyped per-call via notifyChunk's mimetype arg — to the real
        // response Content-Type, or projected markdown for a rendered page; octet-stream
        // is the honest "unknown until fetched". header is always the status
        // line + headers (text/plain).
        channels: { [BODY]: "application/octet-stream", [HEADER]: "text/plain", html: "text/html" },
        defaultChannel: BODY,
        category: "data",
        scope: "workspace",
        writableBy: ["model", "client"],
        volatile: true,        // remote content can change between fetches
        modelVisible: true,
        glyph: "🌐",
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
    // acquired through the same guarded byte/render path used by search
    // prefetch. Glob targets only query already-known web entries.
    async prepareFind(statement: FindStatement, ctx: SchemeCtx): Promise<PassthroughResult> {
        const target = statement.target;
        if (target === null || target.kind !== "url") return { shape: "passthrough", status: 200 };
        const address = Http.#address(target);
        if (!(address instanceof NetworkAddress)) return address;
        const { pathname, url } = address;
        if (PathSyntax.hasGlob(target.pathname)) return { shape: "passthrough", status: 200 };
        const prior = await ctx.entries.read(pathname);
        if (prior.entry !== null) {
            const priorMethod = Http.#requestMethod(prior.entry.channels[HEADER]?.content ?? "");
            if (priorMethod === undefined || priorMethod === "GET") {
                return { shape: "passthrough", status: 200 };
            }
        }
        if (Results.isErrorStatus(prior.status) && prior.status !== 404) {
            return Http.#passthrough(prior);
        }
        // {§prefetch} WebFetcher preserves caller cancellation as rejection;
        // this operation owns its one model-facing 499 projection.
        let fetched: WebFetchResult | null;
        try {
            fetched = await this.#webFetcher.fetch(url, { signal: ctx.signal });
        } catch (err) {
            if (ctx.signal?.aborted === true && err === ctx.signal.reason) {
                return Http.#cancelled(url, "GET");
            }
            const admission = Http.#admissionFailure(url, "GET", err);
            if (admission !== null) return admission;
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
            const admission = Http.#admissionFailure(url, "GET", err);
            if (admission !== null) return admission;
            if (err instanceof WebMaterializationError) {
                return Http.#materializationFailure(url, "GET", err);
            }
            throw err;
        }
        if (materialized === null) return Http.#noReadableProjection(url);
        const channels: EntryData["channels"] = {
            [BODY]: materialized.body,
            ...(materialized.html === undefined ? {} : { html: materialized.html }),
            ...(fetched.header === undefined ? {} : { [HEADER]: { content: fetched.header, mimetype: "text/plain" } }),
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

    // {§http-lifecycle} One guarded direct-operation path owns seeding,
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
            const ph = prior.entry?.channels[HEADER]?.content ?? "";
            if (pb !== undefined && pb.content.length > 0 && Http.#requestMethod(ph) === "GET") {
                const html = prior.entry?.channels.html;
                cached = {
                    header: ph,
                    body: { content: pb.content, mimetype: pb.mimetype },
                    ...(html === undefined || html.content.length === 0 ? {} : { html: { content: html.content, mimetype: html.mimetype } }),
                };
                conditional.push(...Http.#validators(ph));
            }
        }

        // {§revalidation} TTL fast path. Serving does not refresh the stamp;
        // only a network acquisition or 304 vouches for a new acquisition time.
        if (cached !== undefined && Http.#storedCopyServable(Http.#fetchedAt(cached.header), null)) {
            const written = await ctx.entries.write(pathname, Http.#seedEntry());
            if (Results.isErrorStatus(written.status)) return Http.#passthrough(written);
            await ctx.subscriptions.open(pathname, { cancel: () => {} }, { publishedChannel });
            await ctx.subscriptions.notifyChunk(HEADER, cached.header, "text/plain");
            if (cached.html !== undefined) await ctx.subscriptions.notifyChunk("html", cached.html.content, cached.html.mimetype);
            await ctx.subscriptions.notifyChunk(BODY, cached.body.content, cached.body.mimetype);
            await ctx.subscriptions.close({ status: 200 }, `ttl-fresh; ${cached.body.content.length} chars from cache`);
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
        const composed = await ctx.subscriptions.open(pathname, handle, { publishedChannel });
        const onAbort = () => local.abort();
        composed.addEventListener("abort", onAbort, { once: true });

        try {
            const requestHeaders: Array<[string, string]> = headers.some(([k]) => k.toLowerCase() === "user-agent")
                ? [...headers, ...conditional]
                : [["User-Agent", BROWSER_UA], ...headers, ...conditional];
            const response = await Guard.fetch(url, {
                method,
                body,
                // One browser identity on the wire (never Node's default "node"
                // UA — a loud automated-client fingerprint). The model's own
                // {User-Agent: …} block wins when present.
                headers: requestHeaders,
            }, local.signal);

            // {§revalidation} A 304 restores the GET representation into the
            // freshly seeded channels and remains an ordinary streaming READ.
            if (cached !== undefined && Http.#storedCopyServable(Http.#fetchedAt(cached.header), response)) {
                await ctx.subscriptions.notifyChunk(HEADER, Http.#stamp(cached.header), "text/plain");
                if (cached.html !== undefined) await ctx.subscriptions.notifyChunk("html", cached.html.content, cached.html.mimetype);
                await ctx.subscriptions.notifyChunk(BODY, cached.body.content, cached.body.mimetype);
                await ctx.subscriptions.close({ status: 200 }, `revalidated 304; ${cached.body.content.length} chars from cache`);
                return { shape: "passthrough", status: 102 };
            }

            const contentType = response.headers.get("content-type") ?? "";
            const responseMime = contentType.split(";")[0].trim().toLowerCase();

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
                        guard: Guard.admit,
                    });
                } catch (cause) {
                    throw new WebMaterializationError("render", responseMime, cause);
                }
                await Http.#writeHeader(ctx, method, result.status, result.statusText, result.headers);
                await ctx.subscriptions.notifyChunk("html", result.html, "text/html");
                const materialized = await WebFetcher.materialize(
                    { body: result.html, mimetype: "text/html" },
                    ctx.projection,
                );
                if (materialized === null) {
                    const failure = Http.#noReadableProjection(url);
                    await ctx.subscriptions.close(failure, failure.problem?.detail);
                    return failure;
                }
                await ctx.subscriptions.notifyChunk(BODY, materialized.body.content, materialized.body.mimetype);
                await ctx.subscriptions.close({ status: 200 }, `rendered HTTP ${result.status}; ${materialized.body.content.length} readable chars`);
                return { shape: "passthrough", status: 102 };
            }

            // SSE: an event stream is parsed into its `data` payloads (SPEC {§sse}),
            // one notifyChunk per event with the `data:`/comment framing stripped,
            // so the model reads event content and not the transport. A long-lived
            // GET; events land in the body channel as they arrive across turns,
            // until the origin closes. Only GET — a POST reply is never an SSE READ.
            if (method === "GET" && /^text\/event-stream\b/i.test(contentType)) {
                await Http.#writeHeader(ctx, method, response.status, response.statusText, [...response.headers]);
                return await Http.#streamEvents(ctx, response);
            }

            // {§http-lifecycle}/{§mimetype-classifier} String channels retain
            // textual response data. Binary responses become typed empty markers;
            // decoding bytes while preserving their origin MIME type would lie
            // about the stored representation.
            await Http.#writeHeader(ctx, method, response.status, response.statusText, [...response.headers]);
            const bodyMime = responseMime || "application/octet-stream";
            if (response.body === null) {
                await ctx.subscriptions.close({ status: 200 }, `HTTP ${response.status}; empty body`);
                return { shape: "passthrough", status: 102 };
            }
            if (MimetypeClassifier.isBinary(bodyMime)) {
                await response.body.cancel();
                await ctx.subscriptions.notifyChunk(BODY, "", bodyMime);
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
                await ctx.subscriptions.close(result, detail);
                return result;
            }
            let bytes = 0;
            const decoder = new TextDecoder();
            for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
                bytes += chunk.length;
                await ctx.subscriptions.notifyChunk(BODY, decoder.decode(chunk, { stream: true }), bodyMime);
            }
            const tail = decoder.decode();
            if (tail.length > 0) await ctx.subscriptions.notifyChunk(BODY, tail, bodyMime);

            await ctx.subscriptions.close({ status: 200 }, `HTTP ${response.status}; ${bytes} bytes`);
            return { shape: "passthrough", status: 102 };
        } catch (err) {
            const aborted = local.signal.aborted;
            if (aborted) {
                const result = Http.#cancelled(url, method);
                await ctx.subscriptions.close(result, result.problem?.detail);
                return result;
            }
            const admission = Http.#admissionFailure(url, method, err);
            if (admission !== null) {
                await ctx.subscriptions.close(admission, admission.problem?.detail);
                return admission;
            }
            if (err instanceof WebMaterializationError) {
                const result = Http.#materializationFailure(url, method, err);
                await ctx.subscriptions.close(result, result.problem?.detail);
                return result;
            }
            console.error("HTTP acquisition failed", { method, url, err });
            const cause = ErrorDetail.preview(err, this.#errorDetailLimit);
            const reason = `HTTP ${method} ${url} failed: ${cause}`;
            // The remaining catch owns generic acquisition failure; cancellation,
            // admission, and typed materialization failures settled above.
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
            await ctx.subscriptions.close(result, reason);
            return result;
        } finally {
            composed.removeEventListener("abort", onAbort);
        }
    }

    // {§http-manifest}/{§http-lifecycle} Seed the declared channel shape before
    // open(); notifyChunk later welds acquired content to its actual mimetype.
    static #seedEntry(): EntryData {
        const channels = Object.fromEntries(
            Object.entries(Http.manifest.channels).map(([name, mimetype]) => [name, { content: "", mimetype }]),
        );
        return { channels, tags: [] };
    }

    // {§revalidation} Origin headers come first; authoritative package method
    // and acquisition-time metadata are appended last.
    static async #writeHeader(ctx: SchemeCtx, method: string, status: number, statusText: string, headers: ReadonlyArray<readonly [string, string]>): Promise<void> {
        const lines = [`HTTP ${status} ${statusText}`];
        for (const [k, v] of headers) lines.push(`${k}: ${v}`);
        lines.push(`${REQUEST_METHOD}: ${method}`);
        lines.push(`${FETCHED_AT}: ${new Date().toISOString()}`);
        await ctx.subscriptions.notifyChunk(HEADER, lines.join("\n"), "text/plain");
    }

    // Drain an SSE body through the standard streaming parser and dispatch one
    // BODY chunk per event. event/id/retry/comments remain transport metadata:
    // this projection publishes data, not the wire, and does not reconnect.
    static async #streamEvents(ctx: SchemeCtx, response: Response): Promise<PassthroughResult> {
        if (response.body === null) {
            await ctx.subscriptions.close({ status: 200 }, "SSE stream; empty body");
            return { shape: "passthrough", status: 102 };
        }
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
                await ctx.subscriptions.notifyChunk(BODY, `${data}\n`, "text/plain");
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
        await ctx.subscriptions.close({ status: 200 }, `SSE stream; ${events} events`);
        return { shape: "passthrough", status: 102 };
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

    // Re-stamp the package-owned (last) field when the origin vouches with 304.
    static #stamp(header: string): string {
        return replaceLastHeaderValue(header, FETCHED_AT, new Date().toISOString());
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

    // Guard is the single classifier. HTTP owns only the model-facing Problem
    // projection, including admission errors nested beneath lazy render and
    // cleanup wrappers.
    static #admissionFailure(
        url: string,
        method: string,
        caught: unknown,
    ): PassthroughResult | null {
        const error = Http.#findAdmissionError(caught);
        if (error === null) return null;
        const resolution = error instanceof GuardResolutionError;
        if (resolution || error !== caught) {
            console.error("HTTP target admission failed", { method, url, error: caught });
        }
        return Http.#bad(
            resolution ? 502 : 403,
            "http",
            resolution ? "dns-resolution-failed" : "ssrf-blocked",
            resolution
                ? `DNS resolution failed for ${error.url}.`
                : `${error.url} is not a public http(s) target.`,
            {
                target: error.url,
                method,
                stage: resolution ? "target-resolution" : "target-validation",
                retryable: resolution,
            },
        );
    }

    static #findAdmissionError(
        value: unknown,
        seen: Set<object> = new Set(),
    ): GuardBlockedError | GuardResolutionError | null {
        if (value instanceof GuardBlockedError || value instanceof GuardResolutionError) return value;
        if (typeof value !== "object" || value === null || seen.has(value)) return null;
        seen.add(value);
        if (value instanceof AggregateError) {
            for (const error of value.errors) {
                const found = Http.#findAdmissionError(error, seen);
                if (found !== null) return found;
            }
        }
        if (value instanceof Error) return Http.#findAdmissionError(value.cause, seen);
        return null;
    }

    static #materializationFailure(
        url: string,
        method: string,
        error: WebMaterializationError,
    ): PassthroughResult {
        console.error("HTTP materialization failed", { method, url, error });
        const projection = error.stage === "projection";
        return Http.#bad(
            projection ? 500 : 502,
            "http",
            projection ? "projection-failed" : "render-failed",
            projection
                ? `HTTP ${method} ${url} acquired HTML, but its readable projection failed.`
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
