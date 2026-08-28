// HTTP(S) handler. Operation-to-method semantics live in {§op-surface};
// acquisition, materialization, publication, and query flow live in
// {§http-lifecycle}. The implementation depends only on SchemeCtx capabilities.

import { createParser, type ParseError } from "eventsource-parser";
import type {
    SchemeCtx,
    SubscriptionHandle,
    StreamSubscription,
    ChannelProducerResult,
    PassthroughResult,
    SchemeManifest,
    SchemeHandler,
    RepresentationPreparationRequest,
    RepresentationPreparationResult,
    SendStatement,
    ResolvedEditStatement,
    KillStatement,
    UrlPath,
    EntryData,
    StoredEntryData,
    SchemeResult,
    ProjectionCaps,
    ChannelState,
} from "@plurnk/plurnk-schemes";
import {
    MimetypeClassifier,
    NetworkAddress,
    ProjectionInputLimitError,
    Results,
} from "@plurnk/plurnk-schemes";
import { readFile } from "node:fs/promises";
import ErrorDetail from "./ErrorDetail.ts";
import WebFetcher, {
    DEFAULT_WEB_UA,
    CACHE_VARIANT_HEADER,
    MATERIALIZER_ID_HEADER,
    PROJECTION_ID_HEADER,
    cacheVariantEvidence,
    classifyCacheVariant,
    WebMaterializationError,
    type CacheVariant,
    type WebFetchResult,
    type WebMaterializedResult,
} from "./WebFetcher.ts";
import { responseMimetype } from "./ContentType.ts";
import { requireNonNegativeIntegerEnv as requireNumEnv } from "./Config.ts";

// The channel the response body streams into, and the header metadata channel.
const BODY = "body";
const HEADER = "header";
// Package-owned metadata appended after untrusted origin headers. Readers take
// the last value so an origin using the same field name cannot override it.
const FETCHED_AT = "x-plurnk-fetched-at";
const REQUEST_METHOD = "x-plurnk-request-method";
const DELTA_SECONDS_LIMIT = 2_147_483_648n;
const BODY_PROCESSING_FIELDS = new Set([
    "content-encoding",
    "content-length",
    "content-range",
    "content-type",
]);

interface HeaderField {
    readonly name: string;
    readonly value: string;
    readonly line: string;
}

interface EntityTag {
    readonly weak: boolean;
    readonly opaque: string;
}

interface StoredCachePolicy {
    readonly noStore: boolean;
    readonly noCache: boolean;
    readonly freshnessLifetimeMs?: number;
}

const splitHttpList = (value: string): string[] => {
    const members: string[] = [];
    let start = 0;
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index]!;
        if (quoted) {
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === '"') quoted = false;
        } else if (character === '"') {
            quoted = true;
        } else if (character === ",") {
            members.push(value.slice(start, index).trim());
            start = index + 1;
        }
    }
    members.push(value.slice(start).trim());
    return members.filter((member) => member.length > 0);
};

const cacheDirective = (member: string): { name: string; argument?: string } | null => {
    const equals = member.indexOf("=");
    const name = member.slice(0, equals < 0 ? undefined : equals).trim().toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) return null;
    if (equals < 0) return { name };
    return { name, argument: member.slice(equals + 1).trim() };
};

const deltaMilliseconds = (argument: string | undefined): number | null => {
    if (argument === undefined) return null;
    const match = /^(?:([0-9]+)|"([0-9]+)")$/.exec(argument);
    const digits = match?.[1] ?? match?.[2];
    if (digits === undefined) return null;
    const seconds = BigInt(digits);
    return Number(seconds > DELTA_SECONDS_LIMIT ? DELTA_SECONDS_LIMIT : seconds) * 1000;
};

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

const entityTag = (value: string): EntityTag | null => {
    const match = /^(W\/)?"([\x21\x23-\x7e\x80-\xff]*)"$/.exec(value);
    return match === null
        ? null
        : { weak: match[1] !== undefined, opaque: match[2]! };
};

const MONTHS: readonly string[] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const WEEKDAYS: readonly string[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const IMF_FIXDATE = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), ([0-9]{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/;
const RFC850_DATE = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), ([0-9]{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/;
const ASCTIME_DATE = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: ([0-9])|([0-9]{2})) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/;

const utcHttpDate = (
    weekday: string,
    day: string,
    month: string,
    year: number,
    hour: string,
    minute: string,
    second: string,
): number | null => {
    const monthIndex = MONTHS.indexOf(month);
    const weekdayIndex = WEEKDAYS.indexOf(weekday.slice(0, 3));
    const numericDay = Number(day);
    const numericHour = Number(hour);
    const numericMinute = Number(minute);
    const numericSecond = Number(second);
    if (monthIndex < 0 || weekdayIndex < 0) return null;
    const date = new Date(0);
    date.setUTCFullYear(year, monthIndex, numericDay);
    date.setUTCHours(numericHour, numericMinute, numericSecond, 0);
    return date.getUTCFullYear() === year
        && date.getUTCMonth() === monthIndex
        && date.getUTCDate() === numericDay
        && date.getUTCHours() === numericHour
        && date.getUTCMinutes() === numericMinute
        && date.getUTCSeconds() === numericSecond
        && date.getUTCDay() === weekdayIndex
        ? date.getTime()
        : null;
};

const httpDate = (value: string, now = Date.now()): number | null => {
    const preferred = IMF_FIXDATE.exec(value);
    if (preferred !== null) {
        return utcHttpDate(
            preferred[1]!,
            preferred[2]!,
            preferred[3]!,
            Number(preferred[4]),
            preferred[5]!,
            preferred[6]!,
            preferred[7]!,
        );
    }
    const rfc850 = RFC850_DATE.exec(value);
    if (rfc850 !== null) {
        let year = 2000 + Number(rfc850[4]);
        if (year > new Date(now).getUTCFullYear() + 50) year -= 100;
        return utcHttpDate(
            rfc850[1]!,
            rfc850[2]!,
            rfc850[3]!,
            year,
            rfc850[5]!,
            rfc850[6]!,
            rfc850[7]!,
        );
    }
    const asctime = ASCTIME_DATE.exec(value);
    return asctime === null
        ? null
        : utcHttpDate(
            asctime[1]!,
            asctime[3] ?? asctime[4]!,
            asctime[2]!,
            Number(asctime[8]),
            asctime[5]!,
            asctime[6]!,
            asctime[7]!,
        );
};

// The package-shipped model teaching is loaded verbatim and fails hard if absent.
// The relative path is identical from src/ during development and dist/ after build.
const documentation = await readFile(new URL("../docs/https.md", import.meta.url), "utf-8");

const LLMS_TEXT_ATTEMPT_TTL_MS = 3_600_000;

export default class Http implements SchemeHandler {
    static manifest: SchemeManifest = {
        // "https" is the registered face — plain http folds into it exactly as
        // ws folds into wss ({§http-manifest}); supported, never advertised as
        // a peer endpoint.
        name: "https",
        authority: "resource",
        // Channel mimetypes here are SEED DEFAULTS (pre-fetch placeholders).
        // body is retyped per-call via notifyChunk's mimetype arg — to the real
        // response Content-Type or the configured readable projection type;
        // octet-stream is the honest "unknown until fetched". header is always the status
        // line + headers (text/plain).
        channels: { [BODY]: "application/octet-stream", [HEADER]: "text/plain", html: "text/html" },
        defaultChannel: BODY,
        category: "data",
        entryOwner: "worker",
        inherit: "snapshot",
        writableBy: ["model", "client"],
        volatile: true,        // remote content can change between fetches
        modelVisible: true,
        metadataModifier: true,
        glyph: "🌐",
        example: [
            "## READ0 (https://example.com/page)",
            "",
            "## EDIT0 (https://api.example.com/v1/pets/42) {Content-Type: application/json}",
            '{"name":"Mango","status":"available"}',
            "",
            "## SEND0 [200] (https://api.example.com/v1/pets) {Content-Type: application/json}",
            '{"name":"Mango","status":"available"}',
        ].join("\n"),
        documentation,
        flags: {
            requiresWeb: true, // excluded under the loop's noWeb flag
        },
    };

    readonly #errorDetailLimit: number;
    readonly #webFetcher: WebFetcher;
    // {§http-llms-txt} — one opportunistic origin-companion attempt per TTL
    // window; success and failure share the timer so a 404 does not re-probe
    // on every READ.
    readonly #llmsTextAttempts = new Map<string, number>();
    constructor() {
        this.#errorDetailLimit = ErrorDetail.configuredLimit();
        this.#webFetcher = new WebFetcher();
    }

    async ready(): Promise<void> {
        WebFetcher.validateConfiguration();
    }

    // Representation preparation is scope-blind. Core applies the authored READ
    // coordinates only after this hook has either materialized a finite GET or
    // returned 102 for a retained SSE response.
    async prepareRepresentation(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult> {
        if (request.target.kind !== "url") {
            return Http.#bad(400, "http", "bad-target", "READ requires an http(s):// URL target.", {
                stage: "target-validation",
                recovery: "Provide an http(s):// URL target.",
                retryable: false,
            });
        }
        return this.#prepareGet(request.target, request.metadata, request.pathname, ctx);
    }

    async #prepareGet(
        target: UrlPath,
        metadata: readonly string[] | null,
        pathname: string,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult> {
        const address = Http.#address(target);
        if (!(address instanceof NetworkAddress)) return address;
        const { url } = address;
        const requestHeaders = Http.#requestHeaders(metadata);
        if (!Array.isArray(requestHeaders)) return requestHeaders;
        let cached: StoredEntryData | undefined;
        const conditional: Array<[string, string]> = [];
        const prior = await ctx.entries.read(pathname);
        if (Results.isErrorStatus(prior.status) && prior.status !== 404) {
            return Http.#passthrough(prior);
        }
        const priorBody = prior.entry?.channels[BODY];
        const priorHeader = prior.entry?.channels[HEADER];
        if (prior.entry !== null && Http.#requestMethod(priorHeader?.content ?? "") === undefined) {
            return { status: 200 };
        }
        if (prior.entry !== null && priorBody !== undefined && priorHeader !== undefined) {
            try {
                if (await Http.#reusableGetRepresentation(prior.entry, requestHeaders, ctx.projection)) {
                    cached = prior.entry;
                    if (Http.#materializerIdentity(priorHeader.content) === undefined) {
                        conditional.push(...Http.#validators(priorHeader.content));
                    }
                }
            } catch (cause) {
                return Http.#materializationFailure(
                    url,
                    "GET",
                    new WebMaterializationError(Http.#sourceMimetype(priorHeader.content), cause),
                );
            }
        }
        if (cached !== undefined && Http.#fresh(cached.channels[HEADER]!.content)) {
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
                return Http.#cancelled(url, "GET");
            }
            throw error;
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

        if (fetched.status === 304) {
            if (cached === undefined) {
                return Http.#bad(
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
            if (Http.#materializerIdentity(cachedHeader) !== undefined) {
                return Http.#bad(
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
            if (Http.#revalidationCorresponds(
                cachedHeader,
                new Headers(responseHeaders.map(([name, value]) => [name, value])),
            )) {
                const channels: EntryData["channels"] = {
                    ...cached.channels,
                    [HEADER]: {
                        ...cached.channels[HEADER]!,
                        content: Http.#refreshAfter304(cachedHeader, responseHeaders, requestHeaders),
                    },
                };
                const written = await ctx.entries.write(pathname, {
                    channels,
                });
                if (Results.isErrorStatus(written.status)) return Http.#passthrough(written);
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
                    return Http.#cancelled(url, "GET");
                }
                throw error;
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
            if (fetched.status === 304) {
                return Http.#bad(
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
            if (ctx.signal?.aborted === true) return Http.#cancelled(url, "GET");
            if (error instanceof WebMaterializationError) {
                return Http.#materializationFailure(url, "GET", error);
            }
            throw error;
        }
        if (materialized === null) {
            return Http.#bad(
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
        if (Results.isErrorStatus(written.status)) return Http.#passthrough(written);
        await this.#piggybackLlmsText(address, ctx);
        return { status: 200 };
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
        const written = await ctx.entries.write(address.pathname, Http.#seedEntry());
        if (Results.isErrorStatus(written.status)) return Http.#passthrough(written);
        const subscription = await ctx.subscriptions.open(address.pathname, handle);
        if (fetched.header !== undefined) {
            await subscription.notifyChunk(HEADER, fetched.header, "text/plain");
        }
        void Http.#settleEventStream(subscription, response, {
            url: address.url,
            method: "GET",
            signal: local.signal,
            errorDetailLimit: this.#errorDetailLimit,
        }).catch((error: unknown) => {
            console.error("HTTP SSE terminal cleanup failed", { url: address.url, error });
        });
        return { shape: "passthrough", status: 102 };
    }

    // EDIT -> PUT the body (full-resource replace). `<L>` has no meaning against a
    // remote resource - reject rather than silently ignore the model's intent.
    async editBatch(statements: readonly ResolvedEditStatement[], ctx: SchemeCtx): Promise<PassthroughResult> {
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
        return this.#request(statement.target, statement.metadata, ctx, "PUT", statement.body ?? "");
    }

    async edit(statement: ResolvedEditStatement, ctx: SchemeCtx): Promise<PassthroughResult> {
        return this.editBatch([statement], ctx);
    }

    // KILL -> DELETE the resource. Distinct from SEND signal 410 (which drops the local
    // cached entry): KILL is an HTTP DELETE request to the remote.
    async kill(statement: KillStatement, ctx: SchemeCtx): Promise<PassthroughResult> {
        if (statement.target === null || statement.target.kind !== "url") {
            return Http.#bad(400, "http", "bad-target", "KILL requires an http(s):// URL target.", {
                stage: "target-validation",
                recovery: "Provide an http(s):// URL target.",
                retryable: false,
            });
        }
        return this.#request(statement.target, statement.metadata, ctx, "DELETE", statement.body ?? undefined);
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
            return this.#request(statement.target, statement.metadata, ctx, "POST", body);
        }
        if (statement.metadata !== null) {
            return Http.#bad(
                400,
                "http",
                "metadata-not-applicable",
                `HTTP SEND status ${status} does not issue a request, so it does not accept {metadata}.`,
                { requestedStatus: status, retryable: false },
            );
        }
        if (status === 410) {
            const address = Http.#address(statement.target);
            if (!(address instanceof NetworkAddress)) return address;
            return Http.#passthrough(await ctx.entries.delete(address.pathname));
        }
        if (status === 499) {
            // Cancellation is routed by the engine to the subscription's
            // SubscriptionHandle.cancel (registered by #request). Nothing
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

    // Mutation responses use the same entry/channel and subscription primitives
    // as every live producer; GET acquisition belongs solely to
    // prepareRepresentation.
    async #request(
        target: UrlPath,
        metadata: readonly string[] | null,
        ctx: SchemeCtx,
        method: string,
        body: string | undefined,
    ): Promise<PassthroughResult> {
        const address = Http.#address(target);
        if (!(address instanceof NetworkAddress)) return address;
        const { url } = address;
        const { pathname } = address;
        const headers = Http.#requestHeaders(metadata);
        if (!Array.isArray(headers)) return headers;
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

        // Local AbortController for force-cancel from outside (SEND signal 499).
        const local = new AbortController();
        const handle: SubscriptionHandle = { cancel: () => local.abort() };

        // {§http-lifecycle} open() binds an existing entry, so the handler seeds
        // its manifest-owned channel shape before subscribing.
        const written = await ctx.entries.write(pathname, Http.#seedEntry());
        if (Results.isErrorStatus(written.status)) return Http.#passthrough(written);

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
            subscription.removeEventListener("abort", onAbort);
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
        return { channels };
    }

    // {§revalidation} The body and header must have settled successfully. An
    // auxiliary channel may have terminally failed without invalidating body.
    static #representationComplete(entry: StoredEntryData): boolean {
        const bodyState = entry.channels[BODY]?.state;
        const headerState = entry.channels[HEADER]?.state;
        const successful = (state: ChannelState | undefined): boolean => state === "static" || state === "closed";
        const terminal = (state: ChannelState): boolean => successful(state) || state === "errored";
        return successful(bodyState)
            && successful(headerState)
            && Object.values(entry.channels).every(({ state }) => terminal(state));
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
        if (body === undefined || header === undefined) return false;
        return Http.#representationComplete(entry)
            && Http.#requestMethod(header.content) === "GET"
            && requestHeaders.length === 0
            && Http.#cacheVariant(header.content) === "default"
            && !Http.#storedCachePolicy(header.content).noStore
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
        await subscription.notifyChunk(
            HEADER,
            Http.#responseHeader(method, status, statusText, responseHeaders, requestHeaders),
            "text/plain",
        );
    }

    static #responseHeader(
        method: string,
        status: number,
        statusText: string,
        responseHeaders: ReadonlyArray<readonly [string, string]>,
        requestHeaders: ReadonlyArray<readonly [string, string]>,
    ): string {
        const lines = [`HTTP ${status} ${statusText}`];
        for (const [k, v] of responseHeaders) lines.push(`${k}: ${v}`);
        lines.push(`${REQUEST_METHOD}: ${method}`);
        lines.push(`${FETCHED_AT}: ${new Date().toISOString()}`);
        lines.push(cacheVariantEvidence(classifyCacheVariant(requestHeaders, responseHeaders)));
        return lines.join("\n");
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
            if (options.signal.aborted) {
                const result = Http.#cancelled(options.url, options.method);
                await subscription.close(result, result.problem?.detail);
                return;
            }
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

    static #requestHeaders(
        metadata: readonly string[] | null,
    ): Array<[string, string]> | (PassthroughResult & ChannelProducerResult) {
        if (metadata === null) return [];
        const headers: Array<[string, string]> = [];
        for (const [index, block] of metadata.entries()) {
            const colon = block.indexOf(":");
            if (colon < 0) {
                return Http.#bad(
                    400,
                    "http",
                    "metadata-header-shape",
                    `HTTP metadata block ${index + 1} requires a header name and ':' separator.`,
                    { block: index + 1, retryable: false },
                );
            }
            const name = block.slice(0, colon).trim();
            if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) {
                return Http.#bad(
                    400,
                    "http",
                    "metadata-header-name",
                    `HTTP metadata block ${index + 1} has an invalid header name.`,
                    { block: index + 1, retryable: false },
                );
            }
            headers.push([name, block.slice(colon + 1).trim()]);
        }
        return headers;
    }

    // {§revalidation} Validation-free reuse requires both the operator's local
    // ceiling and the origin's response policy to remain live.
    static #fresh(header: string, now = Date.now()): boolean {
        const fetchedAt = Http.#fetchedAt(header);
        const ttl = requireNumEnv("PLURNK_SCHEMES_HTTP_TTL_MS");
        if (fetchedAt === undefined || ttl <= 0) return false;
        const residentTime = Math.max(0, now - fetchedAt);
        if (residentTime >= ttl) return false;
        const policy = Http.#storedCachePolicy(header);
        if (policy.noStore || policy.noCache) return false;
        return policy.freshnessLifetimeMs === undefined
            || Http.#currentAge(header, fetchedAt, now) < policy.freshnessLifetimeMs;
    }

    // Package metadata is appended after origin headers, so the last value wins.
    static #fetchedAt(priorHeader: string): number | undefined {
        const value = lastHeaderValue(priorHeader, FETCHED_AT);
        if (value === undefined) return undefined;
        const ms = Date.parse(value);
        return Number.isNaN(ms) ? undefined : ms;
    }

    static #headerField(line: string): HeaderField | null {
        const colon = line.indexOf(":");
        if (colon < 0) return null;
        const name = line.slice(0, colon).trim().toLowerCase();
        if (name.length === 0) return null;
        return { name, value: line.slice(colon + 1).trim(), line };
    }

    static #packageStart(lines: readonly string[]): number {
        let stampIndex = -1;
        for (const [index, line] of lines.entries()) {
            if (Http.#headerField(line)?.name === FETCHED_AT) stampIndex = index;
        }
        if (stampIndex < 0) return lines.length;
        return Http.#headerField(lines[stampIndex - 1] ?? "")?.name === REQUEST_METHOD
            ? stampIndex - 1
            : stampIndex;
    }

    static #originFields(header: string): HeaderField[] {
        const lines = header.split(/\r?\n/);
        return lines.slice(1, Http.#packageStart(lines))
            .map((line) => Http.#headerField(line))
            .filter((field): field is HeaderField => field !== null);
    }

    static #originValues(fields: readonly HeaderField[], name: string): string[] {
        return fields.filter((field) => field.name === name).map(({ value }) => value);
    }

    static #storedCachePolicy(header: string): StoredCachePolicy {
        const fields = Http.#originFields(header);
        const directives = Http.#originValues(fields, "cache-control")
            .flatMap((value) => splitHttpList(value))
            .map((member) => cacheDirective(member))
            .filter((directive): directive is NonNullable<typeof directive> => directive !== null);
        const maxAges = directives.filter(({ name }) => name === "max-age");
        let freshnessLifetimeMs: number | undefined;
        if (maxAges.length > 0) {
            freshnessLifetimeMs = maxAges.length === 1
                ? deltaMilliseconds(maxAges[0]!.argument) ?? 0
                : 0;
        } else {
            const expiresValues = Http.#originValues(fields, "expires");
            if (expiresValues.length > 0) {
                const expires = expiresValues.length === 1
                    ? httpDate(expiresValues[0]!)
                    : null;
                const fetchedAt = Http.#fetchedAt(header);
                if (expires === null || fetchedAt === undefined) {
                    freshnessLifetimeMs = 0;
                } else {
                    const dateValues = Http.#originValues(fields, "date");
                    const parsedDate = dateValues.length === 1
                        ? httpDate(dateValues[0]!)
                        : null;
                    const generatedAt = parsedDate ?? fetchedAt;
                    freshnessLifetimeMs = Math.max(0, expires - generatedAt);
                }
            }
        }
        return {
            noStore: directives.some(({ name }) => name === "no-store"),
            noCache: directives.some(({ name }) => name === "no-cache"),
            ...(freshnessLifetimeMs === undefined ? {} : { freshnessLifetimeMs }),
        };
    }

    static #currentAge(header: string, fetchedAt: number, now: number): number {
        const fields = Http.#originFields(header);
        const dateValues = Http.#originValues(fields, "date");
        const date = dateValues.length === 1 ? httpDate(dateValues[0]!) : null;
        const apparentAge = date === null ? 0 : Math.max(0, fetchedAt - date);
        const ageMember = Http.#originValues(fields, "age").flatMap(splitHttpList)[0];
        const ageValue = deltaMilliseconds(ageMember) ?? 0;
        return Math.max(apparentAge, ageValue) + Math.max(0, now - fetchedAt);
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

    static #materializerIdentity(priorHeader: string): string | undefined {
        return Http.#packageHeaderValue(priorHeader, MATERIALIZER_ID_HEADER);
    }

    static #cacheVariant(priorHeader: string): CacheVariant | undefined {
        const value = Http.#packageHeaderValue(priorHeader, CACHE_VARIANT_HEADER);
        return value === "default" || value === "bypass" ? value : undefined;
    }

    static #sourceMimetype(header: string): string {
        return responseMimetype(lastHeaderValue(header, "content-type") ?? null);
    }

    static async #projectionCurrent(header: string, projection: ProjectionCaps): Promise<boolean> {
        const sourceMimetype = Http.#sourceMimetype(header);
        const isHtml = MimetypeClassifier.isHtml(sourceMimetype);
        const materializerIdentity = Http.#materializerIdentity(header);
        if (materializerIdentity !== undefined) {
            // {§http-materializer-plugins} — a stored body produced by the current
            // configured materializer (or the built-in producers) is current.
            return WebFetcher.materializerCurrent(materializerIdentity);
        }
        if (isHtml && materializerIdentity === undefined) return false;
        const storedIdentity = Http.#projectionIdentity(header);
        if (storedIdentity === undefined) return !isHtml;
        return await projection.identity(sourceMimetype) === storedIdentity;
    }

    // RFC 9111 §3.2 permits a processed cache to retain the metadata that its
    // stored body depends upon. Other 304 fields update by name; package-owned
    // evidence is then rebuilt after the origin block. {§revalidation}
    static #refreshAfter304(
        header: string,
        responseHeaders: ReadonlyArray<readonly [string, string]>,
        requestHeaders: ReadonlyArray<readonly [string, string]>,
    ): string {
        const lines = header.split(/\r?\n/);
        const origin = Http.#originFields(header);
        const updates = responseHeaders.filter(
            ([name]) => !BODY_PROCESSING_FIELDS.has(name.toLowerCase()),
        );
        const updatedNames = new Set(updates.map(([name]) => name.toLowerCase()));
        const retained = origin.filter(({ name }) => !updatedNames.has(name));
        const merged: Array<readonly [string, string]> = [
            ...retained.map(({ name, value }) => [name, value] as const),
            ...updates,
        ];
        // Materializer/provider evidence headers are plugin-owned (unknown names);
        // a 304 does not re-materialize the stored body, so its evidence is
        // retained verbatim beside the rebuilt framework fields. Framework-owned
        // x-plurnk-* fields (cache-variant, materializer/projection ids, method,
        // fetched-at stamp) are rebuilt or omitted, never duplicated stale.
        const rebuilt = [MATERIALIZER_ID_HEADER, PROJECTION_ID_HEADER].flatMap((field) => {
            const value = Http.#packageHeaderValue(header, field);
            return value === undefined ? [] : [`${field}: ${value}`];
        });
        const frameworkOwned = new Set([
            CACHE_VARIANT_HEADER.toLowerCase(),
            MATERIALIZER_ID_HEADER.toLowerCase(),
            PROJECTION_ID_HEADER.toLowerCase(),
            REQUEST_METHOD.toLowerCase(),
            FETCHED_AT.toLowerCase(),
        ]);
        const packageEvidence = [
            ...rebuilt,
            ...lines.slice(1).filter((line) => {
                const colon = line.indexOf(":");
                if (colon <= 0) return false;
                const name = line.slice(0, colon).toLowerCase();
                return name.startsWith("x-plurnk-")
                    && !frameworkOwned.has(name)
                    && !updatedNames.has(name);
            }),
        ];
        return [
            lines[0] ?? "HTTP 200 OK",
            ...retained.map(({ line }) => line),
            ...updates.map(([name, value]) => `${name}: ${value}`),
            `${REQUEST_METHOD}: GET`,
            `${FETCHED_AT}: ${new Date().toISOString()}`,
            cacheVariantEvidence(classifyCacheVariant(requestHeaders, merged)),
            ...packageEvidence,
        ].join("\n");
    }

    static #revalidationCorresponds(priorHeader: string, responseHeaders: Headers): boolean {
        const fields = Http.#originFields(priorHeader);
        const responseTagValue = responseHeaders.get("etag");
        if (responseTagValue !== null) {
            const storedTagValues = Http.#originValues(fields, "etag");
            const responseTag = entityTag(responseTagValue);
            const storedTag = storedTagValues.length === 1
                ? entityTag(storedTagValues[0]!)
                : null;
            if (responseTag === null || storedTag === null) return false;
            // {§revalidation} — If-None-Match correspondence is a weak
            // comparison (RFC 9110 §8.8.3.2): opaque tags match regardless of
            // the W/ prefix, so an origin that upgrades a stored weak etag to
            // a strong etag on the 304 still corresponds.
            return responseTag.opaque === storedTag.opaque;
        }

        const responseModifiedValue = responseHeaders.get("last-modified");
        const storedModifiedValues = Http.#originValues(fields, "last-modified");
        const responseModified = responseModifiedValue === null
            ? null
            : httpDate(responseModifiedValue);
        const storedModified = storedModifiedValues.length === 1
            ? httpDate(storedModifiedValues[0]!)
            : null;
        return responseModified !== null
            && storedModified !== null
            && responseModified === storedModified;
    }

    // Conditional-request headers from the prior fetch's stored response headers
    // (the HEADER channel text #writeHeader wrote): ETag → If-None-Match,
    // Last-Modified → If-Modified-Since. Empty when neither is present — the
    // origin then just 200s with a full body, which is correct.
    static #validators(priorHeader: string): Array<[string, string]> {
        const fields = Http.#originFields(priorHeader);
        const out: Array<[string, string]> = [];
        const etags = Http.#originValues(fields, "etag");
        if (etags.length === 1 && entityTag(etags[0]!) !== null) {
            out.push(["If-None-Match", etags[0]!]);
        }
        const lastModified = Http.#originValues(fields, "last-modified");
        if (lastModified.length === 1 && httpDate(lastModified[0]!) !== null) {
            out.push(["If-Modified-Since", lastModified[0]!]);
        }
        return out;
    }

    static #passthrough(result: SchemeResult): PassthroughResult & ChannelProducerResult {
        return Results.assertChannelProducerResult(
            { ...result, shape: "passthrough" } as PassthroughResult & ChannelProducerResult,
        );
    }

    static #cancelled(url: string, method: string): PassthroughResult & ChannelProducerResult {
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
    ): PassthroughResult & ChannelProducerResult {
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
        return Http.#bad(
            500,
            "http",
            "projection-failed",
            `HTTP ${method} ${url} acquired content, but its readable projection failed.`,
            {
                target: url,
                method,
                mimetype: error.mimetype,
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
    ): PassthroughResult & ChannelProducerResult {
        return Results.failure(
            `scheme:${scheme}`,
            kind,
            status,
            message,
            { shape: "passthrough" },
            extensions,
        ) as PassthroughResult & ChannelProducerResult;
    }
}
