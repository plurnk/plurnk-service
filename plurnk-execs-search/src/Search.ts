import { BaseExecutor, ErrorDetail, Results } from "@plurnk/plurnk-execs";
import type { ChannelDecl, Effect, ExecArgs, ExecResult, RuntimeAvailability } from "@plurnk/plurnk-execs";

// Runtime tag → SearXNG `categories=` value. The flat tag set this sibling
// claims (package.json `plurnk.runtimes[]`) maps 1:1 onto SearXNG's category
// tabs (`categories_as_tabs` in its settings.yml). `search` is the general
// default; `social` and `downloadable` are honest renamings of SearXNG's
// "social media" and "files" categories. Engine / language / time selection
// rides the query string via SearXNG's native `!bang` / `:lang` syntax.
const CATEGORY: Readonly<Record<string, string>> = Object.freeze({
    search: "general",
    images: "images",
    videos: "videos",
    news: "news",
    map: "map",
    music: "music",
    it: "it",
    science: "science",
    social: "social media",
    downloadable: "files",
});

const preview = (query: string, maximum?: number): string => (
    maximum !== undefined && query.length > maximum
        ? `${query.slice(0, maximum)}...`
        : query
);

// Deterministic query slug — the tag tying a search's prefetched entries
// together. Full slugified query, no locally-invented length cap.
const slugify = (query: string): string => query.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// The configured SearXNG base URL, or null if unusable — trimmed and validated,
// NOT merely truthy: a blank/whitespace/malformed value (an env floor easily
// emits `URL= ` with a trailing space) must read as unconfigured. Truthy-only
// checks let " " through, and `new URL("/search", " ")` then throws uncaught,
// so the worker never resolves nor times out.
interface SearxngConfig {
    base: URL;
    authorization?: string;
}

const searxngConfig = (): SearxngConfig | null => {
    const u = (process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL ?? "").trim();
    if (!u || !URL.canParse(u)) return null;
    const base = new URL(u);
    let username: string;
    let password: string;
    try {
        username = decodeURIComponent(base.username);
        password = decodeURIComponent(base.password);
    } catch {
        return null;
    }
    base.username = "";
    base.password = "";
    return {
        base,
        ...(username || password
            ? { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
            : {}),
    };
};

// The signal fields of a SearXNG result — everything else it returns (template,
// engine internals, score, parsed_url, positions) is noise the model can't use.
interface SearxngResult {
    title?: string;
    url?: string;
    content?: string;
    publishedDate?: string;
}

const configuredInteger = (
    raw: string | undefined,
    minimum: number,
): number | null | undefined => {
    if (raw === undefined || raw === "") return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= minimum ? value : null;
};

// Web search executor (the first non-subprocess runtime). Dispatches a query to
// a configured SearXNG instance and writes a compact digest of its results
// (title + url + snippet) to the `results` channel. Stateless: configuration
// comes from the environment, read per worker.
//
//   PLURNK_EXECS_SEARCH_SEARXNG_URL   (required)  base URL of the instance
//   PLURNK_EXECS_SEARCH_LANGUAGE      (optional)  SearXNG's own default if unset
//   PLURNK_EXECS_SEARCH_LIMIT         (optional)  client-side result cap; keep-all if unset
//   PLURNK_EXECS_SEARCH_TIMEOUT       (optional)  ms; consumer cancellation is primary
//                                                 ({§executor-cancellation}); this is an extra ceiling
//   PLURNK_EXECS_SEARCH_SAFESEARCH    (optional)  0|1|2
//   PLURNK_EXECS_SEARCH_SNIPPET       (optional)  max chars per result snippet; unbounded if unset
//   PLURNK_EXECS_SEARCH_QUERY_PREVIEW (optional)  max chars in error facts; unbounded if unset
//   PLURNK_EXECS_SEARCH_RAW           (optional)  truthy → emit the verbatim SearXNG payload (debug;
//                                                 skips the prefetch pass entirely)
// No code default hides a magic number; suggested values ship in this package's
// .env.defaults. Page-fetch knobs belong to the consumer because the executor
// never fetches ({§executor-entry-sink}).
//
// Page prefetch ({§executor-entry-sink}): the executor emits the ranked
// discovery digest but NEVER fetches — it hands each candidate URL
// to the consumer's entry() as a consumer-sourced prefetch request. The
// consumer fetches/renders/materializes the https:// entry; resolve/reject
// becomes the row's materialized verdict. Rejected candidates are removed while
// surviving rows preserve SearXNG rank. Successful page bodies live in ordinary
// entries; schemes-http owns the guarded fetch/render.
export default class Search extends BaseExecutor {
    get channels(): Readonly<Record<string, ChannelDecl>> {
        return { results: { mimetype: "application/json" } };
    }

    // Available iff a SearXNG instance is configured. This is a config check,
    // not a reachability ping — boot answers "is search set up?"; live
    // reachability is the worker path's job (it emits searxng_unreachable).
    override async probe(): Promise<RuntimeAvailability> {
        const config = searxngConfig();
        return config
            ? { available: true, detail: config.base.toString() }
            : { available: false, detail: "PLURNK_EXECS_SEARCH_SEARXNG_URL is not set to a valid URL" };
    }

    // Search reads external state without mutating the host.
    override effect(_target: string | null): Effect {
        return "read";
    }

    async run({ runtime, command, signal, write, setState, emit, entry }: ExecArgs): Promise<ExecResult> {
        const category = CATEGORY[runtime];
        // A tag we never claimed means the scheme misrouted — a contract
        // violation, not an expected runtime failure. Fail hard.
        if (category === undefined) throw new Error(`plurnk-execs-search received unclaimed runtime tag '${runtime}'`);

        const query = command.trim();
        const fail = (
            kind: string,
            message: string,
            status = 500,
            extensions: Readonly<Record<string, unknown>> = {},
        ): ExecResult => {
            setState("results", "errored");
            return Results.failure(
                "executor:search",
                kind,
                status,
                message,
                {},
                {
                    runtime,
                    stage: "search",
                    ...extensions,
                },
            );
        };

        const queryPreviewRaw = process.env.PLURNK_EXECS_SEARCH_QUERY_PREVIEW;
        const queryPreviewMax = configuredInteger(queryPreviewRaw, 0);
        const errorDetailLimit = ErrorDetail.configuredLimit();
        if (errorDetailLimit === null) {
            setState("results", "errored");
            return ErrorDetail.invalidConfiguration("executor:search");
        }
        if (queryPreviewMax === null) {
            return fail(
                "invalid-configuration",
                "PLURNK_EXECS_SEARCH_QUERY_PREVIEW must be a non-negative integer.",
                500,
                {
                    stage: "configuration",
                    configuration: "PLURNK_EXECS_SEARCH_QUERY_PREVIEW",
                    retryable: false,
                },
            );
        }

        // External bangs (`!!`) redirect to an upstream site instead of
        // returning JSON — incompatible with this declared results channel
        // ({§executor-channels}).
        if (query.startsWith("!!")) {
            return fail(
                "external-bang-refused",
                "Search cannot return ranked results for an external bang query.",
                400,
                {
                    query: preview(query, queryPreviewMax),
                    recovery: "Use a results-producing search query.",
                    retryable: false,
                },
            );
        }

        const config = searxngConfig();
        if (config === null) {
            return fail(
                "searxng-not-configured",
                "The SearXNG endpoint is not configured with a valid URL.",
                501,
                {
                    configuration: "PLURNK_EXECS_SEARCH_SEARXNG_URL",
                    retryable: false,
                },
            );
        }

        // All tunables are optional env overrides — no code default hides a
        // magic number (suggested values live in the consumer's .env.example).
        const language = process.env.PLURNK_EXECS_SEARCH_LANGUAGE;
        const engines = process.env.PLURNK_EXECS_SEARCH_ENGINES;
        const limitRaw = process.env.PLURNK_EXECS_SEARCH_LIMIT;
        const timeoutRaw = process.env.PLURNK_EXECS_SEARCH_TIMEOUT;
        const safesearch = process.env.PLURNK_EXECS_SEARCH_SAFESEARCH;
        const snippetRaw = process.env.PLURNK_EXECS_SEARCH_SNIPPET;
        const limit = configuredInteger(limitRaw, 0);
        const timeoutMs = configuredInteger(timeoutRaw, 1);
        const snippetMax = configuredInteger(snippetRaw, 0);
        if (limit === null || timeoutMs === null || snippetMax === null) {
            const invalidConfiguration = limit === null
                ? "PLURNK_EXECS_SEARCH_LIMIT"
                : timeoutMs === null
                    ? "PLURNK_EXECS_SEARCH_TIMEOUT"
                    : "PLURNK_EXECS_SEARCH_SNIPPET";
            return fail(
                "invalid-configuration",
                `${invalidConfiguration} must be ${invalidConfiguration === "PLURNK_EXECS_SEARCH_TIMEOUT" ? "a positive" : "a non-negative"} integer.`,
                500,
                {
                    stage: "configuration",
                    configuration: invalidConfiguration,
                    retryable: false,
                },
            );
        }

        const url = new URL("/search", config.base);
        url.searchParams.set("q", query);
        url.searchParams.set("format", "json");
        url.searchParams.set("categories", category);
        if (language) url.searchParams.set("language", language);
        if (engines) url.searchParams.set("engines", engines);
        if (safesearch) url.searchParams.set("safesearch", safesearch);

        // The consumer's signal is the primary deadline ({§executor-cancellation}); an optional search
        // timeout adds a local ceiling on top of it.
        // A malformed TIMEOUT is the same throw-class: AbortSignal.timeout(NaN)
        // throws, so only arm the extra ceiling for a finite positive value.
        const fetchSignal = timeoutMs !== undefined
            ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
            : signal;
        let response: Response;
        try {
            response = await fetch(url, {
                signal: fetchSignal,
                ...(config.authorization ? { headers: { Authorization: config.authorization } } : {}),
            });
        } catch (err) {
            // Caller cancellation is normal flow, not Notice-worthy.
            if (signal.aborted) {
                setState("results", "errored");
                return Results.failure(
                    "executor:search",
                    "cancelled",
                    499,
                    "Search execution was cancelled.",
                    {},
                    {
                        runtime,
                        stage: "search",
                        retryable: false,
                    },
                );
            }
            const e = err as { name?: string; code?: string; cause?: { code?: string; message?: string } };
            if (e.name === "TimeoutError") {
                return fail(
                    "searxng-timeout",
                    `The SearXNG request exceeded its ${timeoutMs}-millisecond deadline.`,
                    504,
                    {
                        host: url.host,
                        query: preview(query, queryPreviewMax),
                        timeoutMilliseconds: timeoutMs,
                        retryable: true,
                    },
                );
            }
            // Node's fetch throws a bare "fetch failed" and tucks the real
            // reason under err.cause — surface it so logs say ENOTFOUND /
            // ECONNREFUSED / CERT_* rather than nothing actionable.
            const code = e.cause?.code ?? e.code ?? "UNKNOWN";
            const detail = ErrorDetail.preview(
                e.cause?.message ?? (err as Error).message,
                errorDetailLimit,
            );
            return fail(
                "searxng-unreachable",
                `The SearXNG endpoint at ${url.host} could not be reached: ${detail}.`,
                502,
                {
                    host: url.host,
                    query: preview(query, queryPreviewMax),
                    upstreamCode: code,
                    retryable: true,
                },
            );
        }

        if (!response.ok) {
            const statusText = response.statusText
                ? ` ${ErrorDetail.preview(response.statusText, errorDetailLimit)}`
                : "";
            return fail(
                "searxng-http-error",
                `The SearXNG endpoint returned HTTP ${response.status}${statusText}.`,
                502,
                {
                    host: url.host,
                    query: preview(query, queryPreviewMax),
                    upstreamStatus: response.status,
                    retryable: response.status === 408 || response.status === 429 || response.status >= 500,
                },
            );
        }

        let data: { results?: SearxngResult[] };
        try {
            data = await response.json() as { results?: SearxngResult[] };
        } catch (err) {
            console.error(`SearXNG at ${url.host} returned invalid JSON:`, err);
            return fail(
                "searxng-invalid-response",
                "The SearXNG endpoint returned a response that was not valid JSON.",
                502,
                {
                    host: url.host,
                    retryable: true,
                },
            );
        }
        if (data.results !== undefined && !Array.isArray(data.results)) {
            return fail(
                "searxng-invalid-response",
                "The SearXNG response has a non-array results field.",
                502,
                {
                    host: url.host,
                    retryable: true,
                },
            );
        }
        const capped = (data.results ?? []).slice(0, limit ?? undefined);

        // Debug escape hatch: the verbatim SearXNG payload, no prefetch pass.
        if (process.env.PLURNK_EXECS_SEARCH_RAW) {
            write("results", JSON.stringify(capped));
            setState("results", "closed");
            return { status: 200 };
        }

        // Page prefetch ({§executor-entry-sink}): hand each candidate URL to the
        // consumer's entry() as a prefetch request (content null ⇒
        // consumer-sourced). The executor never fetches. A rejection removes
        // that row from the model-facing digest; surviving rows retain SearXNG
        // order. Deduped by URL; without the sink no verdict exists, so
        // `materialized` is omitted.
        const slug = slugify(query);
        const unique = [...new Map(capped.filter((r) => r.url).map((r) => [r.url!, r])).values()];
        let completed = 0;
        let materialized = 0;
        const reportProgress = (phase: "fetching" | "complete"): void => {
            const total = unique.length;
            const percent = total === 0 ? 100 : Math.floor((completed / total) * 100);
            emit({
                source: `exec:${runtime}`,
                kind: "search_progress",
                level: "info",
                message: phase === "complete"
                    ? `search acquisition complete: ${materialized}/${total} pages materialized`
                    : `acquiring search results: ${percent}% (${completed}/${total})`,
                phase,
                completed,
                total,
                materialized,
                rejected: completed - materialized,
                percent,
            });
        };
        if (entry && unique.length > 0) reportProgress("fetching");
        const verdicts = await Promise.all(unique.map(async (r) => {
            if (!entry) return r.url!;
            let address: string | null = null;
            try {
                address = await entry(r.url!, null, { tags: [slug] });
            } catch {
                address = null;
            } finally {
                completed++;
                if (address !== null) materialized++;
                // At most ~10 intermediate notices regardless of result count,
                // plus start and terminal. Progress is aggregate: no URL ledger.
                const step = Math.max(1, Math.ceil(unique.length / 10));
                if (completed < unique.length && completed % step === 0) reportProgress("fetching");
            }
            return address;
        }));
        if (entry && unique.length > 0) reportProgress("complete");
        if (signal.aborted) {
            setState("results", "errored");
            return Results.failure(
                "executor:search",
                "cancelled",
                499,
                "Search execution was cancelled.",
                {},
                {
                    runtime,
                    stage: "search",
                    retryable: false,
                },
            );
        }
        // {§web-search-retrieval} Emit a model-consumable digest, not the raw upstream payload: a
        // raw SearXNG result is ~10–20× its information content, and a wake that
        // folds the full response back into the prompt can exceed the budget
        // outright (a 68KB/query hard 413). Title + url + a snippet (optionally
        // bounded) — the OPEN chooser context; sizes ride the ambient entry rows.
        const results = unique.map(({ title, content, publishedDate }, i) => ({
            title,
            url: verdicts[i],
            snippet: snippetMax !== undefined && content ? content.slice(0, snippetMax) : content,
            ...(publishedDate ? { publishedDate } : {}),
            ...(entry ? { materialized: verdicts[i] !== null } : {}),
        })).filter((result) => !entry || result.materialized);
        write("results", JSON.stringify(results));
        setState("results", "closed");
        return { status: 200 };
    }
}
