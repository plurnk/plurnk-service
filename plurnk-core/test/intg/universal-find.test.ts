import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import Http from "@plurnk/plurnk-schemes-http";
import type {
    FindStatement,
    ReadStatement,
    RepresentationPreparationRequest,
    RepresentationPreparationResult,
    SendStatement,
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
        writableBy: ["model"],
        volatile: false,
        modelVisible: true,
    };

    async #materialize(pathname: string, ctx: SchemeCtx): Promise<SchemeResult> {
        return ctx.entries.write(pathname, {
            channels: {
                body: {
                    content: "the universal answer is forty-two",
                    mimetype: "text/markdown",
                },
            },
        });
    }

    async prepareRepresentation(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult> {
        const result = await this.#materialize(request.pathname, ctx);
        return result.status >= 400 ? result : { status: 200 };
    }

    async prepareFind(_statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult> {
        return this.#materialize("/fact.md", ctx);
    }
}

const parseFind = (dsl: string): FindStatement => {
    const item = PlurnkParser.parse(`# PLAN0\n${dsl}`).items.find(
        (candidate) => candidate.kind === "statement" && candidate.statement.op === "FIND",
    );
    if (item?.kind !== "statement" || item.statement.op !== "FIND") {
        throw new Error(`no FIND parsed from ${dsl}`);
    }
    return item.statement;
};

const parseRead = (dsl: string): ReadStatement => {
    const item = PlurnkParser.parse(`# PLAN0\n${dsl}`).items.find(
        (candidate) => candidate.kind === "statement" && candidate.statement.op === "READ",
    );
    if (item?.kind !== "statement" || item.statement.op !== "READ") {
        throw new Error(`no READ parsed from ${dsl}`);
    }
    return item.statement;
};



const parseSend = (dsl: string): SendStatement => {
    const item = PlurnkParser.parse(`# PLAN0\n${dsl}`).items.find(
        (candidate) => candidate.kind === "statement" && candidate.statement.op === "SEND",
    );
    if (item?.kind !== "statement" || item.statement.op !== "SEND") {
        throw new Error(`no SEND parsed from ${dsl}`);
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
            statement: parseFind("## FIND0 (prepared:///*.md)\n*forty-two*"),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 200);
        const resources = JSON.parse(String(result.content)) as Array<Array<{
            path?: string;
            matchLocationCount?: number;
        }>>;
        assert.equal(resources.length, 1);
        assert.equal(resources[0]?.[0]?.path, "prepared:///fact.md");
        assert.equal(resources[0]?.[0]?.matchLocationCount, 1);
    } finally {
        await db.close();
    }
});

test("exact matcher FIND invokes preparation, then returns flat match locations", async () => {
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
            statement: parseFind("## FIND0 (prepared:///fact.md)\n*forty-two*"),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 200);
        const row = await db.log_read_by_coordinate.get<{ rx: string }>({
            worker_id: workerId,
            loop_seq: 1,
            turn_seq: 1,
            sequence: 1,
        });
        const rx = JSON.parse(row?.rx ?? "{}") as {
            content?: string;
            results?: Array<{
                region?: {
                    startLine: number;
                    startColumn: number;
                    endLine: number;
                    endColumn: number;
                };
            }>;
        };
        assert.equal(rx.results?.length, 1);
        assert.ok(rx.results?.[0]?.region !== undefined);
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
            statement: parseFind(`## FIND0 (${url})\n/Zhannetta/`),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 200);
        assert.deepEqual(requests, [url]);
        assert.equal((JSON.parse(String(result.content)) as unknown[]).length, 1);
        assert.doesNotMatch(String(result.content), /Zhannetta Nikolaevna Lotnik was his spouse/);

        const reused = await engine.dispatch({
            statement: parseFind(`## FIND0 (${url})`),
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
            statement: parseFind("## FIND0 (https://93.184.216.34/*)\n/spouse/"),
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
        assert.match(String(surveyed.content), /"matchLocationCount":1/);
        assert.doesNotMatch(String(surveyed.content), /Zhannetta Nikolaevna Lotnik was his spouse/);

        const dead = await engine.dispatch({
            statement: parseFind(`## FIND0 (${deadUrl})`),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 4,
            origin: "model",
        });
        assert.equal(dead.status, 404);
        assert.equal(dead.problem?.type, "https://problems.plurnk.dev/scheme/http/http-response-status");
        assert.deepEqual(requests, [url, deadUrl]);

        const reusedDead = await engine.dispatch({
            statement: parseFind(`## FIND0 (${deadUrl})`),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 5,
            origin: "model",
        });
        assert.equal(reusedDead.status, 404, "reacquisition preserves the exact producer result");
        assert.deepEqual(requests, [url, deadUrl, deadUrl]);
    } finally {
        globalThis.fetch = originalFetch;
        await db.close();
    }
});

test("HTTP mutation responses cannot satisfy later READ or exact FIND acquisition", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const http = new Http();
    schemes.register("http", http);
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; method: string }> = [];
    const readUrl = "https://93.184.216.34/mutation-read";
    const findUrl = "https://93.184.216.34/mutation-find";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        requests.push({ url, method });
        const body = method === "GET"
            ? `current GET representation for ${url}`
            : `mutation response for ${url}`;
        return new Response(body, {
            status: 200,
            headers: { "content-type": "text/plain" },
        });
    }) as typeof fetch;
    try {
        const workspaceId = await insertWorkspace(db, `http-method-provenance-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const dispatch = (statement: FindStatement | ReadStatement | SendStatement, sequence: number) => engine.dispatch({
            statement,
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence,
            origin: "model",
        });

        assert.equal((await dispatch(parseSend(`## SEND0 [200] (${readUrl})\nupdate`), 1)).status, 102);
        assert.equal((await dispatch(parseRead(`## READ0 (${readUrl})`), 2)).status, 200);
        const readEntry = await db.test_entries_by_pathname.get<{ id: number }>({ pathname: "/93.184.216.34/mutation-read" });
        assert.ok(readEntry !== undefined);
        const readChannels = await db.entry_read_channels.all<{ name: string; content: string }>({ entry_id: readEntry.id });
        assert.equal(readChannels.find(({ name }) => name === "body")?.content, `current GET representation for ${readUrl}`);

        assert.equal((await dispatch(parseSend(`## SEND0 [200] (${findUrl})\nupdate`), 3)).status, 102);
        const found = await dispatch(parseFind(`## FIND0 (${findUrl})\n/current GET/`), 4);
        assert.equal(found.status, 200);
        assert.equal((JSON.parse(String(found.content)) as unknown[]).length, 1);
        assert.deepEqual(requests, [
            { url: readUrl, method: "POST" },
            { url: readUrl, method: "GET" },
            { url: findUrl, method: "POST" },
            { url: findUrl, method: "GET" },
        ]);
    } finally {
        globalThis.fetch = originalFetch;
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
            statement: parseFind("## FIND0 (control-only:///**)"),
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
