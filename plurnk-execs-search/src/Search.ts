import { BaseExecutor } from "@plurnk/plurnk-execs";
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

const preview = (q: string): string => (q.length > 60 ? `${q.slice(0, 60)}…` : q);

// Deterministic query slug — the tag tying a search's prefetched entries
// together. Full slugified query, no locally-invented length cap.
const slugify = (query: string): string => query.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// The configured SearXNG base URL, or null if unusable — trimmed and validated,
// NOT merely truthy: a blank/whitespace/malformed value (an env floor easily
// emits `URL= ` with a trailing space) must read as unconfigured. Truthy-only
// checks let " " through, and `new URL("/search", " ")` then throws uncaught →
// the worker never resolves nor times out (plurnk-execs-search#3).
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

// Web search executor (the first non-subprocess runtime). Dispatches a query to
// a configured SearXNG instance and writes a compact digest of its results
// (title + url + snippet) to the `results` channel. Stateless: configuration
// comes from the environment, read per worker.
//
//   PLURNK_EXECS_SEARCH_SEARXNG_URL   (required)  base URL of the instance
//   PLURNK_EXECS_SEARCH_LANGUAGE      (optional)  SearXNG's own default if unset
//   PLURNK_EXECS_SEARCH_LIMIT         (optional)  client-side result cap; keep-all if unset
//   PLURNK_EXECS_SEARCH_TIMEOUT       (optional)  ms; the consumer's signal is the deadline
//                                                 (SPEC §2.5) — this is an extra local ceiling
//   PLURNK_EXECS_SEARCH_SAFESEARCH    (optional)  0|1|2
//   PLURNK_EXECS_SEARCH_SNIPPET       (optional)  max chars per result snippet; unbounded if unset
//   PLURNK_EXECS_SEARCH_RAW           (optional)  truthy → emit the verbatim SearXNG payload (debug;
//                                                 skips the prefetch pass entirely)
// No code default hides a magic number; suggested values ship in this package's
// .env.defaults. The page-fetch knobs (timeout, redirects) moved to the consumer
// with the fetch — the executor no longer fetches (SPEC §2.6, ruling #5).
//
// Page prefetch (plurnk-execs#18, service#596, SPEC §2.6): the executor emits
// the ranked discovery digest but NEVER fetches — it hands each candidate URL
// to the consumer's entry() as a consumer-sourced prefetch request. The
// consumer fetches/renders/materializes the https:// entry; resolve/reject
// becomes the row's materialized verdict, never a membership or ranking filter.
// The digest rides OPEN as chooser context; successful page bodies live in the
// entries (schemes-http owns the guarded fetch/render), never the packet.
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
        const fail = (kind: string, message: string, status = 500): ExecResult => {
            emit({ source: `exec:${runtime}`, kind, message });
            setState("results", "errored");
            return { status };
        };

        // External bangs (`!!`) redirect to an upstream site instead of
        // returning JSON — incompatible with a results executor (SPEC §2.2).
        if (query.startsWith("!!")) {
            return fail("external_bang_refused", `external bang refused: "${preview(query)}"`, 400);
        }

        const config = searxngConfig();
        if (config === null) return fail("searxng_not_configured", "PLURNK_EXECS_SEARCH_SEARXNG_URL is not set to a valid URL");

        // All tunables are optional env overrides — no code default hides a
        // magic number (suggested values live in the consumer's .env.example).
        const language = process.env.PLURNK_EXECS_SEARCH_LANGUAGE;
        const limitRaw = process.env.PLURNK_EXECS_SEARCH_LIMIT;
        const timeoutRaw = process.env.PLURNK_EXECS_SEARCH_TIMEOUT;
        const safesearch = process.env.PLURNK_EXECS_SEARCH_SAFESEARCH;

        const url = new URL("/search", config.base);
        url.searchParams.set("q", query);
        url.searchParams.set("format", "json");
        url.searchParams.set("categories", category);
        if (language) url.searchParams.set("language", language);
        if (safesearch) url.searchParams.set("safesearch", safesearch);

        // The consumer's signal is the deadline (SPEC §2.5); an optional search
        // timeout adds a local ceiling on top of it.
        // A malformed TIMEOUT is the same throw-class: AbortSignal.timeout(NaN)
        // throws, so only arm the extra ceiling for a finite positive value.
        const timeoutMs = Number(timeoutRaw);
        const fetchSignal = timeoutRaw && Number.isFinite(timeoutMs) && timeoutMs > 0
            ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
            : signal;
        let response: Response;
        try {
            response = await fetch(url, {
                signal: fetchSignal,
                ...(config.authorization ? { headers: { Authorization: config.authorization } } : {}),
            });
        } catch (err) {
            // Caller cancellation is normal flow, not telemetry-worthy.
            if (signal.aborted) {
                setState("results", "errored");
                return { status: 499 };
            }
            const e = err as { name?: string; code?: string; cause?: { code?: string; message?: string } };
            if (e.name === "TimeoutError") {
                return fail("searxng_timeout", `SearXNG timeout after ${timeoutRaw}ms — host=${url.host} query="${preview(query)}"`);
            }
            // Node's fetch throws a bare "fetch failed" and tucks the real
            // reason under err.cause — surface it so logs say ENOTFOUND /
            // ECONNREFUSED / CERT_* rather than nothing actionable.
            const code = e.cause?.code ?? e.code ?? "UNKNOWN";
            const detail = e.cause?.message ?? (err as Error).message;
            return fail("searxng_unreachable", `SearXNG fetch failed [${code}] — ${detail}; host=${url.host} query="${preview(query)}"`);
        }

        if (!response.ok) {
            return fail(`searxng_http_${response.status}`, `SearXNG ${response.status} ${response.statusText} — host=${url.host} query="${preview(query)}"`);
        }

        const data = await response.json() as { results?: SearxngResult[] };
        const capped = (data.results ?? []).slice(0, limitRaw ? Number(limitRaw) : undefined);

        // Debug escape hatch: the verbatim SearXNG payload, no prefetch pass.
        if (process.env.PLURNK_EXECS_SEARCH_RAW) {
            write("results", JSON.stringify(capped));
            setState("results", "closed");
            return { status: 200 };
        }

        // Page prefetch (#18, SPEC §2.6, #596): hand each candidate URL to the
        // consumer's entry() as a prefetch request (content null ⇒
        // consumer-sourced). The executor never fetches. Fetchability is
        // enrichment, not relevance: a rejection leaves the SearXNG discovery
        // row in place and records only that no body materialized. Deduped by
        // URL; without the sink no verdict exists, so `materialized` is omitted.
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
            if (!entry) return true;
            let accepted = false;
            try {
                await entry(r.url!, null, { tags: [slug] });
                accepted = true;
            } catch {
                accepted = false;
            } finally {
                completed++;
                if (accepted) materialized++;
                // At most ~10 intermediate notices regardless of result count,
                // plus start and terminal. Progress is aggregate: no URL ledger.
                const step = Math.max(1, Math.ceil(unique.length / 10));
                if (completed < unique.length && completed % step === 0) reportProgress("fetching");
            }
            return accepted;
        }));
        if (entry && unique.length > 0) reportProgress("complete");
        if (signal.aborted) {
            setState("results", "errored");
            return { status: 499 };
        }
        // Emit a model-consumable digest, not the raw upstream payload (#17): a
        // raw SearXNG result is ~10–20× its information content, and a wake that
        // folds the full response back into the prompt can exceed the budget
        // outright (a 68KB/query hard 413). Title + url + a snippet (optionally
        // bounded) — the OPEN chooser context; sizes ride the ambient entry rows.
        const snippetMax = process.env.PLURNK_EXECS_SEARCH_SNIPPET;
        const results = unique.map(({ title, url, content, publishedDate }, i) => ({
            title,
            url,
            snippet: snippetMax && content ? content.slice(0, Number(snippetMax)) : content,
            ...(publishedDate ? { publishedDate } : {}),
            ...(entry ? {
                materialized: verdicts[i],
                // `url` is the canonical substrate identity; `#body` selects
                // its preferred model-facing projection. Point at that channel
                // explicitly so retrieval does not fan out into response
                // headers and archival HTML before the model sees evidence.
                ...(verdicts[i] ? { readTarget: `${url}#body` } : {}),
            } : {}),
        }));
        write("results", JSON.stringify(results));
        setState("results", "closed");
        return { status: 200 };
    }
}
