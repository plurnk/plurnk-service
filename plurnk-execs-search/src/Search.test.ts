import test, { beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import Search from "./Search.ts";
import type { ExecArgs, ExecResult, TelemetryEvent } from "@plurnk/plurnk-execs";

const origFetch = globalThis.fetch;
const origUrl = process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL;

// Replace global fetch with a stub. The stub is typed loosely (it only needs to
// satisfy the subset of Response that Search reads) and cast at the boundary.
const setFetch = (impl: (url: string | URL) => Promise<unknown>): void => {
    globalThis.fetch = impl as unknown as typeof fetch;
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
    opts: { signal?: AbortSignal } = {},
): Promise<Capture> => {
    const writes: Capture["writes"] = [];
    const states: Capture["states"] = [];
    const events: TelemetryEvent[] = [];
    const args: ExecArgs = {
        runtime, command, cwd: null,
        signal: opts.signal ?? new AbortController().signal,
        write: (channel, chunk) => writes.push({ channel, chunk }),
        setState: (channel, state) => states.push({ channel, state }),
        emit: (event) => events.push(event),
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

test("search: queries SearXNG, writes results, closes channel, status 200", async () => {
    let captured: URL | undefined;
    setFetch(async (u) => {
        captured = new URL(String(u));
        return { ok: true, status: 200, json: async () => ({ results: [{ title: "a" }, { title: "b" }] }) };
    });
    const { result, writes, states, events } = await invoke("search", "pie recipes");

    assert.deepEqual(result, { status: 200 });
    assert.equal(captured?.pathname, "/search");
    assert.equal(captured?.searchParams.get("q"), "pie recipes");
    assert.equal(captured?.searchParams.get("format"), "json");
    assert.equal(captured?.searchParams.get("categories"), "general");
    assert.equal(captured?.searchParams.get("language"), "en");
    assert.deepEqual(JSON.parse(writes[0].chunk), [{ title: "a" }, { title: "b" }]);
    assert.deepEqual(states, [{ channel: "results", state: "closed" }]);
    assert.equal(events.length, 0);
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

test("limit slices the result set", async () => {
    setFetch(async () => ({ ok: true, status: 200, json: async () => ({ results: Array.from({ length: 20 }, (_, i) => ({ i })) }) }));
    process.env.PLURNK_EXECS_SEARCH_LIMIT = "3";
    const { writes } = await invoke("search", "q");
    delete process.env.PLURNK_EXECS_SEARCH_LIMIT;
    assert.equal(JSON.parse(writes[0].chunk).length, 3);
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
