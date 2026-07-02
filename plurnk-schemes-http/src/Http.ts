// http(s):// scheme handler — the first greenfield `@plurnk/plurnk-schemes-*`
// sibling, authored entirely against the DB-free capability ctx (SchemeCtx).
// It never imports plurnk-service and never touches a raw DB handle (SPEC §5);
// the substrate is reached only through intent, via the injected caps.
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
// Network exception: SPEC §5 forbids opening connections "unless specifically
// a network scheme." This IS that scheme — `fetch` is the whole point. No
// runtime deps: `fetch` and `AbortController` are Node built-ins.

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
} from "@plurnk/plurnk-schemes";
import { Results } from "@plurnk/plurnk-schemes";
import { readFile } from "node:fs/promises";
import Browser, { type RenderResult } from "./Browser.ts";

// The channel the response body streams into, and the header metadata channel.
const BODY = "body";
const HEADER = "header";

// Deep doc lives in `docs/http.md` (the constellation's docs/<name>.md
// convention) and is loaded into the manifest at module init — the contract
// field stays a plain string; only the authoring source moves out of line.
// `../docs/http.md` resolves identically from src/ (test) and dist/ (published):
// both sit one level under the package root. Missing file → fail-hard at import.
const documentation = await readFile(new URL("../docs/http.md", import.meta.url), "utf-8");

// What Http needs from the render foundation — narrow, so tests inject a fake.
interface Renderer {
    render(url: string, opts: { runId: number; signal?: AbortSignal; headers?: ReadonlyArray<readonly [string, string]> }): Promise<RenderResult>;
}

export default class Http implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "http",
        // Channel mimetypes here are SEED DEFAULTS (pre-fetch placeholders).
        // body is retyped per-call via notifyChunk's mimetype arg — to the real
        // response Content-Type, or text/html for a rendered page; octet-stream
        // is the honest "unknown until fetched". header is always the status
        // line + headers (text/plain).
        channels: { [BODY]: "application/octet-stream", [HEADER]: "text/plain" },
        defaultChannel: BODY,
        category: "data",
        scope: "session",
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
    constructor(browser: Renderer = new Browser()) {
        this.#browser = browser;
    }

    // READ → fetch; an HTML page is rendered, everything else streams raw.
    // Returns 102 Processing; the subscription drives the channel content the
    // model sees next turn.
    async read(statement: ReadStatement, ctx: SchemeCtx): Promise<PassthroughResult> {
        if (statement.target === null || statement.target.kind !== "url") {
            return Http.#bad(400, "http", "bad_target", "READ requires an http(s):// URL target");
        }
        return this.#fetchStream(statement.target, ctx, "GET", undefined);
    }

    // EDIT → PUT the body (full-resource replace). `<L>` has no meaning against a
    // remote resource — reject rather than silently ignore the model's intent.
    async edit(statement: EditStatement, ctx: SchemeCtx): Promise<PassthroughResult> {
        if (statement.target === null || statement.target.kind !== "url") {
            return Http.#bad(400, "http", "bad_target", "EDIT requires an http(s):// URL target");
        }
        if (statement.lineMarker !== null) {
            return Http.#bad(400, "http", "no_line_edit", "EDIT on http PUTs the whole body; <L> line-editing a remote resource is unsupported");
        }
        return this.#fetchStream(statement.target, ctx, "PUT", statement.body ?? "");
    }

    // KILL → DELETE the resource. Distinct from SEND[410] (which drops the local
    // cached entry): KILL is an HTTP DELETE request to the remote.
    async kill(statement: KillStatement, ctx: SchemeCtx): Promise<PassthroughResult> {
        if (statement.target === null || statement.target.kind !== "url") {
            return Http.#bad(400, "http", "bad_target", "KILL requires an http(s):// URL target");
        }
        return this.#fetchStream(statement.target, ctx, "DELETE", statement.body ?? undefined);
    }

    // SEND dispatch — status-code-as-verb (SPEC §3.5).
    //   200 → request with body (POST), stream response
    //   410 → delete the cached entry
    //   499 → cancel in-flight (handled by the subscription's force-cancel;
    //         the engine routes 499 to the registered SubscriptionHandle, so a
    //         scheme-level no-op here is correct — teardown already happened)
    async send(statement: SendStatement, ctx: SchemeCtx): Promise<PassthroughResult> {
        if (statement.target === null || statement.target.kind !== "url") {
            return Http.#bad(400, "http", "bad_target", "SEND requires an http(s):// URL target");
        }
        const status = statement.signal;
        if (status === 200) {
            const body = statement.body?.raw ?? "";
            return this.#fetchStream(statement.target, ctx, "POST", body);
        }
        if (status === 410) {
            const { status: delStatus } = await ctx.entries.delete(statement.target.pathname);
            return { shape: "passthrough", status: delStatus };
        }
        if (status === 499) {
            // Cancellation is routed by the engine to the subscription's
            // SubscriptionHandle.cancel (registered in #fetchStream). Nothing
            // for the scheme to do at the op level.
            return { shape: "passthrough", status: 200 };
        }
        // Entry-bearing schemes return 501 for status codes they don't interpret.
        return Http.#bad(501, "http", "unsupported_send", `SEND[${status}] not supported by http`);
    }

    // The streaming core, shared by every verb. Opens the subscription
    // (registering the abort handle for SEND[499] routing), fetches, then EITHER
    // renders (a GET of an HTML page is re-acquired through the browser and its
    // final DOM becomes the body) OR streams the raw bytes (every non-GET
    // response and every non-HTML body). Request headers from the target's `{…}`
    // blocks (grammar#46) ride into both the fetch and the render. Each chunk is
    // labelled with its real mimetype via notifyChunk. Settles via close().
    async #fetchStream(target: UrlPath, ctx: SchemeCtx, method: string, body: string | undefined): Promise<PassthroughResult> {
        const url = Http.#urlFrom(target);
        const pathname = target.pathname;
        const headers = target.headers;  // [key,value][] | undefined — opaque to grammar, honored here

        // Local AbortController for force-cancel from outside (SEND[499]).
        const local = new AbortController();
        const handle: SubscriptionHandle = { cancel: () => local.abort() };

        // Materialize the streaming target BEFORE subscribing (http#3). open()
        // binds an EXISTING entry — only the scheme knows its channel shape, so
        // it seeds them. Mirror exec's create-then-subscribe: write a seed entry
        // whose channels are the manifest's (body: octet-stream placeholder,
        // header: text/plain) — the same channels notifyChunk then populates.
        await ctx.entries.write(pathname, Http.#seedEntry());

        // open() returns the run+teardown-composed signal — fires on loop.cancel
        // OR our local teardown. Wire it so either path aborts the fetch/render.
        const composed = await ctx.subscriptions.open(pathname, handle);
        const onAbort = () => local.abort();
        composed.addEventListener("abort", onAbort, { once: true });

        try {
            const response = await fetch(url, {
                method,
                body,
                headers,
                signal: local.signal,
                redirect: "follow",
            });
            const contentType = response.headers.get("content-type") ?? "";

            // Always-render: a GET of an HTML page is re-acquired through the
            // browser so the body is the final rendered DOM. The probe-fetch
            // body is discarded — the browser does its own navigation. Only GET
            // renders; POST/PUT/DELETE can't be replayed as a browser navigation.
            const isHtml = method === "GET"
                && /^(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType);
            if (isHtml) {
                await response.body?.cancel();
                const result = await this.#browser.render(url, { runId: ctx.runId, signal: local.signal, headers });
                await Http.#writeHeader(ctx, result.status, result.statusText, result.headers);
                await ctx.subscriptions.notifyChunk(BODY, result.html, "text/html");
                await ctx.subscriptions.close("done", `rendered HTTP ${result.status}; ${result.html.length} chars`);
                return { shape: "passthrough", status: 102 };
            }

            // Byte path: stream the body labelled with its real content type.
            await Http.#writeHeader(ctx, response.status, response.statusText, [...response.headers]);
            const bodyMime = contentType.split(";")[0].trim() || "application/octet-stream";
            if (response.body === null) {
                await ctx.subscriptions.close("done", `HTTP ${response.status}; empty body`);
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

            await ctx.subscriptions.close("done", `HTTP ${response.status}; ${bytes} bytes`);
            return { shape: "passthrough", status: 102 };
        } catch (err) {
            const aborted = local.signal.aborted;
            const reason = aborted ? "aborted" : err instanceof Error ? err.message : String(err);
            await ctx.subscriptions.close("error", reason);
            // 499 for client-cancelled, 502 for upstream/network/render failure.
            return Http.#bad(aborted ? 499 : 502, "http", aborted ? "aborted" : "fetch_failed", reason);
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
        await ctx.subscriptions.notifyChunk(HEADER, lines.join("\n"), "text/plain");
    }

    // Reconstruct the absolute URL from the parsed UrlPath. `raw` is the
    // grammar's verbatim URL — authoritative; the decomposed fields are a
    // convenience. Use raw so query strings / auth / port survive exactly.
    static #urlFrom(target: UrlPath): string {
        return target.raw;
    }

    static #bad(status: number, scheme: string, kind: string, message: string): PassthroughResult {
        return { shape: "passthrough", status, error: Results.error(scheme, kind, message) };
    }
}
