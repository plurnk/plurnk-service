// http(s):// scheme handler — the first greenfield `@plurnk/plurnk-schemes-*`
// sibling, authored entirely against the DB-free capability ctx (SchemeCtx).
// It never imports plurnk-service and never touches a raw DB handle (SPEC §5);
// the substrate is reached only through intent, via the injected caps.
//
// Surface:
//   READ(http(s)://host/path)   — fetch the URL; stream the response body into
//                                 the `body` channel as it arrives. A streaming
//                                 read (SPEC §7.1): returns 102 Processing
//                                 immediately, the subscription accumulates,
//                                 the model reads the entry on a later turn.
//   SEND[200](http(s)://...)    — request with a body (POST by default); the
//                                 response streams back the same way.
//   SEND[499](http(s)://...)    — cancel an in-flight request (abort the fetch).
//   SEND[410](http(s)://...)    — delete the cached response entry.
//
// Network exception: SPEC §5 forbids opening connections "unless specifically
// a network scheme." This IS that scheme — `fetch` is the whole point. No
// runtime deps: `fetch` and `AbortController` are Node built-ins.

import type {
    SchemeCtx,
    SubscriptionHandle,
    PassthroughResult,
    SchemeManifest,
} from "@plurnk/plurnk-schemes";
import { Results } from "@plurnk/plurnk-schemes";
import type { ReadStatement, SendStatement, UrlPath } from "@plurnk/plurnk-grammar";

// The channel the response body streams into, and the header metadata channel.
const BODY = "body";
const HEADER = "header";

export default class Http {
    static manifest: SchemeManifest = {
        name: "http",
        // body: the response payload (mimetype is per-call — set from the
        // response Content-Type — so channels declares the names, the write
        // carries the actual mimetype). header: the response status line + headers.
        channels: { [BODY]: "text/markdown", [HEADER]: "text/markdown" },
        defaultChannel: BODY,
        category: "data",
        scope: "session",
        writableBy: ["model", "client"],
        volatile: true,        // remote content can change between fetches
        modelVisible: true,
        flags: {
            requiresWeb: true, // excluded under the loop's noWeb flag
        },
    };

    // READ → fetch + stream the response body. Returns 102 Processing; the
    // subscription drives the channel content the model sees next turn.
    async read(statement: ReadStatement, ctx: SchemeCtx): Promise<PassthroughResult> {
        if (statement.target === null || statement.target.kind !== "url") {
            return Http.#bad(400, "http", "bad_target", "READ requires an http(s):// URL target");
        }
        return Http.#fetchStream(statement.target, ctx, undefined);
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
            return Http.#fetchStream(statement.target, ctx, body);
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

    // The streaming core, shared by READ and SEND[200]. Opens the subscription
    // (registering the abort handle for SEND[499] routing), fetches, and pumps
    // the response body into the BODY channel chunk-by-chunk via the fused
    // notifyChunk. Settles via close().
    static async #fetchStream(target: UrlPath, ctx: SchemeCtx, requestBody: string | undefined): Promise<PassthroughResult> {
        const url = Http.#urlFrom(target);
        const pathname = target.pathname;

        // Local AbortController for force-cancel from outside (SEND[499]).
        const local = new AbortController();
        const handle: SubscriptionHandle = { cancel: () => local.abort() };

        // open() returns the run+teardown-composed signal — fires on loop.cancel
        // OR our local teardown. Wire it to the fetch so either path aborts it.
        const composed = await ctx.subscriptions.open(pathname, handle);
        const onAbort = () => local.abort();
        composed.addEventListener("abort", onAbort, { once: true });

        try {
            const response = await fetch(url, {
                method: requestBody === undefined ? "GET" : "POST",
                body: requestBody,
                signal: local.signal,
                redirect: "follow",
            });

            // Record the response status + headers in the HEADER channel.
            const headerLines = [`HTTP ${response.status} ${response.statusText}`];
            for (const [k, v] of response.headers) headerLines.push(`${k}: ${v}`);
            await ctx.subscriptions.notifyChunk(HEADER, headerLines.join("\n"));

            if (response.body === null) {
                await ctx.subscriptions.close("done", `HTTP ${response.status}; empty body`);
                return { shape: "passthrough", status: 102 };
            }

            let bytes = 0;
            const decoder = new TextDecoder();
            for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
                bytes += chunk.length;
                await ctx.subscriptions.notifyChunk(BODY, decoder.decode(chunk, { stream: true }));
            }
            const tail = decoder.decode();
            if (tail.length > 0) await ctx.subscriptions.notifyChunk(BODY, tail);

            await ctx.subscriptions.close("done", `HTTP ${response.status}; ${bytes} bytes`);
            return { shape: "passthrough", status: 102 };
        } catch (err) {
            const aborted = local.signal.aborted;
            const reason = aborted ? "aborted" : err instanceof Error ? err.message : String(err);
            await ctx.subscriptions.close("error", reason);
            // 499 for client-cancelled, 502 for upstream/network failure.
            return Http.#bad(aborted ? 499 : 502, "http", aborted ? "aborted" : "fetch_failed", reason);
        } finally {
            composed.removeEventListener("abort", onAbort);
        }
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
