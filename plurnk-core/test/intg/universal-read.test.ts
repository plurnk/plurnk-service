import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser, type FindStatement, type ParsedPath, type ReadStatement } from "@plurnk/plurnk-contracts";
import type {
    ChannelProducerResult,
    RepresentationPreparationRequest,
    RepresentationPreparationResult,
    SchemeCtx,
    SchemeHandler,
    SchemeManifest,
} from "@plurnk/plurnk-schemes";
import { Results } from "@plurnk/plurnk-schemes";
import Http from "@plurnk/plurnk-schemes-http";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { copyStmt, urlPath } from "./_dsl.ts";
import {
    DEFAULT_MIMETYPES,
    insertLoop,
    insertTurn,
    insertWorker,
    insertWorkspace,
    openMigrated,
    seedEntryWithChannel,
} from "./_helpers.ts";

class EntryBackedScheme implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "entry-backed",
        channels: { body: "text/plain" },
        defaultChannel: "body",
        category: "data",
        writableBy: ["model"],
        volatile: false,
        modelVisible: true,
    };
}

class PublicCrudTrapScheme extends EntryBackedScheme {
    static override manifest: SchemeManifest = {
        ...EntryBackedScheme.manifest,
        name: "public-crud-trap",
    };

    async readEntry(): Promise<never> {
        throw new Error("public readEntry must not be dispatched");
    }

    async writeEntry(): Promise<never> {
        throw new Error("public writeEntry must not be dispatched");
    }
}

class ResolvedEntryScheme implements SchemeHandler {
    static manifest: SchemeManifest = {
        ...EntryBackedScheme.manifest,
        name: "resolved-entry",
    };

    async resolveEntryAddress(target: ParsedPath): Promise<{ pathname: string; owner: "worker" }> {
        assert.equal(target.kind, "url");
        if (target.kind === "url") {
            assert.equal(target.pathname, "/alias_(v1).txt");
            assert.equal(target.fragment, null);
        }
        return { pathname: "/canonical.txt", owner: "worker" };
    }
}

class OwnerBoundPreparationScheme implements SchemeHandler {
    static manifest: SchemeManifest = {
        ...EntryBackedScheme.manifest,
        name: "owner-bound-preparation",
    };

    async resolveEntryAddress(): Promise<{ pathname: string; owner: "worker" }> {
        return { pathname: "/canonical.txt", owner: "worker" };
    }

    async prepareRepresentation(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult> {
        assert.equal(request.pathname, "/canonical.txt");
        const prior = await ctx.entries.read(request.pathname);
        if (prior.status === 404) {
            const written = await ctx.entries.write(request.pathname, {
                channels: {
                    body: { content: "prepared for resolved worker", mimetype: "text/plain" },
                },
            });
            assert.equal(written.status, 201);
        }
        return { status: 200 };
    }
}

// A deliberately non-network protocol specimen. It knows aliases, acquisition,
// channel topology, private attributes, and producer evidence; it knows nothing about READ,
// FIND, text scope, matching, or pagination.
class ArchiveScheme implements SchemeHandler {
    static manifest: SchemeManifest = {
        ...EntryBackedScheme.manifest,
        name: "archive",
        channels: {
            body: "text/markdown",
            provenance: "application/json",
        },
    };

    async resolveEntryAddress(): Promise<{ pathname: string; owner: "commons" }> {
        return { pathname: "/objects/document.txt", owner: "commons" };
    }

    async prepareRepresentation(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult> {
        assert.equal(Object.hasOwn(request, "intent"), false);
        assert.equal(request.pathname, "/objects/document.txt");
        assert.equal("lineMarker" in request.target, false);
        if (request.target.kind === "url") assert.equal(request.target.fragment, null);
        const prior = await ctx.entries.read(request.pathname);
        if (prior.status === 404) {
            const written = await ctx.entries.write(request.pathname, {
                channels: {
                    body: {
                        content: Array.from({ length: 20 }, (_, index) => `prepared ${index + 1}`).join("\n"),
                        mimetype: "text/markdown",
                        producerResult: { status: 203, producer: "archive-specimen" },
                    },
                    provenance: {
                        content: JSON.stringify({ source: "fixture://archive/42" }),
                        mimetype: "application/json",
                    },
                },
                attributes: { kind: "imported" },
            });
            assert.ok(written.status === 200 || written.status === 201);
        } else {
            assert.equal(prior.status, 200);
        }
        return { status: 200 };
    }
}

class IndependentChannelScheme implements SchemeHandler {
    static manifest: SchemeManifest = {
        ...EntryBackedScheme.manifest,
        name: "independent-channel",
        channels: {
            body: "text/plain",
            html: "text/html",
        },
    };

    async prepareRepresentation(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult> {
        const prior = await ctx.entries.read(request.pathname);
        if (prior.status !== 404) return { status: 200 };
        const htmlFailure = Results.failure(
            "scheme:independent-channel",
            "html-unavailable",
            502,
            "The HTML representation is unavailable.",
            {},
            { retryable: true },
        ) as ChannelProducerResult;
        const written = await ctx.entries.write(request.pathname, {
            channels: {
                body: { content: "readable body", mimetype: "text/plain" },
                html: {
                    content: "",
                    mimetype: "text/html",
                    state: "errored",
                    producerResult: htmlFailure,
                },
            },
        });
        assert.ok(written.status === 200 || written.status === 201);
        return { status: 200 };
    }
}

const parseRead = (dsl: string): ReadStatement => {
    const item = PlurnkParser.parse(`# PLAN0\n${dsl}`).items.find(
        (candidate) => candidate.kind === "statement" && candidate.statement.op === "READ",
    );
    if (item?.kind !== "statement" || item.statement.op !== "READ") {
        throw new Error(`no READ parsed from ${dsl}`);
    }
    return item.statement;
};

const parseFind = (dsl: string): FindStatement => {
    const item = PlurnkParser.parse(`# PLAN0\n${dsl}`).items.find(
        (candidate) => candidate.kind === "statement" && candidate.statement.op === "FIND",
    );
    if (item?.kind !== "statement" || item.statement.op !== "FIND") {
        throw new Error(`no FIND parsed from ${dsl}`);
    }
    return item.statement;
};

test("entry-backed data schemes inherit exact READ projection", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("entry-backed", new EntryBackedScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `universal-read-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "entry-backed",
            pathname: "/document.txt",
            channel: "body",
            content: lines.join("\n"),
            mimetype: "text/plain",
        });

        const result = await engine.dispatch({
            statement: parseRead("## READ0 (entry-backed:///document.txt)"),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 200);
        assert.equal(result.content, lines.slice(0, 16).join("\n"));
        assert.equal(result.mimetype, "text/plain");
        assert.equal(result.startLine, 1);
        assert.deepEqual(result.range, {
            unit: "line",
            total: 20,
            requested: [1, 16],
            returned: [1, 16],
        });
    } finally {
        await db.close();
    }
});

test("inherited READ uses the scheme's canonical pathname and owner", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("resolved-entry", new ResolvedEntryScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `resolved-read-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        await seedEntryWithChannel(db, {
            workspaceId,
            ownerId: workerId,
            scheme: "resolved-entry",
            pathname: "/canonical.txt",
            channel: "body",
            content: "canonical worker content",
            mimetype: "text/plain",
        });

        const result = await engine.dispatch({
            statement: parseRead("## READ0 (resolved-entry:///alias_%28v1%29.txt#body) <1,-1>"),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 200);
        assert.equal(result.content, "canonical worker content");
    } finally {
        await db.close();
    }
});

test("preparation capabilities bind to the already-resolved canonical owner", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("owner-bound-preparation", new OwnerBoundPreparationScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `owner-bound-preparation-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const result = await engine.dispatch({
            statement: parseRead("## READ0 (owner-bound-preparation:///alias.txt) <1,-1>"),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 200);
        assert.equal(result.content, "prepared for resolved worker");
    } finally {
        await db.close();
    }
});

test("scope-blind preparation durably composes producer status with cold and warm core projection", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("archive", new ArchiveScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `prepared-read-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);

        for (const sequence of [1, 2]) {
            const result = await engine.dispatch({
                statement: parseRead("## READ0 (archive:///aliases/latest) <17,18>"),
                workspaceId,
                workerId,
                loopId,
                turnId,
                sequence,
                origin: "model",
            });

            assert.equal(result.status, 203);
            assert.equal(result.content, "prepared 17\nprepared 18");
            assert.equal(result.producer, "archive-specimen");
            assert.deepEqual(result.range, {
                unit: "line",
                total: 20,
                requested: [17, 18],
                returned: [17, 18],
            });
        }
    } finally {
        await db.close();
    }
});

test("core selects one channel before applying its independent durable producer result", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("independent-channel", new IndependentChannelScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `independent-channel-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const dispatch = (statement: ReadStatement, sequence: number) => engine.dispatch({
            statement,
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence,
            origin: "model" as const,
        });

        const body = await dispatch(
            parseRead("## READ0 (independent-channel:///item) <1,-1>"),
            1,
        );
        assert.equal(body.status, 200);
        assert.equal(body.content, "readable body");

        for (const sequence of [2, 3]) {
            const html = await dispatch(
                parseRead("## READ0 (independent-channel:///item#html) <1,-1>"),
                sequence,
            );
            assert.equal(html.status, 502);
            assert.equal(html.content, "", "producer evidence composes after the selected text projection");
            assert.equal(html.channel, "html");
            assert.equal(
                html.problem?.type,
                "https://problems.plurnk.dev/scheme/independent-channel/html-unavailable",
            );
        }
    } finally {
        await db.close();
    }
});

test("exact FIND shares representation preparation but retains universal query semantics", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("archive", new ArchiveScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `prepared-find-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const result = await engine.dispatch({
            statement: parseFind("## FIND0 (archive:///aliases/latest)"),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 203);
        assert.equal(result.producer, "archive-specimen");
        assert.equal(result.matchingPathCount, 1);
        const [channels] = result.results as Array<Array<{
            path: string;
            mimetype: string;
            weight: number;
            lines: number;
        }>>;
        assert.deepEqual(channels?.map(({ path }) => path), [
            "archive:///objects/document.txt",
            "archive:///objects/document.txt#provenance",
        ]);
        assert.equal(channels?.[0]?.mimetype, "text/markdown");
        assert.equal(channels?.[0]?.lines, 20);
        assert.ok((channels?.[0]?.weight ?? 0) > 0);
    } finally {
        await db.close();
    }
});

test("COPY resolves and prepares the canonical source representation before selection", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("archive", new ArchiveScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `prepared-copy-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const result = await engine.dispatch({
            statement: copyStmt(
                urlPath("archive", "/aliases/latest"),
                urlPath("archive", "/imported.txt"),
            ),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 201, JSON.stringify(result));
        const copied = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: "/imported.txt",
            scheme: "archive",
            name: "body",
        });
        assert.equal(
            copied?.content,
            Array.from({ length: 20 }, (_, index) => `prepared ${index + 1}`).join("\n"),
            "unscoped COPY selects the complete prepared source, not READ's preview",
        );
    } finally {
        await db.close();
    }
});

test("COPY refuses a selected channel whose canonical producer outcome failed", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("independent-channel", new IndependentChannelScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `failed-copy-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const result = await engine.dispatch({
            statement: copyStmt(
                urlPath("independent-channel", "/item", "html"),
                urlPath("independent-channel", "/copied.html", "html"),
            ),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 502);
        assert.equal(
            result.problem?.type,
            "https://problems.plurnk.dev/scheme/independent-channel/html-unavailable",
        );
        const copied = await db.test_get_channel_by_pathname_scheme.get({
            pathname: "/copied.html",
            scheme: "independent-channel",
            name: "html",
        });
        assert.equal(copied, undefined);
    } finally {
        await db.close();
    }
});

test("public schemes cannot replace canonical COPY storage with incidental CRUD methods", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("public-crud-trap", new PublicCrudTrapScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `public-crud-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "public-crud-trap",
            pathname: "/source.txt",
            channel: "body",
            content: "canonical source",
            mimetype: "text/plain",
        });

        const result = await engine.dispatch({
            statement: copyStmt(
                urlPath("public-crud-trap", "/source.txt"),
                urlPath("public-crud-trap", "/destination"),
            ),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 201, JSON.stringify(result));
        const copied = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: "/destination",
            scheme: "public-crud-trap",
            name: "body",
        });
        assert.equal(copied?.content, "canonical source");
    } finally {
        await db.close();
    }
});

test("cold finite HTTP READ acquires before applying the exact text scope", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("http", new Http());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    const originalFetch = globalThis.fetch;
    const lines = Array.from({ length: 20 }, (_, index) => `remote ${index + 1}`);
    const requests: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
        requests.push(String(input));
        return new Response(lines.join("\n"), {
            status: 200,
            headers: { "content-type": "text/plain" },
        });
    }) as typeof fetch;
    try {
        const workspaceId = await insertWorkspace(db, `http-read-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);

        const result = await engine.dispatch({
            statement: parseRead("## READ0 (https://93.184.216.34/document.txt) <17,18>"),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 200);
        assert.equal(result.content, "remote 17\nremote 18");
        assert.deepEqual(result.range, {
            unit: "line",
            total: 20,
            requested: [17, 18],
            returned: [17, 18],
        });
        assert.deepEqual(requests, ["https://93.184.216.34/document.txt"]);
        const subscriptions = await db.test_count_subscriptions_for_worker.get<{ n: number }>({ worker_id: workerId });
        assert.equal(subscriptions?.n, 0, "a finite representation never opens a subscription");
    } finally {
        globalThis.fetch = originalFetch;
        await db.close();
    }
});
