// http(s):// scheme handler — the first greenfield `@plurnk/plurnk-schemes-*`
// sibling, authored entirely against the stable SchemeCtx contract. It never
// imports private service modules or depends on database layout.
//
// Surface — the HTTP method is the OP (grammar#46): READ→GET, SEND→POST,
// EDIT→PUT, KILL→DELETE. Every request streams its response the same way
// (102 Processing now; the subscription accumulates; the model reads next turn).
//   READ(http(s)://host/path)   — GET. HTML is rendered; else raw bytes stream.
//   SEND[200](http(s)://...)    — POST the body; response streams back.
//   EDIT(http(s)://...):body:   — PUT the body (full-resource replace; no `<L>`).
//   KILL(http(s)://...)         — DELETE the resource.
//   SEND[499](http(s)://...)    — cancel an in-flight request (abort the fetch).
//   SEND[410](http(s)://...)    — delete the locally cached response entry
//                                 (loop disposition, NOT an HTTP DELETE — that's KILL).
//
// Request headers ride IN the target as trailing `{Key: value}` blocks
// (grammar#46 — `UrlPath.headers`, ordered pairs), one header per block:
//   READ(https://api.x/v1{Authorization: Bearer T}{Accept: application/json})
// The SEND `[code]` is loop disposition (102/200/…), never the HTTP status —
// the real 2xx/4xx comes back in the response `header`/`body` channels.
//
// `fetch` is the scheme's purpose. Node owns acquisition; eventsource-parser
// owns the WHATWG event-stream framing used by SSE responses.

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
import { NetworkAddress, Results } from "@plurnk/plurnk-schemes";
import { readFile } from "node:fs/promises";
import Browser, { BROWSER_UA, requireNumEnv, type RenderResult } from "./Browser.ts";
import ErrorDetail from "./ErrorDetail.ts";
import WebFetcher from "./WebFetcher.ts";

// The channel the response body streams into, and the header metadata channel.
const BODY = "body";
const HEADER = "header";
// Materialization stamp line in the HEADER channel — the ONE timestamp the
// freshness predicate reads (SPEC {§revalidation}). Namespaced so it can never
// collide with a real response header.
const FETCHED_AT = "x-plurnk-fetched-at";

// Deep doc lives in `docs/http.md` (the constellation's docs/<name>.md
// convention) and is loaded into the manifest at module init — the contract
// field stays a plain string; only the authoring source moves out of line.
// `../docs/http.md` resolves identically from src/ (test) and dist/ (published):
// both sit one level under the package root. Missing file → fail-hard at import.
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
        if (target.pathname.includes("*")) return { shape: "passthrough", status: 200 };
        const prior = await ctx.entries.read(pathname);
        if (prior.entry !== null) return { shape: "passthrough", status: 200 };
        if (Results.isErrorStatus(prior.status) && prior.status !== 404) {
            return Http.#passthrough(prior);
        }
        const fetched = await this.#webFetcher.fetch(url, { signal: ctx.signal });
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
        let { body, mimetype } = fetched;
        let channels: EntryData["channels"] = {
            [BODY]: { content: body, mimetype },
            ...(fetched.header === undefined ? {} : { [HEADER]: { content: fetched.header, mimetype: "text/plain" } }),
        };
        if (mimetype === "text/html") {
            let projected = await ctx.projection.readable(body, mimetype);
            if ((projected === null || projected.content.length === 0) && fetched.render !== undefined) {
                const rendered = await fetched.render();
                if (rendered !== null) {
                    body = rendered.body;
                    mimetype = rendered.mimetype;
                    projected = await ctx.projection.readable(body, mimetype);
                }
            }
            if (projected === null || projected.content.length === 0) {
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
            channels = {
                [BODY]: { content: projected.content, mimetype: projected.mimetype },
                html: { content: body, mimetype },
                ...(fetched.header === undefined ? {} : { [HEADER]: { content: fetched.header, mimetype: "text/plain" } }),
            };
        }
        const written = await ctx.entries.write(pathname, { channels, tags: [] });
        return Http.#passthrough(written);
    }

    // An unscoped READ fetches/revalidates. A scoped READ observes the already
    // materialized readable entry: refetching would discard the requested range
    // and return another asynchronous whole-body 102.
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
            const prior = await ctx.entries.read(address.pathname);
            if (Results.isErrorStatus(prior.status) && prior.status !== 404) {
                return Http.#passthrough(prior);
            }
            const body = prior.entry?.channels[BODY];
            if (body === undefined || body.content.length === 0) {
                return Http.#bad(
                    409,
                    "http",
                    "scope-requires-materialization",
                    "The requested scoped READ has no materialized response.",
                    {
                        target: address.url,
                        stage: "projection",
                        recovery: "READ the URL without a scope before requesting a range.",
                        retryable: false,
                    },
                );
            }
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

    // The streaming core, shared by every verb. Opens the subscription
    // (registering the abort handle for SEND[499] routing), fetches, then EITHER
    // renders (a GET of an HTML page is re-acquired through the browser, its
    // readable projection becomes body, and its final DOM is archived) OR streams the raw bytes (every non-GET
    // response and every non-HTML body). Request headers from the target's `{…}`
    // blocks (grammar#46) ride into both the fetch and the render. Each chunk is
    // labelled with its real mimetype via notifyChunk. Settles via close().
    async #fetchStream(target: UrlPath, ctx: SchemeCtx, method: string, body: string | undefined): Promise<PassthroughResult> {
        const address = Http.#address(target);
        if (!(address instanceof NetworkAddress)) return address;
        const url = Http.#rewriteHostileHost(address.url);
        const { pathname } = address;
        const headers = target.headers ?? [];  // [key,value][] — opaque to grammar, honored here
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

        // Conditional revalidation (GET only, service#341): recover the prior
        // fetch's validators + body from THIS scheme's own stored entry (entries
        // cap, own namespace — sanctioned). If the origin answers 304, we re-serve
        // the cached body and skip the expensive render. Freshness is decided ONLY
        // by #storedCopyServable (SPEC {§revalidation}): within the operator TTL
        // window the stored copy serves with zero round-trips; past it, the
        // conditional GET revalidates (service#333/#405 landed the TTL). Captured
        // BEFORE the seed write below overwrites the entry.
        let cached: { header: string; body: { content: string; mimetype: string }; html?: { content: string; mimetype: string } } | undefined;
        const conditional: Array<[string, string]> = [];
        if (method === "GET") {
            const prior = await ctx.entries.read(pathname);
            if (Results.isErrorStatus(prior.status) && prior.status !== 404) {
                return Http.#passthrough(prior);
            }
            const pb = prior.entry?.channels[BODY];
            if (pb !== undefined && pb.content.length > 0) {
                const ph = prior.entry?.channels[HEADER]?.content ?? "";
                const html = prior.entry?.channels.html;
                cached = {
                    header: ph,
                    body: { content: pb.content, mimetype: pb.mimetype },
                    ...(html === undefined || html.content.length === 0 ? {} : { html: { content: html.content, mimetype: html.mimetype } }),
                };
                conditional.push(...Http.#validators(ph));
            }
        }

        // TTL fast path (the pre-fetch phase of the ONE predicate): a stored copy
        // still inside the freshness window serves with NO round-trip at all —
        // identical for a model READ and lane-1 prefetch (#405). Stamp unchanged:
        // the clock only resets when the ORIGIN vouches (fetch or 304), never by
        // serving from cache.
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

        // Materialize the streaming target BEFORE subscribing (http#3). open()
        // binds an EXISTING entry — only the scheme knows its channel shape, so
        // it seeds them. Mirror exec's create-then-subscribe: write a seed entry
        // whose channels are the manifest's (body: octet-stream placeholder,
        // header: text/plain) — the same channels notifyChunk then populates.
        const written = await ctx.entries.write(pathname, Http.#seedEntry());
        if (Results.isErrorStatus(written.status)) return Http.#passthrough(written);

        // open() returns the worker+teardown-composed signal — fires on loop.cancel
        // OR our local teardown. Wire it so either path aborts the fetch/render.
        const composed = await ctx.subscriptions.open(pathname, handle, { publishedChannel });
        const onAbort = () => local.abort();
        composed.addEventListener("abort", onAbort, { once: true });

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

            // Origin confirms the cached copy is current → re-serve it, skip the
            // render/stream. A 304-serve is a first-class READ: the model sees the
            // stored body as an ordinary streaming result, never a cache status
            // (service#341). `revalidated 304` rides the close summary for the log
            // meta line + digest. notifyChunk appends onto the freshly-seeded empty
            // channels, restoring the cached header + body.
            if (cached !== undefined && Http.#storedCopyServable(Http.#fetchedAt(cached.header), response)) {
                await ctx.subscriptions.notifyChunk(HEADER, Http.#stamp(cached.header), "text/plain");
                if (cached.html !== undefined) await ctx.subscriptions.notifyChunk("html", cached.html.content, cached.html.mimetype);
                await ctx.subscriptions.notifyChunk(BODY, cached.body.content, cached.body.mimetype);
                await ctx.subscriptions.close({ status: 200 }, `revalidated 304; ${cached.body.content.length} chars from cache`);
                return { shape: "passthrough", status: 102 };
            }

            const contentType = response.headers.get("content-type") ?? "";

            // Always-render: a GET of an HTML page is re-acquired through the
            // browser so the body is projected from the final rendered DOM. The probe-fetch
            // body is discarded — the browser does its own navigation. Only GET
            // renders; POST/PUT/DELETE can't be replayed as a browser navigation.
            const isHtml = method === "GET"
                && /^(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType);
            if (isHtml) {
                await response.body?.cancel();
                const result = await this.#browser.render(url, { workerId: ctx.workerId, signal: local.signal, headers });
                const projected = await ctx.projection.readable(result.html, "text/html");
                if (projected === null) throw new Error("rendered HTML has no readable projection");
                await Http.#writeHeader(ctx, result.status, result.statusText, result.headers);
                await ctx.subscriptions.notifyChunk("html", result.html, "text/html");
                await ctx.subscriptions.notifyChunk(BODY, projected.content, projected.mimetype);
                await ctx.subscriptions.close({ status: 200 }, `rendered HTTP ${result.status}; ${projected.content.length} readable chars`);
                return { shape: "passthrough", status: 102 };
            }

            // SSE: an event stream is parsed into its `data` payloads (SPEC {§sse}),
            // one notifyChunk per event with the `data:`/comment framing stripped,
            // so the model reads event content and not the transport. A long-lived
            // GET; events land in the body channel as they arrive across turns,
            // until the origin closes. Only GET — a POST reply is never an SSE READ.
            if (method === "GET" && /^text\/event-stream\b/i.test(contentType)) {
                await Http.#writeHeader(ctx, response.status, response.statusText, [...response.headers]);
                return await Http.#streamEvents(ctx, response);
            }

            // Byte path: stream the body labelled with its real content type.
            await Http.#writeHeader(ctx, response.status, response.statusText, [...response.headers]);
            const bodyMime = contentType.split(";")[0].trim() || "application/octet-stream";
            if (response.body === null) {
                await ctx.subscriptions.close({ status: 200 }, `HTTP ${response.status}; empty body`);
                return { shape: "passthrough", status: 102 };
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
            if (!aborted) console.error("HTTP acquisition failed", { method, url, err });
            const cause = ErrorDetail.preview(err, this.#errorDetailLimit);
            const reason = aborted
                ? `HTTP ${method} ${url} was cancelled.`
                : `HTTP ${method} ${url} failed: ${cause}`;
            // 499 for client-cancelled, 502 for upstream/network/render failure.
            const result = Http.#bad(
                aborted ? 499 : 502,
                "http",
                aborted ? "cancelled" : "fetch-failed",
                reason,
                {
                    target: url,
                    method,
                    stage: "acquisition",
                    retryable: !aborted,
                },
            );
            await ctx.subscriptions.close(result, reason);
            return result;
        } finally {
            composed.removeEventListener("abort", onAbort);
        }
    }

    // Seed entry mirroring the manifest's channels — empty content + the seed
    // mimetypes (body: octet-stream until the fetch retypes it via notifyChunk,
    // header: text/plain). This is the channel-shape knowledge open() lacks; the
    // scheme materializes the target so the subscription binds an existing entry
    // (http#3). Fresh stream target → no tags.
    static #seedEntry(): EntryData {
        const channels = Object.fromEntries(
            Object.entries(Http.manifest.channels).map(([name, mimetype]) => [name, { content: "", mimetype }]),
        );
        return { channels, tags: [] };
    }

    // Record the response status line + headers into the HEADER channel (text/plain).
    static async #writeHeader(ctx: SchemeCtx, status: number, statusText: string, headers: ReadonlyArray<readonly [string, string]>): Promise<void> {
        const lines = [`HTTP ${status} ${statusText}`];
        for (const [k, v] of headers) lines.push(`${k}: ${v}`);
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

    // Known-hostile-host rewrite — the ONE bounded, first-party exception
    // (SPEC {§host-rewrite}, schemes-http#4). A GitHub blob page is a CSP-locked JS SPA that renders
    // nothing useful, and code wants SOURCE (line-navigable) not markdown pulled
    // from a rendered code-viewer; raw.githubusercontent serves the exact bytes
    // on the byte path. Measured through the extractor: blob → SPA/JSON noise,
    // raw → clean source. The `{ref}/{path}` tail carries through verbatim, so
    // slash-bearing branch refs map correctly. Wikipedia was measured too and
    // deliberately gets NO rewrite — desktop already extracts to the full clean
    // article; every rewrite (action=render, mobile-html) regressed it.
    static #rewriteHostileHost(url: string): string {
        const gh = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url);
        if (gh !== null) return `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}`;
        return url;
    }

    // The single freshness-predicate boundary (service#341, #333). Today a
    // conditional-GET `304 Not Modified` proves the stored copy is current, so it
    // is servable without a re-fetch/re-render. service#333's per-URL TTL lands
    // HERE as the SAME predicate (a pre-fetch branch) — one stamp, one rule,
    // identical at every entry point. Never add a second freshness check elsewhere.
    // Pre-fetch phase (response === null): fresh iff the stamp is inside the
    // operator TTL window; PLURNK_SCHEMES_HTTP_TTL_MS=0 disables the window so
    // every read revalidates (the pre-TTL behavior). Post-fetch phase: a 304 is
    // the origin vouching for the stored copy.
    static #storedCopyServable(fetchedAtMs: number | undefined, response: Response | null): boolean {
        if (response === null) {
            const ttl = requireNumEnv("PLURNK_SCHEMES_HTTP_TTL_MS");
            return ttl > 0 && fetchedAtMs !== undefined && Date.now() - fetchedAtMs < ttl;
        }
        return response.status === 304;
    }

    // Parse the materialization stamp out of a stored HEADER channel; undefined
    // when absent (pre-TTL entries, execs-materialized pages) — those simply
    // never TTL-serve and revalidate instead.
    static #fetchedAt(priorHeader: string): number | undefined {
        const m = new RegExp(`^${FETCHED_AT}:[ \\t]*(.+)$`, "im").exec(priorHeader);
        if (m === null) return undefined;
        const ms = Date.parse(m[1].trim());
        return Number.isNaN(ms) ? undefined : ms;
    }

    // Re-stamp a stored HEADER to now — used when the ORIGIN vouches (304).
    static #stamp(header: string): string {
        const line = `${FETCHED_AT}: ${new Date().toISOString()}`;
        const re = new RegExp(`^${FETCHED_AT}:.*$`, "im");
        return re.test(header) ? header.replace(re, line) : `${header}\n${line}`;
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
