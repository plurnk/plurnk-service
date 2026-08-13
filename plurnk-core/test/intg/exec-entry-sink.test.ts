// {§exec-entry-sink} — a stub runtime drives the real consumer-owned materialization
// and ambience path; nothing below the executor is mocked.

import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import type { ExecStatement, FindStatement, PlurnkStatement, ReadStatement } from "@plurnk/plurnk-contracts";
import { WebFetcher } from "@plurnk/plurnk-schemes-http";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { WebFetch } from "../../src/schemes/Exec.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import Results from "../../src/core/results.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, testExecutors, DEFAULT_MIMETYPES, quiesceExecs, makeSchemeCtx } from "./_helpers.ts";

const execStmt = (runtime: string, body: string): ExecStatement => ({
    op: "EXEC", suffix: "", signal: runtime, target: null,
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const parseOne = (input: string): PlurnkStatement => {
    const parsed = PlurnkParser.parse(`# PLAN0\n${input}`);
    const item = parsed.items.find((x) => x.kind === "statement" && x.statement.op !== "PLAN");
    if (item?.kind !== "statement") throw new Error(`no statement parsed from ${input}`);
    return item.statement;
};

const wire = async (opts?: {
    fetchWeb?: WebFetch;
    nullContent?: boolean;
    cancelledNullContent?: (failure: unknown, signal: AbortSignal) => void;
    unsupportedNullUrl?: string;
    tag?: string;
    webScheme?: boolean;
    encodedPath?: boolean;
    entryFailure?: boolean;
}) => {
    // testExecutors() is a module singleton, so each wire() must claim a DISTINCT runtime tag —
    // {§executor-runtime-declaration}: one canonical runtime tag has one owner.
    const tag = opts?.tag ?? "stubsearch";
    const db = await openMigrated();
    const schemes = new SchemeRegistry(opts?.fetchWeb ? { fetchWeb: opts.fetchWeb } : undefined);
    if (opts?.webScheme) await schemes.discoverExternal(process.cwd());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    engine.setExecutors(await testExecutors());
    schemes.registerRuntimeSchemes(await testExecutors());
    // The stub runtime: fetches nothing — materializes two "pages" through the sink, one of
    // which fails (pruned executor-side), then returns clean. Effect 'pure' so no proposal gate.
    // With nullContent, it instead hands content:null so core fetches through the sink's WebFetch.
    engine.registerRuntime(tag, {
        executor: {
            runtime: tag,
            glyph: "?",
            get manifest() { return { name: tag, channels: { results: "text/plain" }, defaultChannel: "results", category: "data", writableBy: ["plugin"], volatile: true, modelVisible: true } as never; },
            get defaultChannel() { return "results"; },
            get channels() { return { results: { mimetype: "text/plain" } }; },
            effect: () => "pure" as const,
            probe: async () => ({ available: true as const, detail: undefined }),
            run: async (args) => {
                if (opts?.entryFailure) {
                    let pruned = false;
                    try {
                        await args.entry?.("https://example.org/rejected", "rejected", {
                            tags: ["rejected_query"],
                            mimetype: "text/plain",
                        });
                    } catch {
                        pruned = true;
                    }
                    args.write("results", JSON.stringify([{ pruned }]), "application/json");
                    args.setState("results", "closed");
                    return { status: 200, exitCode: 0 };
                }
                if (opts?.encodedPath) {
                    await args.entry?.("https://example.org/people_%28current%29", "heading\nspouse: Example Person\nfooter", { tags: ["people_query"], mimetype: "text/markdown" });
                    args.write("results", "[]", "application/json");
                    args.setState("results", "closed");
                    return { status: 200, exitCode: 0 };
                }
                if (opts?.unsupportedNullUrl !== undefined) {
                    const entry = args.entry;
                    let rejected = false;
                    try {
                        await entry?.(opts.unsupportedNullUrl, null, { tags: ["unsupported_query"] });
                    } catch {
                        rejected = true;
                    }
                    args.write("results", JSON.stringify([{ rejected }]), "application/json");
                    args.setState("results", "closed");
                    return { status: 200, exitCode: 0 };
                }
                if (opts?.cancelledNullContent !== undefined) {
                    const entry = args.entry;
                    try {
                        await entry?.("https://93.184.216.34/cancelled", null, { tags: ["cancelled_query"] });
                    } catch (failure) {
                        opts.cancelledNullContent(failure, args.signal);
                    }
                    args.setState("results", "closed");
                    return Results.failure(
                        `executor:${tag}`,
                        "cancelled",
                        499,
                        "The test execution was cancelled.",
                    );
                }
                if (opts?.nullContent) {
                    const entry = args.entry;
                    await entry?.("https://example.org/live", null, { tags: ["turkeys_query"] });
                    let pruned = false;
                    try { await entry?.("https://example.org/dead", null, { tags: ["turkeys_query"] }); } catch { pruned = true; }
                    args.write("results", JSON.stringify([{ title: "Live", url: "https://example.org/live", pruned }]), "application/json");
                    args.setState("results", "closed");
                    return { status: 200, exitCode: 0 };
                }
                await args.entry?.("https://example.org/turkeys", "<p>wild turkeys are large birds</p>", { tags: ["turkeys_query"], mimetype: "text/html" });
                await args.entry?.("https://example.org/turkeys", "<p>wild turkeys are large birds, revised</p>", { tags: ["second_query"], mimetype: "text/html" });
                let pruned = false;
                try { await args.entry?.("not a url at all", "junk", { tags: ["x"], mimetype: "text/html" }); } catch { pruned = true; }
                args.write("results", JSON.stringify([{ title: "Turkeys", url: "https://example.org/turkeys", pruned }]), "application/json");
                args.setState("results", "closed");
                return { status: 200, exitCode: 0 };
            },
        },
        namespaceOwner: { kind: "module", name: `${tag} fixture` },
        glyph: "?", example: "", documentation: "", available: true, detail: undefined,
    });
    const workspaceId = await insertWorkspace(db, `sink-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId, null, "researcher");
    const loopId = await insertLoop(db, workerId, 1, "sink test");
    const turnId = await insertTurn(db, loopId, 1, 102);
    return { db, engine, schemes, workspaceId, workerId, loopId, turnId, tag };
};

test("entry() materializes an https resource and classifies each plurnk narration row", async () => {
    const { db, engine, schemes, workspaceId, workerId, loopId, turnId } = await wire();
    try {
        const result = await engine.dispatch({
            statement: execStmt("stubsearch", "turkeys"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.ok(result.status < 400, `the stub spawn resolved; got ${result.status}`);
        // The spawn streams — run() completes in the background. idle() is the complete barrier:
        // it drains the tail INCLUDING the entry()/narration writes, so both narration rows are
        // committed and no write is left in flight to race the db.close below.
        await quiesceExecs(schemes);
        const resultChannel = await db.test_get_channel_by_pathname_scheme.get<{
            content: string;
            mimetype: string;
        }>({ pathname: "/1/1/1", scheme: "stubsearch", name: "results" });
        assert.equal(resultChannel?.mimetype, "application/json", "the consumer persists the executor's per-write output type");
        assert.deepEqual(JSON.parse(resultChannel?.content ?? "null"), [{
            title: "Turkeys",
            url: "https://example.org/turkeys",
            pruned: true,
        }]);
        // The entry exists with the second write's content; classifications live on receipts.
        const entry = await db.test_entries_by_pathname.get<{ id: number; scheme: string }>({ pathname: "/example.org/turkeys" });
        assert.ok(entry !== undefined, "the https entry materialized (authority folded into the pathname)");
        assert.equal(entry.scheme, "https");
        // The ambience: the reserved plurnk worker carries ONE narration row per write (2 here), the
        // fs-fiction shape — origin plurnk, source = the calling worker, tokens on the meta line.
        const plurnkWorker = await db.envelope_get_worker_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "plurnk" });
        assert.ok(plurnkWorker !== undefined, "the reserved plurnk worker exists");
        const rows = await db.test_log_entries_by_worker_op.all<{ pathname: string; source: string; tokens: number; attrs: string }>({ worker_id: plurnkWorker.id, op: "EDIT" });
        const narrations = rows.filter((r) => r.pathname === "/example.org/turkeys");
        assert.equal(narrations.length, 2, "one narration row per entry() write");
        assert.equal(narrations[0]?.source, "worker://researcher", "source uses the calling worker's control identity");
        assert.ok((narrations[0]?.tokens ?? 0) > 0, "the row carries the write's real token weight");
        assert.equal(JSON.parse(narrations[0]?.attrs ?? "{}").kind, "entry_materialized", "machine acquisition is typed so live clients compact it without erasing durable history");
        assert.deepEqual(
            await db.test_log_tags_by_worker.all<{ coordinate: string; tag: string }>({ worker_id: plurnkWorker.id }),
            [
                { coordinate: "1/1/1", tag: "turkeys_query" },
                { coordinate: "1/1/2", tag: "second_query" },
            ],
            "each materialization classifies its own receipt at creation",
        );

        // {§env-delta-entry-materialization} — durable narration retains the
        // write statement and its source-numbered resulting span.
        const full = await db.test_log_entries_by_worker_op_full.all<{ pathname: string; tx: string; rx: string }>({ worker_id: plurnkWorker.id, op: "EDIT" });
        const second = full.filter((r) => r.pathname === "/example.org/turkeys")[1];
        assert.ok(second !== undefined, "the second narration row is present");
        const tx = JSON.parse(second.tx) as { op: string; body: string };
        assert.equal(tx.body, "<p>wild turkeys are large birds, revised</p>", "tx.body IS the raw transmitted content — the journal can replay the write");
        const rx = JSON.parse(second.rx) as { status: number; span: string };
        assert.equal(rx.span, "1:wild turkeys are large birds, revised", "rx.span is the DECISIVE stored form (the readable projection), line-numbered — not the raw markup");

        // The packet gate (the render the model actually sees): folded by default the meta line
        // projects the machine-created entry as an ordinary system READ, carrying the honest OPEN
        // cost — real tokens + lines, no body riding. Durable storage remains the typed EDIT above.
        const view = (folded: boolean): object[] => [{
            coordinate: "1/1/2", origin: "plurnk", op: "EDIT", suffix: "", signal: null,
            target: { scheme: "https", username: null, password: null, hostname: null, port: null, pathname: "/example.org/turkeys", query: null, fragment: null },
            status: rx.status, rx, mimetype_rx: "application/json", tx, mimetype_tx: "application/json",
            folded, source: "worker://researcher", attrs: { kind: "entry_materialized" }, tags: ["second_query"],
        }];
        const countTokens = (t: string): number => Math.ceil(t.length / 4);
        const foldedLine = PacketWire.renderLog(view(true), countTokens);
        assert.match(foldedLine, /"path":"log:\/\/\/[^\"]+\/READ"/, "machine acquisition presents the resulting readable resource, not an authored EDIT");
        assert.match(foldedLine, /"path":"log:\/\/\/1\/1\/2\/READ"/, "the model-facing log handle agrees with the projected operation");
        assert.doesNotMatch(foldedLine, /\/EDIT"/, "the internal storage operation does not leak into model reasoning");
        assert.match(foldedLine, /"display":"folded"/, "a sink resource row is folded by default — display:folded, OPENable");
        assert.match(foldedLine, /"tokens":\d*[1-9]/, "the folded meta line carries a real OPEN cost, not 0");
        assert.match(foldedLine, /"lines":1/, "the meta line carries the line count for slice planning");
        assert.ok(!foldedLine.includes("wild turkeys"), "folded = no body rides the packet");
        const openLine = PacketWire.renderLog(view(false), countTokens);
        assert.ok(openLine.includes("1:wild turkeys are large birds, revised"), "opened, the full written content renders line-numbered");
        const sig = await db.test_log_entries_by_worker_op_signal.all<{ signal: string | null }>({ worker_id: plurnkWorker.id, op: "EDIT" });
        assert.ok(sig.some((r) => /turkeys_query/.test(r.signal ?? "")), "SIGNAL carries the tags — the same slot a model's EDIT[tags] uses, so renderers show them natively");
    } finally { await quiesceExecs(schemes); await schemes.close(); await db.close(); }
});

test("entry() preserves an exact failed write Problem on its durable narration row", async (t) => {
    const { db, engine, schemes, workspaceId, workerId, loopId, turnId, tag } = await wire({
        tag: "stubsearch-entry-failure",
        entryFailure: true,
    });
    const writeEntry = EntryCrud.writeEntry.bind(EntryCrud);
    t.mock.method(EntryCrud, "writeEntry", async (...args: Parameters<typeof EntryCrud.writeEntry>) => {
        const [, , , scheme] = args;
        return scheme === "https"
            ? Results.failure(
                "scheme:https",
                "materialization-refused",
                422,
                "The fetched resource has no model-facing content.",
                { created: false, entryId: null },
                {
                    stage: "materialization",
                    target: "https://example.org/rejected",
                    retryable: false,
                },
            ) as Awaited<ReturnType<typeof EntryCrud.writeEntry>>
            : writeEntry(...args);
    });
    try {
        const accepted = await engine.dispatch({
            statement: execStmt(tag, "rejected"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.ok(accepted.status < 400);
        await quiesceExecs(schemes);

        const plurnkWorker = await db.envelope_get_worker_by_name.get<{ id: number }>({
            workspace_id: workspaceId,
            name: "plurnk",
        });
        assert.ok(plurnkWorker !== undefined);
        const rows = await db.test_log_entries_by_worker_op_full.all<{
            pathname: string;
            rx: string;
            status_rx: number;
        }>({ worker_id: plurnkWorker.id, op: "EDIT" });
        const failure = rows.find((row) => row.pathname === "/example.org/rejected");
        assert.ok(failure !== undefined, "the rejected materialization remains durable evidence");
        assert.equal(failure.status_rx, 422);
        const result = JSON.parse(failure.rx) as {
            status: number;
            problem: {
                type: string;
                detail: string;
                instance?: string;
                target?: string;
            };
        };
        assert.equal(result.status, 422);
        assert.equal(
            result.problem.type,
            "https://problems.plurnk.dev/scheme/https/materialization-refused",
        );
        assert.equal(result.problem.detail, "The fetched resource has no model-facing content.");
        assert.equal(result.problem.target, "https://example.org/rejected");
        assert.match(result.problem.instance ?? "", /^log:\/\/\/\d+\/\d+\/\d+\/READ$/);
    } finally {
        await quiesceExecs(schemes);
        await schemes.close();
        await db.close();
    }
});

test("search-prefetched https content is matcher-queryable in place — no origin refetch, host identity preserved", async () => {
    const { db, engine, schemes, workspaceId, workerId, loopId, turnId, tag } = await wire({ tag: "stubsearch-query", webScheme: true });
    try {
        const search = await engine.dispatch({
            statement: execStmt(tag, "turkeys"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.ok(search.status < 400);
        await quiesceExecs(schemes);

        // This must query the decisive markdown entry search already
        // materialized. Calling Http.read here would hit the network and make a
        // deterministic integration test impossible by construction.
        const queried = await engine.dispatch({
            statement: parseOne("## FIND0 (https://example.org/turkeys)\n*large birds*") as FindStatement,
            workspaceId, workerId, loopId, turnId, sequence: 2, origin: "model",
        });
        assert.equal(queried.status, 200);

        const delivered = await db.log_read_by_coordinate.get<{ scheme: string; pathname: string; rx: string }>({
            worker_id: workerId, loop_seq: 1, turn_seq: 1, sequence: 2,
        });
        assert.equal(delivered?.scheme, "https");
        assert.equal(delivered?.pathname, "/turkeys");
        const deliveredResult = JSON.parse(delivered?.rx ?? "") as {
            matchingPathCount: number;
            matchLocationCount: number;
            results: Array<{ region?: unknown }>;
        };
        assert.equal(deliveredResult.matchingPathCount, 1);
        assert.equal(deliveredResult.matchLocationCount, 1);
        assert.equal(deliveredResult.results.length, 1);
        assert.ok(deliveredResult.results[0]?.region !== undefined);
        const stored = await db.test_entries_by_pathname.get<{ scheme: string }>({ pathname: "/example.org/turkeys" });
        assert.equal(stored?.scheme, "https", "the stored identity retains protocol + authority + path");
    } finally { await quiesceExecs(schemes); await schemes.close(); await db.close(); }
});

test("search-prefetched encoded parentheses resolve through later scoped HTTPS READs", async () => {
    const { db, engine, schemes, workspaceId, workerId, loopId, turnId, tag } = await wire({
        tag: "stubsearch-encoded-path",
        webScheme: true,
        encodedPath: true,
    });
    try {
        await engine.dispatch({
            statement: execStmt(tag, "people"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        await quiesceExecs(schemes);

        const stored = await db.test_entries_by_pathname.get<{ pathname: string }>({
            pathname: "/example.org/people_(current)",
        });
        assert.equal(stored?.pathname, "/example.org/people_(current)",
            "ingestion stores one canonical decoded identity");
        const read = await engine.dispatch({
            statement: parseOne("## READ0 (https://example.org/people_%28current%29) <2,2>") as ReadStatement,
            workspaceId, workerId, loopId, turnId, sequence: 2, origin: "model",
        });
        assert.equal(read.status, 200);
        const delivered = await db.log_read_by_coordinate.get<{ rx: string }>({
            worker_id: workerId, loop_seq: 1, turn_seq: 1, sequence: 2,
        });
        assert.match(delivered?.rx ?? "", /spouse: Example Person/,
            "the grammar-safe address resolves the canonical entry and applies its scope");
    } finally { await quiesceExecs(schemes); await schemes.close(); await db.close(); }
});

test("an exact HTTPS semantic FIND cannot leak or retarget a match from another authority", async () => {
    const { db, engine, schemes, workspaceId, workerId, loopId, turnId, tag } = await wire({ tag: "stubsearch-semantic-scope", webScheme: true });
    try {
        await engine.dispatch({
            statement: execStmt(tag, "turkeys"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        await quiesceExecs(schemes);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, mimetypes: DEFAULT_MIMETYPES });
        await EntryCrud.writeEntry("/other.example/cake", {
            channels: { body: { content: "preheat the oven and frost the birthday cake", mimetype: "text/markdown" } },
        }, ctx, "https");
        await SearchIndex.maintain(ctx);

        const queried = await engine.dispatch({
            statement: parseOne("## FIND0 (https://example.org/turkeys)\n~birthday cake") as FindStatement,
            workspaceId, workerId, loopId, turnId, sequence: 2, origin: "model",
        });
        assert.equal(queried.status, 204);
    } finally { await quiesceExecs(schemes); await schemes.close(); await db.close(); }
});

test("an absolute web URL ending in slash is one fetchable resource, not a folder FIND", async () => {
    const { db, engine, schemes, workspaceId, workerId, loopId, turnId } = await wire({ tag: "stubsearch-web-root", webScheme: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("publisher home", {
        status: 200,
        headers: { "content-type": "text/plain" },
    })) as typeof fetch;
    try {
        const result = await engine.dispatch({
            statement: parseOne("## READ0 (https://example.org/)") as ReadStatement,
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200, "the finite HTTP representation settled through exact READ");
        assert.equal(result.content, "publisher home");
        const stored = await db.test_entries_by_pathname.get<{ scheme: string; id: number }>({ pathname: "/example.org/" });
        assert.equal(stored?.scheme, "https");
        const body = stored === undefined ? undefined : await db.test_get_channel.get<{ content: string }>({ entry_id: stored.id, name: "body" });
        assert.equal(body?.content, "publisher home");
    } finally {
        globalThis.fetch = originalFetch;
        await quiesceExecs(schemes);
        await schemes.close();
        await db.close();
    }
});

test("{§exec-entry-sink}: content:null materializes a live page and prunes an unavailable one", async () => {
    // The sink's WebFetch is faked: automatic acquisition blocks localhost, so no live server can stand in for
    // the fetch. A /dead URL resolves null; anything else returns useful server XHTML.
    const fetchWeb: WebFetch = async (url) =>
        url.includes("/dead") ? null : {
            url,
            body: "<p>fetched live turkeys</p>",
            mimetype: "application/xhtml+xml",
            header: [
                "HTTP 200 OK",
                "content-type: application/xhtml+xml",
                "x-plurnk-projection-id: origin-spoof",
                "x-plurnk-request-method: GET",
                `x-plurnk-fetched-at: ${new Date().toISOString()}`,
            ].join("\n"),
        };
    const { db, engine, schemes, workspaceId, workerId, loopId, turnId, tag } = await wire({ fetchWeb, nullContent: true, tag: "stubsearch2" });
    try {
        const result = await engine.dispatch({
            statement: execStmt(tag, "turkeys"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.ok(result.status < 400, `the stub spawn resolved; got ${result.status}`);
        await quiesceExecs(schemes);

        // The LIVE url: content:null drove a fetch through the sink → { body, mimetype } → the entry materialized.
        const live = await db.test_entries_by_pathname.get<{ id: number; scheme: string }>({ pathname: "/example.org/live" });
        assert.ok(live !== undefined, "content:null triggered the fetch and the live page materialized (authority folded)");
        assert.equal(live.scheme, "https");
        // The complete HTML family stores its readable projection as the decisive text/markdown body.
        const body = await db.test_get_channel.get<{ content: string; mimetype: string }>({ entry_id: live.id, name: "body" });
        assert.equal(body?.mimetype, "text/markdown", "the fetched html projected to the decisive markdown body");
        assert.match(body?.content ?? "", /fetched live turkeys/, "the projected body carries the fetched content, not the raw markup alone");
        const header = await db.test_get_channel.get<{ content: string }>({ entry_id: live.id, name: "header" });
        const projectionEvidence = [
            ...(header?.content ?? "").matchAll(/^x-plurnk-projection-id:[ \t]*(.*)$/gim),
        ];
        assert.match(
            projectionEvidence.at(-1)?.[1] ?? "",
            /^[a-f0-9]{64}$/,
            "the shared materializer appends authoritative installed-reader identity after origin metadata",
        );

        // {§exec-entry-sink} {§web-search-retrieval}: the sink rejects an unavailable URL,
        // creates no HTTP entry, and lets the search executor prune that candidate.
        const dead = await db.test_entries_by_pathname.get<{ id: number }>({ pathname: "/example.org/dead" });
        assert.equal(dead, undefined, "a null fetch rejects the sink so no page body materializes");
    } finally { await quiesceExecs(schemes); await schemes.close(); await db.close(); }
});

test("entry(content:null) preserves caller cancellation through the real WebFetcher", async () => {
    const started = Promise.withResolvers<void>();
    const webFetcher = new WebFetcher();
    let preserved = false;
    const fetchWeb: WebFetch = (url, opts) => webFetcher.fetch(url, opts);
    const { db, engine, schemes, workspaceId, workerId, loopId, turnId, tag } = await wire({
        fetchWeb,
        tag: "stubsearch-cancelled-fetch",
        cancelledNullContent: (failure, signal) => { preserved = failure === signal.reason; },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!(signal instanceof AbortSignal)) {
            reject(new Error("checked fetch did not receive its acquisition signal"));
            return;
        }
        const cancel = () => reject(signal.reason);
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
        started.resolve();
    })) as typeof fetch;
    try {
        const result = await engine.dispatch({
            statement: execStmt(tag, "cancelled"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.ok(result.status < 400);
        await started.promise;
        const subscription = await db.test_open_subscription_for_worker.get<{ id: number }>({ worker_id: workerId });
        assert.ok(subscription !== undefined);
        await engine.cancelSubscription(subscription.id);
        await quiesceExecs(schemes);
        assert.equal(preserved, true, "the entry sink received the caller signal's exact reason, not a dead-URL error");
        const stored = await db.test_entries_by_pathname.get<{ id: number }>({ pathname: "/93.184.216.34/cancelled" });
        assert.equal(stored, undefined);
    } finally {
        globalThis.fetch = originalFetch;
        await quiesceExecs(schemes);
        await schemes.close();
        await db.close();
    }
});

test("entry(content:null) admits only HTTP acquisition targets", async () => {
    let fetches = 0;
    const fetchWeb: WebFetch = async (url) => {
        fetches += 1;
        return { url, body: "unexpected", mimetype: "text/plain" };
    };
    const { db, engine, schemes, workspaceId, workerId, loopId, turnId, tag } = await wire({
        fetchWeb,
        unsupportedNullUrl: "wss://example.org/events?topic=updates",
        tag: "stubsearch-non-http-null",
    });
    try {
        const result = await engine.dispatch({
            statement: execStmt(tag, "events"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.ok(result.status < 400);
        await quiesceExecs(schemes);
        assert.equal(fetches, 0, "the HTTP fetcher never receives a WebSocket target");
        const stored = await db.test_entries_by_pathname.get<{ id: number }>({
            pathname: "/example.org/events?topic=updates",
        });
        assert.equal(stored, undefined, "a rejected acquisition does not materialize an entry");
    } finally { await quiesceExecs(schemes); await schemes.close(); await db.close(); }
});

test("{§html-materialization}: server HTML materializes Markdown projection", async () => {
    const fetchWeb: WebFetch = async (url) =>
        url.includes("/dead") ? null : {
            url,
            body: "<html><body><h1>Headline</h1><p>useful article</p></body></html>",
            mimetype: "text/html",
        };
    const { db, engine, schemes, workspaceId, workerId, loopId, turnId, tag } = await wire({
        fetchWeb, nullContent: true, tag: "stubsearch3",
    });
    try {
        await engine.dispatch({
            statement: execStmt(tag, "turkeys"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        await quiesceExecs(schemes);

        const live = await db.test_entries_by_pathname.get<{ id: number }>({ pathname: "/example.org/live" });
        assert.ok(live !== undefined);
        const body = await db.test_get_channel.get<{ content: string; mimetype: string }>({
            entry_id: live.id, name: "body",
        });
        assert.equal(body?.mimetype, "text/markdown");
        assert.match(body?.content ?? "", /useful article/);
        assert.ok(!(body?.content ?? "").includes("<html>"), "raw HTML never becomes the decisive model/embed body");
    } finally { await quiesceExecs(schemes); await schemes.close(); await db.close(); }
});
