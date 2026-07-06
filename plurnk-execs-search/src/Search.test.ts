import test, { beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import Search from "./Search.ts";
import Pages from "./Pages.ts";
import type { ExecArgs, ExecResult, TelemetryEvent } from "@plurnk/plurnk-execs";

const origFetch = globalThis.fetch;
const origUrl = process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL;

// Replace global fetch with a stub. The stub is typed loosely (it only needs to
// satisfy the subset of Response that Search/Pages read) and cast at the
// boundary. Page urls in tests are PUBLIC IP LITERALS (8.8.8.x) so the
// private-address guard never touches real DNS — tests stay hermetic.
const setFetch = (impl: (url: string | URL, init?: RequestInit) => Promise<unknown>): void => {
    globalThis.fetch = impl as unknown as typeof fetch;
};

// A minimal page Response: status, content-type/location headers, text body.
const page = (body: string, opts: { status?: number; type?: string; location?: string } = {}) => ({
    ok: (opts.status ?? 200) >= 200 && (opts.status ?? 200) < 300,
    status: opts.status ?? 200,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? opts.type ?? "text/html" : k.toLowerCase() === "location" ? opts.location ?? null : null) },
    text: async () => body,
});

// Route the stub: the SearXNG endpoint answers with `results`; everything else
// is looked up in `pages` (a missing page throws like a dead host).
const routes = (results: unknown[], pages: Record<string, ReturnType<typeof page>>) => {
    const fetched: string[] = [];
    setFetch(async (u) => {
        const url = String(u);
        fetched.push(url);
        if (url.includes("searxng.test")) return { ok: true, status: 200, json: async () => ({ results }) };
        const p = pages[url];
        if (!p) throw new Error(`unreachable ${url}`);
        return p;
    });
    return fetched;
};

interface Capture {
    result: ExecResult;
    writes: { channel: string; chunk: string }[];
    states: { channel: string; state: string }[];
    events: TelemetryEvent[];
}

const invoke = async (
    runtime: string,
    command: string,
    opts: { signal?: AbortSignal; entry?: ExecArgs["entry"] } = {},
): Promise<Capture> => {
    const writes: Capture["writes"] = [];
    const states: Capture["states"] = [];
    const events: TelemetryEvent[] = [];
    const args: ExecArgs = {
        runtime, command, cwd: null, target: null,
        signal: opts.signal ?? new AbortController().signal,
        write: (channel, chunk) => writes.push({ channel, chunk }),
        setState: (channel, state) => states.push({ channel, state }),
        emit: (event) => events.push(event),
        ...(opts.entry ? { entry: opts.entry } : {}),
    };
    const result = await new Search({ runtime, glyph: "🔎" }).run(args);
    return { result, writes, states, events };
};

beforeEach(() => { process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL = "http://searxng.test"; });
afterEach(() => {
    globalThis.fetch = origFetch;
    if (origUrl === undefined) delete process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL;
    else process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL = origUrl;
});

test("manifest declares the ten search tags", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8"));
    assert.equal(pkg.plurnk.kind, "exec");
    assert.deepEqual(
        pkg.plurnk.runtimes.map((r: { name: string }) => r.name),
        ["search", "images", "videos", "news", "map", "music", "it", "science", "social", "downloadable"],
    );
});

test("declares a results channel (application/json)", () => {
    assert.deepEqual(new Search({ runtime: "search", glyph: "🔎" }).channels, {
        results: { mimetype: "application/json" },
    });
});

test("effect: search is read (auto-run; entries materialize via the consumer's own sink)", () => {
    assert.equal(new Search({ runtime: "search", glyph: "🔎" }).effect(null), "read");
});

test("probe: available when SEARXNG_URL is set, unavailable otherwise", async () => {
    const set = await new Search({ runtime: "search", glyph: "🔎" }).probe();
    assert.deepEqual(set, { available: true, detail: "http://searxng.test" });

    delete process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL;
    const unset = await new Search({ runtime: "search", glyph: "🔎" }).probe();
    assert.equal(unset.available, false);
    assert.match(String(unset.detail), /not set/);
});

test("search: queries SearXNG, loads pages, digests survivors, closes channel, status 200", async () => {
    const fetched = routes(
        [{ title: "a", url: "https://8.8.8.8/a" }, { title: "b", url: "https://8.8.8.9/b" }],
        { "https://8.8.8.8/a": page("<html>A</html>"), "https://8.8.8.9/b": page("<html>B</html>") },
    );
    const { result, writes, states, events } = await invoke("search", "pie recipes");

    assert.deepEqual(result, { status: 200 });
    const searx = new URL(fetched[0]);
    assert.equal(searx.pathname, "/search");
    assert.equal(searx.searchParams.get("q"), "pie recipes");
    assert.equal(searx.searchParams.get("format"), "json");
    assert.equal(searx.searchParams.get("categories"), "general");
    assert.equal(searx.searchParams.get("language"), null, "language omitted when unset — SearXNG default applies (no code default)");
    assert.deepEqual(JSON.parse(writes[0].chunk), [
        { title: "a", url: "https://8.8.8.8/a" },
        { title: "b", url: "https://8.8.8.9/b" },
    ]);
    assert.deepEqual(states, [{ channel: "results", state: "closed" }]);
    assert.equal(events.length, 0);
});

test("digest: emits only {title,url,snippet}, dropping SearXNG noise (#17)", async () => {
    routes(
        [{
            title: "Paris", url: "https://8.8.8.8/paris", content: "The capital of France.",
            template: "default.html", engine: "google", engines: ["google", "bing"], score: 3.2,
            parsed_url: ["https", "ex.com", "/", ""], positions: [1, 2], category: "general",
        }],
        { "https://8.8.8.8/paris": page("<html>Paris</html>") },
    );
    const { writes } = await invoke("search", "capital of France");
    assert.deepEqual(JSON.parse(writes[0].chunk), [
        { title: "Paris", url: "https://8.8.8.8/paris", snippet: "The capital of France." },
    ], "template/engine/score/parsed_url/positions all dropped — a ~10-20x shrink");
});

test("digest: SNIPPET bounds the snippet; RAW restores the verbatim payload and skips the page pass (#17)", async () => {
    const raw = { title: "t", url: "https://8.8.8.8/t", content: "abcdefghij", engine: "x" };
    let fetched = routes([raw], { "https://8.8.8.8/t": page("body") });

    process.env.PLURNK_EXECS_SEARCH_SNIPPET = "4";
    let cap = await invoke("search", "q");
    assert.equal(JSON.parse(cap.writes[0].chunk)[0].snippet, "abcd", "snippet bounded to 4 chars");
    delete process.env.PLURNK_EXECS_SEARCH_SNIPPET;

    process.env.PLURNK_EXECS_SEARCH_RAW = "1";
    fetched = routes([raw], {});
    cap = await invoke("search", "q");
    assert.deepEqual(JSON.parse(cap.writes[0].chunk), [raw], "RAW → verbatim upstream, engine field intact");
    assert.equal(fetched.length, 1, "RAW skips the page pass — only the SearXNG fetch");
    delete process.env.PLURNK_EXECS_SEARCH_RAW;
});

// --- the one-load page pass (#18) ----------------------------------------

test("entry(): survivors materialize as slug-tagged entries — url, body, tags, mimetype", async () => {
    routes(
        [{ title: "a", url: "https://8.8.8.8/a" }],
        { "https://8.8.8.8/a": page("<html>A</html>", { type: "text/html; charset=utf-8" }) },
    );
    const calls: { path: string; content: string; opts: { tags: string[]; mimetype: string } }[] = [];
    await invoke("search", "Pie Recipes!", { entry: async (path, content, opts) => { calls.push({ path, content, opts }); } });

    assert.deepEqual(calls, [{
        path: "https://8.8.8.8/a",
        content: "<html>A</html>",
        opts: { tags: ["pie_recipes"], mimetype: "text/html" },
    }], "the slugified query rides as the tag; mimetype is the bare content-type");
});

test("prune: 404, empty body, non-textual mimetype, and unreachable pages never reach the digest or entry()", async () => {
    routes(
        [
            { title: "ok", url: "https://8.8.8.8/ok" },
            { title: "dead", url: "https://8.8.8.8/404" },
            { title: "blank", url: "https://8.8.8.8/blank" },
            { title: "binary", url: "https://8.8.8.8/pdf" },
            { title: "gone", url: "https://8.8.8.8/unreachable" },
        ],
        {
            "https://8.8.8.8/ok": page("alive"),
            "https://8.8.8.8/404": page("nope", { status: 404 }),
            "https://8.8.8.8/blank": page("   "),
            "https://8.8.8.8/pdf": page("%PDF-", { type: "application/pdf" }),
            // /unreachable absent → routes() throws (dead host)
        },
    );
    const materialized: string[] = [];
    const { writes } = await invoke("search", "q", { entry: async (path) => { materialized.push(path); } });

    assert.deepEqual(JSON.parse(writes[0].chunk).map((r: { title: string }) => r.title), ["ok"], "survivors only — zero dead rows");
    assert.deepEqual(materialized, ["https://8.8.8.8/ok"]);
});

test("prune: a rejected entry() means not-materialized — the row is pruned too", async () => {
    routes(
        [{ title: "a", url: "https://8.8.8.8/a" }, { title: "b", url: "https://8.8.8.9/b" }],
        { "https://8.8.8.8/a": page("A"), "https://8.8.8.9/b": page("B") },
    );
    const { writes } = await invoke("search", "q", {
        entry: async (path) => { if (path.includes("8.8.8.9")) throw new Error("storage refused"); },
    });
    assert.deepEqual(JSON.parse(writes[0].chunk).map((r: { title: string }) => r.title), ["a"]);
});

test("guard: private/loopback/metadata/localhost targets are pruned without ever being fetched (service#340)", async () => {
    const fetched = routes(
        [
            { title: "meta", url: "https://169.254.169.254/latest" },
            { title: "loop", url: "http://127.0.0.1/x" },
            { title: "rfc1918", url: "http://10.0.0.5/x" },
            { title: "name", url: "http://localhost/x" },
            { title: "ok", url: "https://8.8.8.8/ok" },
        ],
        { "https://8.8.8.8/ok": page("alive") },
    );
    const { writes } = await invoke("search", "q");

    assert.deepEqual(JSON.parse(writes[0].chunk).map((r: { title: string }) => r.title), ["ok"]);
    assert.deepEqual(fetched.filter((u) => !u.includes("searxng.test")), ["https://8.8.8.8/ok"], "guarded targets never hit fetch");
});

test("redirects: pruned by default; REDIRECTS=1 follows one re-guarded hop; a hop into private space is pruned", async () => {
    const pages = {
        "https://8.8.8.8/r": page("", { status: 301, location: "https://8.8.4.4/final" }),
        "https://8.8.4.4/final": page("landed"),
        "https://8.8.8.9/evil": page("", { status: 302, location: "http://169.254.169.254/latest" }),
    };
    routes([{ title: "r", url: "https://8.8.8.8/r" }], pages);
    let cap = await invoke("search", "q");
    assert.deepEqual(JSON.parse(cap.writes[0].chunk), [], "3xx pruned when REDIRECTS unset — no invented hop count");

    process.env.PLURNK_EXECS_SEARCH_REDIRECTS = "1";
    routes([{ title: "r", url: "https://8.8.8.8/r" }, { title: "evil", url: "https://8.8.8.9/evil" }], pages);
    cap = await invoke("search", "q");
    delete process.env.PLURNK_EXECS_SEARCH_REDIRECTS;
    assert.deepEqual(JSON.parse(cap.writes[0].chunk).map((r: { title: string }) => r.title), ["r"], "public hop followed, private hop pruned");
});

test("dedupe: two candidates with the same url load once and list once", async () => {
    const fetched = routes(
        [{ title: "a", url: "https://8.8.8.8/a" }, { title: "a-again", url: "https://8.8.8.8/a" }],
        { "https://8.8.8.8/a": page("A") },
    );
    const { writes } = await invoke("search", "q");
    assert.equal(JSON.parse(writes[0].chunk).length, 1);
    assert.equal(fetched.filter((u) => u === "https://8.8.8.8/a").length, 1);
});

test("degrade: without an entry sink the flow still loads, prunes, and digests (consumer back-compat)", async () => {
    routes(
        [{ title: "a", url: "https://8.8.8.8/a" }, { title: "dead", url: "https://8.8.8.8/404" }],
        { "https://8.8.8.8/a": page("A"), "https://8.8.8.8/404": page("x", { status: 404 }) },
    );
    const { writes } = await invoke("search", "q");
    assert.deepEqual(JSON.parse(writes[0].chunk).map((r: { title: string }) => r.title), ["a"]);
});

test("slugify: lowercase, non-alphanumerics collapse to single underscores, trimmed", () => {
    assert.equal(Pages.slugify("Who was the 15th President?"), "who_was_the_15th_president");
    assert.equal(Pages.slugify("  turkeys  "), "turkeys");
    assert.equal(Pages.slugify("c++ vs. rust!"), "c_vs_rust");
});

test("limit caps the candidates BEFORE the page pass — only capped pages are fetched", async () => {
    const results = Array.from({ length: 20 }, (_, i) => ({ title: `t${i}`, url: `https://8.8.8.8/p${i}` }));
    const pages = Object.fromEntries(results.map((r) => [r.url, page("body")]));
    const fetched = routes(results, pages);
    process.env.PLURNK_EXECS_SEARCH_LIMIT = "3";
    const { writes } = await invoke("search", "q");
    delete process.env.PLURNK_EXECS_SEARCH_LIMIT;

    assert.equal(JSON.parse(writes[0].chunk).length, 3);
    assert.equal(fetched.filter((u) => !u.includes("searxng.test")).length, 3, "17 uncapped candidates never fetched");
});

test("ceiling: unset LIMIT caps at SEARCH_MAX (20), never unbounded — SearXNG's 40 → 20 fetched & listed", async () => {
    const results = Array.from({ length: 40 }, (_, i) => ({ title: `t${i}`, url: `https://8.8.8.8/p${i}` }));
    const pages = Object.fromEntries(results.map((r) => [r.url, page("body")]));
    const fetched = routes(results, pages); // PLURNK_EXECS_SEARCH_LIMIT unset
    const { writes } = await invoke("search", "q");

    assert.equal(JSON.parse(writes[0].chunk).length, 20, "unset ⇒ the ceiling, not keep-all");
    assert.equal(fetched.filter((u) => !u.includes("searxng.test")).length, 20, "only 20 pages fetched — no fetch storm");
});

test("ceiling: LIMIT above SEARCH_MAX clamps down; a LIMIT below it still wins", async () => {
    const results = Array.from({ length: 40 }, (_, i) => ({ title: `t${i}`, url: `https://8.8.8.8/p${i}` }));
    const pages = Object.fromEntries(results.map((r) => [r.url, page("body")]));

    routes(results, pages);
    process.env.PLURNK_EXECS_SEARCH_LIMIT = "50";
    let cap = await invoke("search", "q");
    assert.equal(JSON.parse(cap.writes[0].chunk).length, 20, "operator can't raise above the hard ceiling");

    routes(results, pages);
    process.env.PLURNK_EXECS_SEARCH_LIMIT = "5";
    cap = await invoke("search", "q");
    delete process.env.PLURNK_EXECS_SEARCH_LIMIT;
    assert.equal(JSON.parse(cap.writes[0].chunk).length, 5, "a lower LIMIT still dials below the ceiling");
});

test("tag → categories mapping (news, social→'social media', downloadable→files, images)", async () => {
    const seen: Record<string, string | null> = {};
    setFetch(async (u) => {
        const url = new URL(String(u));
        seen[url.searchParams.get("q") ?? ""] = url.searchParams.get("categories");
        return { ok: true, status: 200, json: async () => ({ results: [] }) };
    });
    await invoke("news", "qn");
    await invoke("social", "qs");
    await invoke("downloadable", "qd");
    await invoke("images", "qi");

    assert.equal(seen.qn, "news");
    assert.equal(seen.qs, "social media");
    assert.equal(seen.qd, "files");
    assert.equal(seen.qi, "images");
});

test("non-ok response → searxng_http_<n>, errored channel, status 500", async () => {
    setFetch(async () => ({ ok: false, status: 502, statusText: "Bad Gateway", json: async () => ({}) }));
    const { result, states, events } = await invoke("news", "q");

    assert.equal(result.status, 500);
    assert.equal(events[0].source, "exec:news");
    assert.equal(events[0].kind, "searxng_http_502");
    assert.equal(states.at(-1)?.state, "errored");
});

test("fetch failure → searxng_unreachable surfacing the cause code", async () => {
    setFetch(async () => {
        const err = new Error("fetch failed");
        (err as { cause?: unknown }).cause = { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND searxng.test" };
        throw err;
    });
    const { result, events } = await invoke("search", "q");

    assert.equal(result.status, 500);
    assert.equal(events[0].kind, "searxng_unreachable");
    assert.match(String(events[0].message), /ENOTFOUND/);
});

test("missing SEARXNG url → searxng_not_configured, status 500, no fetch", async () => {
    delete process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL;
    let called = false;
    setFetch(async () => { called = true; return { ok: true, status: 200, json: async () => ({ results: [] }) }; });
    const { result, events } = await invoke("search", "q");

    assert.equal(result.status, 500);
    assert.equal(events[0].kind, "searxng_not_configured");
    assert.equal(called, false);
});

test("external bang (!!) refused with status 400, no fetch", async () => {
    let called = false;
    setFetch(async () => { called = true; return { ok: true, status: 200, json: async () => ({ results: [] }) }; });
    const { result, events } = await invoke("search", "!!ddg something");

    assert.equal(result.status, 400);
    assert.equal(events[0].kind, "external_bang_refused");
    assert.equal(called, false);
});

test("caller-aborted signal → status 499, no telemetry", async () => {
    const controller = new AbortController();
    setFetch(async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); });
    controller.abort();
    const { result, events } = await invoke("search", "q", { signal: controller.signal });

    assert.equal(result.status, 499);
    assert.equal(events.length, 0);
});

test("unclaimed runtime tag is fail-hard (misroute)", async () => {
    await assert.rejects(invoke("bogus", "q"), /unclaimed runtime tag 'bogus'/);
});
