// {§universal-read-composition}
import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import type { ReadStatement } from "@plurnk/plurnk-contracts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Http from "@plurnk/plurnk-schemes-http";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn } from "./_helpers.ts";

const HOST = "93.184.216.34";

// 20 numbered source lines; a page this size is trivially real, and the
// numbering makes any window violation self-evident.
const htmlPage = (): string => [
    "<!DOCTYPE html>",
    "<html>",
    "<head><title>scope fixture</title></head>",
    "<body>",
    ...Array.from({ length: 20 }, (_, i) => `<p>line-${i + 5}</p>`),
    "</body>",
    "</html>",
    "",
].join("\n");

const parseRead = (dsl: string): ReadStatement => {
    const found = PlurnkParser.parse(`${dsl}`).items.find(
        (item) => item.kind === "statement" && item.statement.op === "READ",
    );
    if (found === undefined) throw new Error(`no READ parsed from: ${dsl}`);
    return (found as { kind: "statement"; statement: ReadStatement }).statement;
};

const setup = async () => {
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `http-scope-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "scope");
    const turnId = await insertTurn(db, loopId, 1, 102);
    const schemes = new SchemeRegistry();
    schemes.register("https", new Http());
    const engine = new Engine({ db, schemes, mimetypes });
    return { db, engine, mimetypes, ids: { workspaceId, workerId, loopId, turnId } };
};

const readContent = async (
    db: Db, ids: { workspaceId: number; workerId: number; loopId: number; turnId: number }, sequence: number,
): Promise<{ content: string | null; status: number }> => {
    const row = await db.log_read_by_coordinate.get<{ rx: string }>({
        worker_id: ids.workerId, loop_seq: 1, turn_seq: 1, sequence,
    });
    if (row === undefined) throw new Error(`no stored result for sequence ${sequence}`);
    return JSON.parse(row.rx) as { content: string | null; status: number };
};

const windowOf = (source: string, first: number, last: number): string =>
    source.split("\n").slice(first - 1, last).join("\n");

for (const pretty of [false, true]) {
    for (const prepared of [false, true]) {
        test(`{§universal-read-composition}: HTTP JSONPath locations drive scoped property READs (${pretty ? "pretty" : "compact"}, ${prepared ? "warm" : "cold"})`, async (t) => {
            const { db, engine, ids } = await setup();
            t.after(() => db.close());
            const releases = [
                { version: "v26.8.1", lts: false },
                { version: "v24.14.0", lts: "Krypton" },
                { version: "v22.18.0", lts: "Jod" },
            ];
            const requests: string[] = [];
            t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
                if (String(input).endsWith("/llms.txt")) return new Response(null, { status: 404 });
                requests.push(String(input));
                return new Response(JSON.stringify(releases, null, pretty ? 2 : undefined), {
                    headers: { "content-type": "application/json", "cache-control": "max-age=120" },
                });
            });
            let sequence = 0;
            const run = async (header: string, body: string | null = null) => {
                const parsed = PlurnkParser.parseStatements(PlurnkParser.frame(header, body));
                assert.equal(parsed.items.length, 1);
                const item = parsed.items[0];
                assert.ok(item?.kind === "statement");
                await engine.dispatch({ statement: item.statement, ...ids, sequence: ++sequence, origin: "model" });
                return readContent(db, ids, sequence);
            };
            const url = `https://${HOST}/dist/index.json`;
            if (prepared) assert.equal((await run(`READ (${url})`)).status, 200);
            const found = await run(`FIND (${url}) [${JSON.stringify({ pattern: "$[?(@.lts != false)].version" })}]`);
            assert.equal(found.status, 200);
            assert.ok(found.content);
            const locations = JSON.parse(found.content) as Array<{
                channel: string;
                region: { startLine: number; startColumn: number; endLine: number; endColumn: number };
            }>;
            assert.equal(locations.length, 2, "the filter excludes the current non-LTS release");
            const values: string[] = [];
            for (const { channel, region } of locations) {
                assert.equal(channel, "body");
                assert.ok(region, "the selected value has readable text coordinates");
                const { startLine, startColumn, endLine, endColumn } = region;
                const value = await run(`READ (${url}#${channel}) <${startLine},${startColumn},${endLine},${endColumn}>`);
                assert.equal(value.status, 200);
                assert.ok(value.content);
                values.push(value.content);
            }
            assert.deepEqual(values, ['"version": "v24.14.0"', '"version": "v22.18.0"'], "each READ returns the matching property's region, without unrelated fields");
            assert.deepEqual(requests, [url], "scoped follow-up reads reuse the acquired representation");
        });
    }
}

test("#283: a scoped READ of a materialized https page's source returns exactly the window", async () => {
    const { db, engine, ids } = await setup();
    const originalFetch = globalThis.fetch;
    try {
        const page = htmlPage();
        globalThis.fetch = (async (input: string | URL | Request) => {
            if (String(input).endsWith("/llms.txt")) return new Response(null, { status: 404 });
            return new Response(page, {
                status: 200, statusText: "OK", headers: { "content-type": "text/html" },
            });
        }) as typeof fetch;
        let sequence = 0;
        const dispatch = async (statement: ReadStatement) => (await engine.dispatch({
            statement, ...ids, sequence: ++sequence, origin: "model",
        })) as { status: number; rowsWritten?: number };

        const acquired = await dispatch(parseRead(`\`\`\`READ (https://${HOST}/scoped)\`\`\``));
        assert.equal(acquired.status, 200, "materialization read succeeds");

        // {§readable-channel} — a page's server source is its default channel.
        const scoped = await dispatch(parseRead(`\`\`\`READ (https://${HOST}/scoped) <3,16>\`\`\``));
        assert.equal(scoped.status, 200, "scoped source read succeeds");
        const result = await readContent(db, ids, sequence);
        assert.equal(
            result.content,
            windowOf(page, 3, 16),
            "the source read returns exactly lines 3..16 — not the complete page",
        );
        const projection = await dispatch(parseRead(`\`\`\`READ (https://${HOST}/scoped#readable) <1,-1>\`\`\``));
        assert.equal(projection.status, 200, "the readable projection is one fragment away");
    } finally {
        globalThis.fetch = originalFetch;
        await db.close();
    }
});

test("#283: a scoped READ of a materialized https entry's body channel returns exactly the window", async () => {
    const { db, engine, ids } = await setup();
    const originalFetch = globalThis.fetch;
    try {
        const page = htmlPage();
        globalThis.fetch = (async (input: string | URL | Request) => {
            if (String(input).endsWith("/llms.txt")) return new Response(null, { status: 404 });
            return new Response(page, {
                status: 200, statusText: "OK", headers: { "content-type": "text/plain" },
            });
        }) as typeof fetch;
        let sequence = 0;
        const dispatch = async (statement: ReadStatement) => (await engine.dispatch({
            statement, ...ids, sequence: ++sequence, origin: "model",
        })) as { status: number; rowsWritten?: number };

        const acquired = await dispatch(parseRead(`\`\`\`READ (https://${HOST}/scoped-body)\`\`\``));
        assert.equal(acquired.status, 200, "materialization read succeeds");

        const scoped = await dispatch(parseRead(`\`\`\`READ (https://${HOST}/scoped-body) <3,16>\`\`\``));
        assert.equal(scoped.status, 200, "scoped read succeeds");
        const result = await readContent(db, ids, sequence);
        assert.equal(
            result.content,
            windowOf(page, 3, 16),
            "the default-channel read returns exactly lines 3..16",
        );
    } finally {
        globalThis.fetch = originalFetch;
        await db.close();
    }
});

test("#283: a scoped READ of a project file still returns exactly the window", async () => {
    const { db, engine, ids } = await setup();
    try {
        let sequence = 0;
        const dispatch = async (statement: ReadStatement) => (await engine.dispatch({
            statement, ...ids, sequence: ++sequence, origin: "model",
        })) as { status: number; rowsWritten?: number };
        const content = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join("\n");
        const seeded = await engine.dispatch({
            statement: {
                metadata: null,
                op: "EDIT", aside: null,
                target: { kind: "url", raw: "worker:///scope.md", scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: "/scope.md", query: null, fragment: null },
                lineMarker: null,
                matcher: null, body: content,
                position: { line: 1, column: 0 },
            },
            ...ids, sequence: ++sequence, origin: "model",
        }) as { status: number };
        assert.equal(seeded.status, 201, "seed edit succeeds");
        await dispatch(parseRead(`\`\`\`READ (worker:///scope.md) <3,16>\`\`\``));
        const result = await readContent(db, ids, sequence);
        assert.equal(
            result.content,
            windowOf(content, 3, 16),
            "the worker-entry read returns exactly lines 3..16",
        );
    } finally {
        await db.close();
    }
});

test("#287: matcher FIND locations name the channel they address", async () => {
    const { db, engine, ids } = await setup();
    const originalFetch = globalThis.fetch;
    try {
        const page = [
            "<!DOCTYPE html>",
            "<html>",
            "<head><title>t</title></head>",
            "<body>",
            "<p>v26.7.0 current</p>",
            "<p>v24.18.1 lts</p>",
            "</body>",
            "</html>",
            "",
        ].join("\n");
        globalThis.fetch = (async (input: string | URL | Request) => {
            if (String(input).endsWith("/llms.txt")) return new Response(null, { status: 404 });
            return new Response(page, {
                status: 200, statusText: "OK", headers: { "content-type": "text/html" },
            });
        }) as typeof fetch;
        let sequence = 0;
        const parseFind = (dsl: string): ReadStatement => {
            const found = PlurnkParser.parse(`${dsl}`).items.find(
                (item) => item.kind === "statement" && item.statement.op === (dsl.startsWith("```READ") ? "READ" : "FIND"),
            );
            if (found === undefined) throw new Error(`no statement parsed from: ${dsl}`);
            return (found as { kind: "statement"; statement: ReadStatement }).statement;
        };
        const dispatch = async (dsl: string) => (await engine.dispatch({
            statement: parseFind(dsl), ...ids, sequence: ++sequence, origin: "model",
        })) as unknown as { status: number };

        const acquired = await dispatch("```READ (https://93.184.216.34/channel-facts)```");
        assert.equal(acquired.status, 200, "materialization read succeeds");

        await dispatch("```FIND (https://93.184.216.34/channel-facts) [{\"pattern\":\"/v[0-9.]+/i\"}]```");
        const bodyFind = await readContent(db, ids, sequence);
        const bodyLocations = JSON.parse(String(bodyFind.content ?? "[]")) as Array<{ channel?: string }>;
        assert.ok(bodyLocations.length > 0, "the default-channel FIND reports match locations");
        for (const location of bodyLocations) {
            assert.equal(location.channel, "body", "a default-channel match names the body channel");
        }

        await dispatch("```FIND (https://93.184.216.34/channel-facts#readable) [{\"pattern\":\"/v[0-9.]+/i\"}]```");
        const readableFind = await readContent(db, ids, sequence);
        const readableLocations = JSON.parse(String(readableFind.content ?? "[]")) as Array<{ channel?: string }>;
        assert.ok(readableLocations.length > 0, "the #readable-channel FIND reports match locations");
        for (const location of readableLocations) {
            assert.equal(location.channel, "readable", "a #readable-channel match names the readable channel");
        }
    } finally {
        globalThis.fetch = originalFetch;
        await db.close();
    }
});
