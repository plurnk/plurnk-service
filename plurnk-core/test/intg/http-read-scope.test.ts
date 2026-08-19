// {§universal-read-composition} — issue #282/#283: a scoped READ of a materialized
// https entry must return exactly the scoped window on every channel. Red tests:
// they fail on the current tree and are the ground truth for the scope fix.
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
    const found = PlurnkParser.parse(`# PLAN0\n${dsl}`).items.find(
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
    schemes.register("http", new Http());
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

test("#283: a scoped READ of a materialized https entry's html channel returns exactly the window", async () => {
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

        const acquired = await dispatch(parseRead(`## READ0 (https://${HOST}/scoped)`));
        assert.equal(acquired.status, 200, "materialization read succeeds");

        const scoped = await dispatch(parseRead(`## READ0 (https://${HOST}/scoped#html) <3,16>`));
        assert.equal(scoped.status, 200, "scoped channel read succeeds");
        const result = await readContent(db, ids, sequence);
        assert.equal(
            result.content,
            windowOf(page, 3, 16),
            "the #html channel read returns exactly lines 3..16 — not the complete page",
        );
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

        const acquired = await dispatch(parseRead(`## READ0 (https://${HOST}/scoped-body)`));
        assert.equal(acquired.status, 200, "materialization read succeeds");

        const scoped = await dispatch(parseRead(`## READ0 (https://${HOST}/scoped-body) <3,16>`));
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
        const editTemplate = parseRead(`## READ0 (worker:///scope.md)`);
        const seeded = await engine.dispatch({
            statement: {
                op: "EDIT", annotation: null, delimiter: "EDIT", signal: null,
                target: { kind: "url", raw: "worker:///scope.md", scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: "/scope.md", query: null, fragment: null },
                lineMarker: null,
                body: content,
                position: { line: 1, column: 0 },
            },
            ...ids, sequence: ++sequence, origin: "model",
        }) as { status: number };
        assert.equal(seeded.status, 201, "seed edit succeeds");
        await dispatch(parseRead(`## READ0 (worker:///scope.md) <3,16>`));
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
