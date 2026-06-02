import { BaseExecutor } from "@plurnk/plurnk-execs";
import type { ChannelDecl, ExecArgs, ExecResult } from "@plurnk/plurnk-execs";

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

const DEFAULT_LANGUAGE = "en";
const DEFAULT_LIMIT = 12;
const DEFAULT_TIMEOUT_MS = 10_000;

const preview = (q: string): string => (q.length > 60 ? `${q.slice(0, 60)}…` : q);

// Web search executor (the first non-subprocess runtime). Dispatches a query to
// a configured SearXNG instance and writes its native JSON results to the
// `results` channel. Stateless: configuration comes from the environment, read
// per run.
//
//   PLURNK_EXECS_SEARCH_SEARXNG_URL   (required) base URL of the instance
//   PLURNK_EXECS_SEARCH_LANGUAGE      (default "en")
//   PLURNK_EXECS_SEARCH_LIMIT         (default 12)   results kept
//   PLURNK_EXECS_SEARCH_TIMEOUT       (default 10000) ms
//   PLURNK_EXECS_SEARCH_SAFESEARCH    (optional 0|1|2)
export default class Search extends BaseExecutor {
    get channels(): Readonly<Record<string, ChannelDecl>> {
        return { results: { mimetype: "application/json" } };
    }

    async run({ runtime, command, signal, write, setState, emit }: ExecArgs): Promise<ExecResult> {
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

        const language = process.env.PLURNK_EXECS_SEARCH_LANGUAGE || DEFAULT_LANGUAGE;
        const limit = Number(process.env.PLURNK_EXECS_SEARCH_LIMIT) || DEFAULT_LIMIT;
        const timeout = Number(process.env.PLURNK_EXECS_SEARCH_TIMEOUT) || DEFAULT_TIMEOUT_MS;
        const safesearch = process.env.PLURNK_EXECS_SEARCH_SAFESEARCH;

        const url = new URL("/search", base);
        url.searchParams.set("q", query);
        url.searchParams.set("format", "json");
        url.searchParams.set("categories", category);
        url.searchParams.set("language", language);
        if (safesearch) url.searchParams.set("safesearch", safesearch);

        let response: Response;
        try {
            response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) });
        } catch (err) {
            // Caller cancellation is normal flow, not telemetry-worthy.
            if (signal.aborted) {
                setState("results", "errored");
                return { status: 499 };
            }
            const e = err as { name?: string; code?: string; cause?: { code?: string; message?: string } };
            if (e.name === "TimeoutError") {
                return fail("searxng_timeout", `SearXNG timeout after ${timeout}ms — host=${url.host} query="${preview(query)}"`);
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

        const data = await response.json() as { results?: unknown[] };
        const results = (data.results ?? []).slice(0, limit);
        write("results", JSON.stringify(results));
        setState("results", "closed");
        return { status: 200 };
    }
}
