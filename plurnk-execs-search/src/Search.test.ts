import test, { beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import Search from "./Search.ts";
import type { ExecArgs, ExecResult, TelemetryEvent } from "@plurnk/plurnk-execs";

const origFetch = globalThis.fetch;
const origUrl = process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL;

// Replace global fetch with a stub. The stub is typed loosely (it only needs to
// satisfy the subset of Response that Search reads) and cast at the boundary.
// The executor fetches ONLY the SearXNG endpoint — never candidate page urls —
// so the stub only ever serves the single `/search` response.
const setFetch = (impl: (url: string | URL, init?: RequestInit) => Promise<unknown>): void => {
    globalThis.fetch = impl as unknown as typeof fetch;
};

// Route the stub: the SearXNG endpoint answers with `results`. It is the ONLY
// url the executor is permitted to fetch — any other url is a contract breach
// (candidate pages are the consumer's job now, ruling #5), so we throw on it.
const routes = (results: unknown[]) => {
    const fetched: string[] = [];
    setFetch(async (u) => {
        const url = String(u);
        fetched.push(url);
        if (url.includes("searxng.test")) return { ok: true, status: 200, json: async () => ({ results }) };
        throw new Error(`executor fetched a non-SearXNG url: ${url}`);
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

test("probe: blank / whitespace / malformed URL reads as unavailable, not just unset (#3)", async () => {
    for (const v of ["", "   ", "not-a-url"]) {
        process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL = v;
        const r = await new Search({ runtime: "search", glyph: "🔎" }).probe();
        assert.equal(r.available, false, `"${v}" is not a usable URL — must gate false`);
    }
});

test("run: a whitespace / malformed URL fails clean (500), never constructs a bad URL, never hangs (#3)", async () => {
    let fetched = false;
    setFetch(async () => { fetched = true; return { ok: true, status: 200, json: async () => ({ results: [] }) }; });
    for (const v of ["   ", "not-a-url"]) {
        process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL = v;
        const { result, events, states } = await invoke("search", "q");
        assert.equal(result.status, 500, `"${v}" → clean 500, not an uncaught throw`);
        assert.equal(events[0].kind, "searxng_not_configured");
        assert.equal(states.at(-1)?.state, "errored");
    }
    assert.equal(fetched, false, "a bad base never reaches fetch (and never `new URL`s to throw)");
});

test("search: queries SearXNG, digests candidates, closes channel, status 200", async () => {
    const fetched = routes([
        { title: "a", url: "https://8.8.8.8/a" },
        { title: "b", url: "https://8.8.8.9/b" },
    ]);
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
    assert.deepEqual(fetched, [fetched[0]], "only the SearXNG /search url is ever fetched");
});

test("digest: emits only {title,url,snippet}, dropping SearXNG noise (#17)", async () => {
    routes([{
        title: "Paris", url: "https://8.8.8.8/paris", content: "The capital of France.",
        template: "default.html", engine: "google", engines: ["google", "bing"], score: 3.2,
        parsed_url: ["https", "ex.com", "/", ""], positions: [1, 2], category: "general",
    }]);
    const { writes } = await invoke("search", "capital of France");
    assert.deepEqual(JSON.parse(writes[0].chunk), [
        { title: "Paris", url: "https://8.8.8.8/paris", snippet: "The capital of France." },
    ], "template/engine/score/parsed_url/positions all dropped — a ~10-20x shrink");
});

test("digest: SNIPPET bounds the snippet; RAW restores the verbatim payload and skips the prefetch pass (#17)", async () => {
    const raw = { title: "t", url: "https://8.8.8.8/t", content: "abcdefghij", engine: "x" };

    process.env.PLURNK_EXECS_SEARCH_SNIPPET = "4";
    routes([raw]);
    let cap = await invoke("search", "q");
    assert.equal(JSON.parse(cap.writes[0].chunk)[0].snippet, "abcd", "snippet bounded to 4 chars");
    delete process.env.PLURNK_EXECS_SEARCH_SNIPPET;

    process.env.PLURNK_EXECS_SEARCH_RAW = "1";
    const calls: string[] = [];
    routes([raw]);
    cap = await invoke("search", "q", { entry: async (path) => { calls.push(path); } });
    assert.deepEqual(JSON.parse(cap.writes[0].chunk), [raw], "RAW → verbatim upstream, engine field intact");
    assert.equal(calls.length, 0, "RAW skips the prefetch pass — entry() never called");
    delete process.env.PLURNK_EXECS_SEARCH_RAW;
});

// --- the dead-row prefetch pass (#18, SPEC §2.6, ruling #5) ---------------

test("entry(): the executor hands each unique candidate url to the sink as a prefetch request (url, null, [slug])", async () => {
    routes([{ title: "a", url: "https://8.8.8.8/a" }]);
    const calls: { path: string; content: string | null; opts: { tags: string[]; mimetype?: string } }[] = [];
    await invoke("search", "Pie Recipes!", { entry: async (path, content, opts) => { calls.push({ path, content, opts }); } });

    assert.equal(calls.length, 1, "one prefetch request per unique candidate");
    assert.equal(calls[0].path, "https://8.8.8.8/a", "the candidate url is the prefetch path");
    assert.equal(calls[0].content, null, "content is null — the consumer sources it (fetch/render/materialize)");
    assert.deepEqual(calls[0].opts.tags, ["pie_recipes"], "the slugified query rides as the sole tag");
    assert.equal(calls[0].opts.mimetype, undefined, "no mimetype supplied — the consumer determines it");
});

test("prune: a rejected entry() prunes that row; resolving candidates survive", async () => {
    routes([
        { title: "a", url: "https://8.8.8.8/a" },
        { title: "b", url: "https://8.8.8.9/b" },
    ]);
    const { writes } = await invoke("search", "q", {
        entry: async (path) => { if (path.includes("8.8.8.9")) throw new Error("consumer fetch refused — dead row"); },
    });
    assert.deepEqual(
        JSON.parse(writes[0].chunk).map((r: { title: string }) => r.title),
        ["a"],
        "the rejected candidate is pruned; the resolved one survives",
    );
});

test("prune: every rejecting entry() empties the digest — survivors only, zero dead rows", async () => {
    routes([
        { title: "x", url: "https://8.8.8.8/x" },
        { title: "y", url: "https://8.8.8.9/y" },
    ]);
    const requested: string[] = [];
    const { writes } = await invoke("search", "q", {
        entry: async (path) => { requested.push(path); throw new Error("all dead"); },
    });
    assert.deepEqual(JSON.parse(writes[0].chunk), [], "all candidates pruned when every prefetch rejects");
    assert.deepEqual(requested.sort(), ["https://8.8.8.8/x", "https://8.8.8.9/y"], "each candidate was still handed to the sink");
});

test("dedupe: two candidates with the same url request the prefetch once and list once", async () => {
    routes([
        { title: "a", url: "https://8.8.8.8/a" },
        { title: "a-again", url: "https://8.8.8.8/a" },
    ]);
    const requested: string[] = [];
    const { writes } = await invoke("search", "q", { entry: async (path) => { requested.push(path); } });
    assert.equal(JSON.parse(writes[0].chunk).length, 1, "the duplicate url lists once");
    assert.deepEqual(requested, ["https://8.8.8.8/a"], "the duplicate url is handed to entry() exactly once");
});

test("degrade: without an entry sink every candidate rides the digest and entry is never called", async () => {
    routes([
        { title: "a", url: "https://8.8.8.8/a" },
        { title: "b", url: "https://8.8.8.9/b" },
    ]);
    const { writes } = await invoke("search", "q");
    assert.deepEqual(
        JSON.parse(writes[0].chunk).map((r: { title: string }) => r.title),
        ["a", "b"],
        "no sink ⇒ no verdict ⇒ every candidate survives (graceful degradation)",
    );
});

test("the executor NEVER fetches a candidate page url — only the SearXNG /search url", async () => {
    const fetched = routes([
        { title: "a", url: "https://8.8.8.8/a" },
        { title: "b", url: "https://8.8.8.9/b" },
    ]);
    await invoke("search", "q", { entry: async () => {} });
    assert.equal(fetched.length, 1, "exactly one fetch — the SearXNG endpoint");
    assert.equal(new URL(fetched[0]).pathname, "/search");
    assert.equal(fetched.filter((u) => !u.includes("searxng.test")).length, 0, "no candidate url is ever fetched");
});

test("slugify: lowercase, non-alphanumerics collapse to single underscores, trimmed", async () => {
    const tag = async (query: string): Promise<string> => {
        routes([{ title: "t", url: "https://8.8.8.8/t" }]);
        let seen: string[] = [];
        await invoke("search", query, { entry: async (_p, _c, opts) => { seen = opts.tags; } });
        return seen[0];
    };
    assert.equal(await tag("Who was the 15th President?"), "who_was_the_15th_president");
    assert.equal(await tag("  turkeys  "), "turkeys");
    assert.equal(await tag("c++ vs. rust!"), "c_vs_rust");
});

test("limit caps the candidates — only capped rows ride the digest and get a prefetch request", async () => {
    const results = Array.from({ length: 20 }, (_, i) => ({ title: `t${i}`, url: `https://8.8.8.8/p${i}` }));
    routes(results);
    process.env.PLURNK_EXECS_SEARCH_LIMIT = "3";
    const requested: string[] = [];
    const { writes } = await invoke("search", "q", { entry: async (path) => { requested.push(path); } });
    delete process.env.PLURNK_EXECS_SEARCH_LIMIT;

    assert.equal(JSON.parse(writes[0].chunk).length, 3, "digest capped to LIMIT");
    assert.equal(requested.length, 3, "17 uncapped candidates never get a prefetch request");
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

test("timeout → searxng_timeout, errored channel, status 500", async () => {
    setFetch(async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); });
    process.env.PLURNK_EXECS_SEARCH_TIMEOUT = "5";
    const { result, states, events } = await invoke("search", "q");
    delete process.env.PLURNK_EXECS_SEARCH_TIMEOUT;

    assert.equal(result.status, 500);
    assert.equal(events[0].kind, "searxng_timeout");
    assert.equal(states.at(-1)?.state, "errored");
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
