import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-grammar";
import Http from "@plurnk/plurnk-schemes-http";
import type {
    FindStatement,
    ReadStatement,
    SchemeCtx,
    SchemeHandler,
    SchemeManifest,
    SchemeResult,
} from "@plurnk/plurnk-schemes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import {
    DEFAULT_MIMETYPES,
    insertLoop,
    insertTurn,
    insertWorker,
    insertWorkspace,
    openMigrated,
} from "./_helpers.ts";

class PreparedDataScheme implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "prepared",
        channels: { body: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        scope: "workspace",
        writableBy: ["model"],
        volatile: false,
        modelVisible: true,
    };

    async prepareFind(_statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult> {
        return ctx.entries.write("/fact.md", {
            channels: {
                body: {
                    content: "the universal answer is forty-two",
                    mimetype: "text/markdown",
                },
            },
            tags: [],
        });
    }
}

const parseFind = (dsl: string): FindStatement => {
    const item = PlurnkParser.parse(`<<PLAN::PLAN\n${dsl}`).items.find(
        (candidate) => candidate.kind === "statement" && candidate.statement.op === "FIND",
    );
    if (item?.kind !== "statement" || item.statement.op !== "FIND") {
        throw new Error(`no FIND parsed from ${dsl}`);
    }
    return item.statement;
};

const parseRead = (dsl: string): ReadStatement => {
    const item = PlurnkParser.parse(`<<PLAN::PLAN\n${dsl}`).items.find(
        (candidate) => candidate.kind === "statement" && candidate.statement.op === "READ",
    );
    if (item?.kind !== "statement" || item.statement.op !== "READ") {
        throw new Error(`no READ parsed from ${dsl}`);
    }
    return item.statement;
};

test("data schemes inherit standard FIND after their optional preparation hook", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("prepared", new PreparedDataScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `universal-find-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const result = await engine.dispatch({
            statement: parseFind("<<FIND(prepared:///fact.md):*forty-two*:FIND"),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 200);
        assert.match(String(result.content), /prepared:\/\/\/fact\.md/);
        assert.match(String(result.content), /"matches"/);
    } finally {
        await db.close();
    }
});

test("matcher READ invokes preparation, then returns one selected resource with navigation evidence", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("prepared", new PreparedDataScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `universal-read-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const result = await engine.dispatch({
            statement: parseRead("<<READ(prepared:///fact.md):*forty-two*:READ"),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 200);
        assert.equal(result.rowsWritten, 1);
        const row = await db.log_read_by_coordinate.get<{ rx: string }>({
            worker_id: workerId,
            loop_seq: 1,
            turn_seq: 1,
            sequence: 1,
        });
        const rx = JSON.parse(row?.rx ?? "{}") as {
            content?: string;
            matches?: Array<{
                region?: {
                    startLine: number;
                    startColumn: number;
                    endLine: number;
                    endColumn: number;
                };
            }>;
        };
        assert.equal(rx.content, "the universal answer is forty-two");
        assert.deepEqual(rx.matches, [{
            region: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 34 },
        }]);
    } finally {
        await db.close();
    }
});

test("exact URL FIND acquires live HTTP resources, reuses them, and rejects dead URLs", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const http = new Http();
    schemes.register("http", http);
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    const url = "https://93.184.216.34/igor-smirnov";
    const deadUrl = "https://93.184.216.34/missing";
    globalThis.fetch = (async (input: string | URL | Request) => {
        const requested = String(input);
        requests.push(requested);
        if (requested === deadUrl) return new Response("missing", { status: 404 });
        return new Response("Zhannetta Nikolaevna Lotnik was his spouse.", {
            status: 200,
            headers: { "content-type": "text/plain" },
        });
    }) as typeof fetch;
    try {
        const workspaceId = await insertWorkspace(db, `universal-find-http-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const result = await engine.dispatch({
            statement: parseFind(`<<FIND(${url}):/Zhannetta/:FIND`),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 200);
        assert.deepEqual(requests, [url]);
        assert.match(String(result.content), new RegExp(url.replaceAll(".", "\\.")));
        assert.match(String(result.content), /"matches"/);
        assert.doesNotMatch(String(result.content), /Zhannetta Nikolaevna Lotnik was his spouse/);

        const reused = await engine.dispatch({
            statement: parseFind(`<<FIND(${url})::FIND`),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 2,
            origin: "model",
        });
        assert.equal(reused.status, 200);
        assert.deepEqual(requests, [url]);
        assert.match(String(reused.content), new RegExp(url.replaceAll(".", "\\.")));
        assert.doesNotMatch(String(reused.content), /Zhannetta Nikolaevna Lotnik was his spouse/);

        const surveyed = await engine.dispatch({
            statement: parseFind("<<FIND(https://93.184.216.34/*):/spouse/:FIND"),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 3,
            origin: "model",
        });
        assert.equal(surveyed.status, 200);
        assert.deepEqual(requests, [url]);
        assert.match(String(surveyed.content), new RegExp(url.replaceAll(".", "\\.")));
        assert.match(String(surveyed.content), /"matches"/);
        assert.doesNotMatch(String(surveyed.content), /Zhannetta Nikolaevna Lotnik was his spouse/);

        const dead = await engine.dispatch({
            statement: parseFind(`<<FIND(${deadUrl})::FIND`),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 4,
            origin: "model",
        });
        assert.equal(dead.status, 404);
        assert.equal(dead.problem?.type, "https://problems.plurnk.dev/scheme/http/not-materialized");
        assert.deepEqual(requests, [url, deadUrl]);
    } finally {
        globalThis.fetch = originalFetch;
        await http.close();
        await db.close();
    }
});

test("non-data schemes without FIND remain honestly unsupported", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    class ControlScheme {
        static manifest: SchemeManifest = {
            name: "control-only",
            channels: {},
            defaultChannel: "body",
            category: "control",
            scope: "workspace",
            writableBy: ["model"],
            volatile: false,
            modelVisible: true,
        };
    }
    schemes.register("control-only", new ControlScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `universal-find-control-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const result = await engine.dispatch({
            statement: parseFind("<<FIND(control-only:///**)::FIND"),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });
        assert.equal(result.status, 501);
    } finally {
        await db.close();
    }
});
