// HTTP(S) handler. Operation-to-method semantics live in {§op-surface};
// acquisition, materialization, publication, and query flow live in
// {§http-lifecycle}. The implementation depends only on SchemeCtx capabilities.

import { createParser, type ParseError } from "eventsource-parser";
import type { SchemeCtx, StreamSubscription, ChannelProducerResult, PassthroughResult, SchemeManifest, SchemeHandler, RepresentationPreparationRequest, RepresentationPreparationResult, SendStatement, ResolvedEditStatement, KillStatement, UrlPath, EntryData, StoredEntryData, SchemeResult, ProjectionCaps, ChannelState } from "@plurnk/plurnk-schemes";
import { MimetypeClassifier, NetworkAddress, ProjectionInputLimitError, Results } from "@plurnk/plurnk-schemes";
import { readFile } from "node:fs/promises";
import ErrorDetail from "./ErrorDetail.ts";
import WebFetcher, { CACHE_VARIANT_HEADER, MATERIALIZER_ID_HEADER, PROJECTION_ID_HEADER, cacheVariantEvidence, classifyCacheVariant, WebMaterializationError, type CacheVariant } from "./WebFetcher.ts";
import { responseMimetype } from "./ContentType.ts";
import { requireNonNegativeIntegerEnv as requireNumEnv } from "./Config.ts";
import { BODY, FETCHED_AT, HEADER, REQUEST_METHOD } from "./http-names.ts";
import HttpGet from "./HttpGet.ts";
import HttpRequester from "./HttpRequester.ts";
import LiveAcquisitions from "./LiveAcquisitions.ts";

// The channel the response body streams into, and the header metadata channel.
// Package-owned metadata appended after untrusted origin headers. Readers take
// the last value so an origin using the same field name cannot override it.
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
            "## SEND0 (https://api.example.com/v1/pets) {Content-Type: application/json}",
            '{"name":"Mango","status":"available"}',
        ].join("\n"),
        documentation,
        traits: ["web"],
    };

    readonly #errorDetailLimit: number;
    readonly #webFetcher: WebFetcher;
    // {§http-llms-txt} — one opportunistic origin-companion attempt per TTL
    // window; success and failure share the timer so a 404 does not re-probe
    // on every READ.
    readonly #get: HttpGet;
    readonly #requester: HttpRequester;
    readonly #live = new LiveAcquisitions();
    constructor() {
        this.#errorDetailLimit = ErrorDetail.configuredLimit();
        this.#webFetcher = new WebFetcher();
        this.#get = new HttpGet({ live: this.#live, errorDetailLimit: this.#errorDetailLimit, webFetcher: this.#webFetcher, address: Http.#address, requestHeaders: Http.#requestHeaders, passthrough: Http.#passthrough, requestMethod: Http.#requestMethod, reusableGetRepresentation: Http.#reusableGetRepresentation, materializerIdentity: Http.#materializerIdentity, validators: Http.#validators, materializationFailure: Http.#materializationFailure, sourceMimetype: Http.#sourceMimetype, fresh: Http.#fresh, cancelled: Http.#cancelled, bad: Http.#bad, revalidationCorresponds: Http.#revalidationCorresponds, refreshAfter304: Http.#refreshAfter304, seedEntry: Http.#seedEntry, settleEventStream: Http.#settleEventStream });
        this.#requester = new HttpRequester({ live: this.#live, manifest: Http.manifest, errorDetailLimit: this.#errorDetailLimit, address: Http.#address, requestHeaders: Http.#requestHeaders, bad: Http.#bad, seedEntry: Http.#seedEntry, passthrough: Http.#passthrough, writeHeader: Http.#writeHeader, writeProjectionIdentity: Http.#writeProjectionIdentity, cancelled: Http.#cancelled, materializationFailure: Http.#materializationFailure });
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
        return this.#get.prepareGet(request.target, request.metadata, request.pathname, ctx);
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
        return this.#requester.request(statement.target, statement.metadata, ctx, "PUT", statement.body ?? "");
    }

    async edit(statement: ResolvedEditStatement, ctx: SchemeCtx): Promise<PassthroughResult> {
        return this.editBatch([statement], ctx);
    }

    // {§http-kill} — KILL follows the entry rule: a live acquisition of the address is
    // cancelled, otherwise the stored response is forgotten. The remote DELETE is its own
    // spelling, `## KILL0 (https://…) {remote}`; any other metadata blocks are its headers.
    async kill(statement: KillStatement, ctx: SchemeCtx): Promise<PassthroughResult> {
        if (statement.target === null || statement.target.kind !== "url") {
            return Http.#bad(400, "http", "bad-target", "KILL requires an http(s):// URL target.", {
                stage: "target-validation",
                recovery: "Provide an http(s):// URL target.",
                retryable: false,
            });
        }
        const blocks = statement.metadata ?? [];
        const remote = blocks.some((block) => block.trim() === "remote");
        if (remote) {
            const headers = blocks.filter((block) => block.trim() !== "remote");
            return this.#requester.request(statement.target, headers.length === 0 ? null : headers, ctx, "DELETE", undefined);
        }
        const address = Http.#address(statement.target);
        if (!(address instanceof NetworkAddress)) return address;
        if (this.#live.cancel(LiveAcquisitions.key(ctx.workerId, address.url))) {
            // The owner settles itself as cancelled through its aborted signal.
            return { shape: "passthrough", status: 200 };
        }
        return Http.#passthrough(await ctx.entries.delete(address.pathname));
    }

    // SEND dispatch — a recipient SEND with a body is the POST; a disposition label never
    // reaches a scheme, and any other status is refused 501 ({§send-label}).
    async send(statement: SendStatement, ctx: SchemeCtx): Promise<PassthroughResult> {
        if (statement.target === null || statement.target.kind !== "url") {
            return Http.#bad(400, "http", "bad-target", "SEND requires an http(s):// URL target.", {
                stage: "target-validation",
                recovery: "Provide an http(s):// URL target.",
                retryable: false,
            });
        }
        // A recipient SEND with a body posts it ({§send-label}: dispositions never reach a scheme).
        if (statement.status === null) {
            const body = statement.body?.raw ?? "";
            return this.#requester.request(statement.target, statement.metadata, ctx, "POST", body);
        }
        const status = statement.status;
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
                    retryable: false,
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
