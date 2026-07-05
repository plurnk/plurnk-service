import { BaseExecutor } from "@plurnk/plurnk-execs";
import type { ChannelDecl, Effect, ExecArgs, ExecResult, RuntimeAvailability } from "@plurnk/plurnk-execs";
import Pages from "./Pages.ts";

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
// comes from the environment, read per run.
//
//   PLURNK_EXECS_SEARCH_SEARXNG_URL   (required)  base URL of the instance
//   PLURNK_EXECS_SEARCH_LANGUAGE      (optional)  SearXNG's own default if unset
//   PLURNK_EXECS_SEARCH_LIMIT         (optional)  client-side result cap; keep-all if unset
//   PLURNK_EXECS_SEARCH_TIMEOUT       (optional)  ms; the consumer's signal is the deadline
//                                                 (SPEC §2.5) — this is an extra local ceiling
//   PLURNK_EXECS_SEARCH_SAFESEARCH    (optional)  0|1|2
//   PLURNK_EXECS_SEARCH_SNIPPET       (optional)  max chars per result snippet; unbounded if unset
//   PLURNK_EXECS_SEARCH_RAW           (optional)  truthy → emit the verbatim SearXNG payload (debug;
//                                                 skips the page pass entirely)
//   PLURNK_EXECS_SEARCH_PAGE_TIMEOUT  (optional)  ms per candidate page (Pages.ts)
//   PLURNK_EXECS_SEARCH_REDIRECTS     (optional)  redirect hops per page, re-guarded (Pages.ts)
// No code defaults hide a magic number — suggested values live in the consuming
// service's .env.example.
//
// The one-load flow (plurnk-execs#18): every candidate page is fetched exactly
// once; 404/timeout/empty/guard-refused candidates are pruned; survivors are
// materialized as slug-tagged https:// entries via the consumer's entry() sink
// (folded ambient rows announce them with tokens); the digest lists survivors
// ONLY — zero dead rows by construction. The digest rides OPEN as chooser
// context; page bodies live in the entries, never the packet.
export default class Search extends BaseExecutor {
    get channels(): Readonly<Record<string, ChannelDecl>> {
        return { results: { mimetype: "application/json" } };
    }

    // Available iff a SearXNG instance is configured. This is a config check,
    // not a reachability ping — boot answers "is search set up?"; live
    // reachability is the run path's job (it emits searxng_unreachable).
    override async probe(): Promise<RuntimeAvailability> {
        const url = process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL;
        return url
            ? { available: true, detail: url }
            : { available: false, detail: "PLURNK_EXECS_SEARCH_SEARXNG_URL not set" };
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

        const base = process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL;
        if (!base) return fail("searxng_not_configured", "PLURNK_EXECS_SEARCH_SEARXNG_URL is not set");

        // All tunables are optional env overrides — no code default hides a
        // magic number (suggested values live in the consumer's .env.example).
        const language = process.env.PLURNK_EXECS_SEARCH_LANGUAGE;
        const limitRaw = process.env.PLURNK_EXECS_SEARCH_LIMIT;
        const timeoutRaw = process.env.PLURNK_EXECS_SEARCH_TIMEOUT;
        const safesearch = process.env.PLURNK_EXECS_SEARCH_SAFESEARCH;

        const url = new URL("/search", base);
        url.searchParams.set("q", query);
        url.searchParams.set("format", "json");
        url.searchParams.set("categories", category);
        if (language) url.searchParams.set("language", language);
        if (safesearch) url.searchParams.set("safesearch", safesearch);

        // The consumer's signal is the deadline (SPEC §2.5); an optional search
        // timeout adds a local ceiling on top of it.
        const fetchSignal = timeoutRaw ? AbortSignal.any([signal, AbortSignal.timeout(Number(timeoutRaw))]) : signal;
        let response: Response;
        try {
            response = await fetch(url, { signal: fetchSignal });
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

        // Debug escape hatch: the verbatim SearXNG payload, no page pass.
        if (process.env.PLURNK_EXECS_SEARCH_RAW) {
            write("results", JSON.stringify(capped));
            setState("results", "closed");
            return { status: 200 };
        }

        // One-load page pass (#18): fetch every candidate once (parallel,
        // deduped by url), prune the dead, materialize survivors as slug-tagged
        // entries. The digest below lists survivors only — zero dead rows.
        const slug = Pages.slugify(query);
        const unique = [...new Map(capped.filter((r) => r.url).map((r) => [r.url!, r])).values()];
        const outcomes = await Promise.all(unique.map((r) => Pages.load(r.url!, { signal, entry, slug })));
        if (signal.aborted) {
            setState("results", "errored");
            return { status: 499 };
        }
        const survivors = unique.filter((_, i) => outcomes[i]);

        // Emit a model-consumable digest, not the raw upstream payload (#17): a
        // raw SearXNG result is ~10–20× its information content, and a wake that
        // folds the full response back into the prompt can exceed the budget
        // outright (a 68KB/query hard 413). Title + url + a snippet (optionally
        // bounded) — the OPEN chooser context; sizes ride the ambient entry rows.
        const snippetMax = process.env.PLURNK_EXECS_SEARCH_SNIPPET;
        const results = survivors.map(({ title, url, content, publishedDate }) => ({
            title,
            url,
            snippet: snippetMax && content ? content.slice(0, Number(snippetMax)) : content,
            ...(publishedDate ? { publishedDate } : {}),
        }));
        write("results", JSON.stringify(results));
        setState("results", "closed");
        return { status: 200 };
    }
}
