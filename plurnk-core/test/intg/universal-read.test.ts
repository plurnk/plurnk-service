import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser, type ParsedPath, type ReadStatement } from "@plurnk/plurnk-contracts";
import type { SchemeCtx, SchemeHandler, SchemeManifest, SchemeResult } from "@plurnk/plurnk-schemes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
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

class ResolvedEntryScheme implements SchemeHandler {
    static manifest: SchemeManifest = {
        ...EntryBackedScheme.manifest,
        name: "resolved-entry",
    };

    async resolveEntryAddress(): Promise<{ pathname: string; owner: "worker" }> {
        return { pathname: "/canonical.txt", owner: "worker" };
    }
}

class PreparedEntryScheme implements SchemeHandler {
    static manifest: SchemeManifest = {
        ...EntryBackedScheme.manifest,
        name: "prepared-entry",
    };

    async prepareRead(target: ParsedPath, ctx: SchemeCtx): Promise<SchemeResult> {
        assert.equal("lineMarker" in target, false);
        const written = await ctx.entries.write("/document.txt", {
            channels: {
                body: {
                    content: Array.from({ length: 20 }, (_, index) => `prepared ${index + 1}`).join("\n"),
                    mimetype: "text/plain",
                },
            },
            tags: [],
        });
        assert.ok(written.status === 200 || written.status === 201);
        return { status: 203, producer: "prepared-specimen" };
    }
}

const parseRead = (dsl: string): ReadStatement => {
    const item = PlurnkParser.parse(`<<PLAN::PLAN\n${dsl}`).items.find(
        (candidate) => candidate.kind === "statement" && candidate.statement.op === "READ",
    );
    if (item?.kind !== "statement" || item.statement.op !== "READ") {
        throw new Error(`no READ parsed from ${dsl}`);
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
            statement: parseRead("<<READ(entry-backed:///document.txt)::READ"),
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
            statement: parseRead("<<READ(resolved-entry:///alias.txt)<1,-1>::READ"),
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

test("scope-blind READ preparation composes producer status with core projection", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("prepared-entry", new PreparedEntryScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `prepared-read-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);

        const result = await engine.dispatch({
            statement: parseRead("<<READ(prepared-entry:///document.txt)<17,18>::READ"),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 203);
        assert.equal(result.content, "prepared 17\nprepared 18");
        assert.equal(result.producer, "prepared-specimen");
        assert.deepEqual(result.range, {
            unit: "line",
            total: 20,
            requested: [17, 18],
            returned: [17, 18],
        });
    } finally {
        await db.close();
    }
});
