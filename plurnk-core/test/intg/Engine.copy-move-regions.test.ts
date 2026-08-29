import assert from "node:assert/strict";
import test from "node:test";
import type {
    ResolvedEditStatement,
    SchemeCtx,
    SchemeHandler,
    SchemeManifest,
} from "@plurnk/plurnk-schemes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import LineAnchors from "../../src/content/line-anchors.ts";
import Owner from "../../src/core/Owner.ts";
import type { EntryData } from "../../src/schemes/_entry-crud.ts";
import {
    makeSchemeCtx,
    openMigrated,
    seedEnvelope,
} from "./_helpers.ts";
import {
    copyStmt,
    moveStmt,
    readStmt,
    urlPath,
} from "./_dsl.ts";

type EffectView = {
    readonly target: string;
    readonly action: "create" | "update" | "delete";
    readonly receipt?: {
        readonly unit: "lines" | "codePoints";
        readonly effect: {
            readonly requested: string;
            readonly source: string;
            readonly result: string;
        };
    };
};

const effectsOf = (result: unknown): readonly EffectView[] => {
    assert.ok(result !== null && typeof result === "object");
    const effects = (result as { readonly effects?: unknown }).effects;
    assert.ok(Array.isArray(effects), "a landed COPY/MOVE reports resource effects");
    return effects as readonly EffectView[];
};

class MultiChannelScheme implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "multi",
        channels: {
            aux: "text/markdown",
            blob: "application/octet-stream",
            body: "text/markdown",
            notes: "text/markdown",
        },
        defaultChannel: "body",
        category: "data",
        entryOwner: "commons",
        inherit: "none",
        writableBy: ["model", "client"],
        volatile: false,
        modelVisible: true,
        textEditScopes: true,
    };

    async editBatch(
        statements: readonly ResolvedEditStatement[],
        ctx: SchemeCtx,
    ) {
        return ctx.entries.operations.editBatch(statements);
    }
}

const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `copy-move-region-${crypto.randomUUID()}`, { producer: "client" });
    const schemes = new SchemeRegistry();
    schemes.register("multi", new MultiChannelScheme());
    const engine = new Engine({ db, schemes });
    const ctx = makeSchemeCtx({
        db,
        workspaceId: env.workspaceId,
        workerId: env.workerId,
    });
    const ownerId = await Owner.commonsId(db, env.workspaceId);
    const seed = (pathname: string, entry: EntryData) =>
        EntryCrud.writeEntry({ authority: "", pathname }, entry, ctx, "multi", ownerId);
    const read = (pathname: string) =>
        EntryCrud.readEntry({ authority: "", pathname }, ctx, "multi", ownerId);
    let sequence = 0;
    const dispatch = (statement: Parameters<Engine["dispatch"]>[0]["statement"]) =>
        engine.dispatch({
            statement,
            workspaceId: env.workspaceId,
            workerId: env.workerId,
            loopId: env.loopId,
            turnId: env.turnId,
            sequence: sequence += 1,
            origin: "client",
        });
    return { db, env, seed, read, dispatch };
};

test("COPY transfers only the selected channel and classifies its log receipt", async () => {
    const { db, env, seed, read, dispatch } = await setup();
    try {
        await seed("/source", {
            channels: {
                body: { content: "source body", mimetype: "text/markdown" },
                notes: { content: "selected notes", mimetype: "text/markdown" },
            },
        });
        await seed("/destination", {
            channels: {
                body: { content: "destination body", mimetype: "text/markdown" },
            },
        });

        const result = await dispatch(copyStmt(
            urlPath("multi", "/source", "notes"),
            urlPath("multi", "/destination", "aux"),
            ["+explicit"],
        ));
        assert.equal(result.status, 200);
        assert.deepEqual(effectsOf(result), [{
            target: "multi:///destination#aux",
            action: "create",
        }]);

        const source = await read("/source");
        assert.equal(source.entry?.channels.body?.content, "source body");
        assert.equal(source.entry?.channels.notes?.content, "selected notes");
        const destination = await read("/destination");
        assert.equal(destination.entry?.channels.body?.content, "destination body");
        assert.equal(destination.entry?.channels.aux?.content, "selected notes");
        assert.deepEqual(
            await db.test_log_tags_by_worker.all<{ coordinate: string; tag: string }>({ worker_id: env.workerId }),
            [{ coordinate: "1/1/1", tag: "explicit" }],
        );
    } finally {
        await db.close();
    }
});

test("COPY composes source selection and destination insertion with Unicode code-point coordinates", async () => {
    const { db, seed, read, dispatch } = await setup();
    try {
        await seed("/source", {
            channels: {
                body: { content: "A😀B\n", mimetype: "text/markdown" },
            },
        });
        await seed("/destination", {
            channels: {
                body: { content: "xy\n", mimetype: "text/markdown" },
            },
        });

        const result = await dispatch(copyStmt(
            urlPath("multi", "/source"),
            urlPath("multi", "/destination"),
            null,
            { marks: [1, 2, 1, 3] },
            { marks: [1, 2, 1, 2] },
        ));
        assert.equal(result.status, 200);
        const effects = effectsOf(result);
        assert.deepEqual(
            effects.map(({ target, action }) => ({ target, action })),
            [{ target: "multi:///destination", action: "update" }],
        );
        assert.equal(effects[0]?.receipt?.unit, "codePoints");
        assert.equal(effects[0]?.receipt?.effect.requested, "<1,2,1,2>");
        assert.equal((await read("/destination")).entry?.channels.body?.content, "x😀y\n");
        assert.equal((await read("/source")).entry?.channels.body?.content, "A😀B\n");
    } finally {
        await db.close();
    }
});

test("COPY resolves line anchors independently at its source and destination", async () => {
    const { db, seed, read, dispatch } = await setup();
    try {
        const source = "alpha\nbeta\ngamma";
        const destination = "one\ntwo\nthree";
        await seed("/source", {
            channels: { body: { content: source, mimetype: "text/markdown" } },
        });
        await seed("/destination", {
            channels: { body: { content: destination, mimetype: "text/markdown" } },
        });

        const result = await dispatch(copyStmt(
            urlPath("multi", "/source"),
            urlPath("multi", "/destination"),
            null,
            { marks: [LineAnchors.token("multi:///source", 2, source)] },
            { marks: [LineAnchors.token("multi:///destination", 2, destination)] },
        ));
        assert.equal(result.status, 200);
        assert.equal((await read("/source")).entry?.channels.body?.content, source);
        assert.equal((await read("/destination")).entry?.channels.body?.content, "one\nbeta\nthree");
    } finally {
        await db.close();
    }
});

test("COPY treats an explicit default channel as the same line-anchor identity", async () => {
    const { db, seed, read, dispatch } = await setup();
    try {
        const source = "alpha\nbeta\ngamma";
        await seed("/source", {
            channels: { body: { content: source, mimetype: "text/markdown" } },
        });
        await seed("/destination", {
            channels: { body: { content: "one\ntwo\nthree", mimetype: "text/markdown" } },
        });

        const observed = await dispatch(readStmt(urlPath("multi", "/source", "body"), { marks: [2] }));
        assert.equal(observed.status, 200);
        const anchor = (observed as { readonly lineAnchors?: readonly string[] }).lineAnchors?.[0];
        assert.match(anchor ?? "", /^@[0-9A-Za-z]{5}$/);

        const result = await dispatch(copyStmt(
            urlPath("multi", "/source", "body"),
            urlPath("multi", "/destination"),
            null,
            { marks: [anchor!] },
            { marks: [2] },
        ));
        assert.equal(result.status, 200);
        assert.equal((await read("/destination")).entry?.channels.body?.content, "one\nbeta\nthree");
    } finally {
        await db.close();
    }
});

test("COPY rejects a stale source anchor without changing either resource", async () => {
    const { db, seed, read, dispatch } = await setup();
    try {
        const original = "alpha\nbeta\ngamma";
        const stale = LineAnchors.token("multi:///source", 2, original);
        await seed("/source", {
            channels: { body: { content: "alpha\nBETA\ngamma", mimetype: "text/markdown" } },
        });
        await seed("/destination", {
            channels: { body: { content: "one\ntwo\nthree", mimetype: "text/markdown" } },
        });

        const result = await dispatch(copyStmt(
            urlPath("multi", "/source"),
            urlPath("multi", "/destination"),
            null,
            { marks: [stale] },
            { marks: [2] },
        ));
        assert.equal(result.status, 409);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/line-anchor-collision");
        assert.equal(result.problem?.retryable, false, "stale coordinates require a different request");
        assert.equal((await read("/source")).entry?.channels.body?.content, "alpha\nBETA\ngamma");
        assert.equal((await read("/destination")).entry?.channels.body?.content, "one\ntwo\nthree");
    } finally {
        await db.close();
    }
});

test("COPY propagates tolerated source and destination scope normalizations in authored order", async () => {
    const { db, seed, read, dispatch } = await setup();
    try {
        await seed("/source", {
            channels: { body: { content: "abc\n", mimetype: "text/markdown" } },
        });
        await seed("/destination", {
            channels: { body: { content: "XY\n", mimetype: "text/markdown" } },
        });

        const result = await dispatch(copyStmt(
            urlPath("multi", "/source"),
            urlPath("multi", "/destination"),
            null,
            { marks: [1, 2, 1] },
            { marks: [1, 2, 1] },
        ));

        assert.equal(result.status, 200);
        assert.deepEqual(result.scopeNormalizations, [
            { requested: [1, 2, 1], canonical: [1, 2, 1, 4] },
            { requested: [1, 2, 1], canonical: [1, 2, 1, 3] },
        ]);
        assert.equal((await read("/source")).entry?.channels.body?.content, "abc\n");
        assert.equal((await read("/destination")).entry?.channels.body?.content, "Xbc\n");
    } finally {
        await db.close();
    }
});

test("MOVE composes exact source and destination regions across resources", async () => {
    const { db, seed, read, dispatch } = await setup();
    try {
        await seed("/source", {
            channels: {
                body: { content: "abc", mimetype: "text/markdown" },
            },
        });
        await seed("/destination", {
            channels: {
                body: { content: "XY", mimetype: "text/markdown" },
            },
        });

        const result = await dispatch(moveStmt(
            urlPath("multi", "/source"),
            urlPath("multi", "/destination"),
            null,
            { marks: [1, 2, 1, 3] },
            { marks: [1, 2, 1, 2] },
        ));
        assert.equal(result.status, 200);
        const effects = effectsOf(result);
        assert.deepEqual(
            effects.map(({ target, action }) => ({ target, action })),
            [
                { target: "multi:///destination", action: "update" },
                { target: "multi:///source", action: "update" },
            ],
        );
        assert.deepEqual(
            effects.map(({ receipt }) => receipt?.effect.requested),
            ["<1,2,1,2>", "<1,2,1,3>"],
        );
        assert.equal((await read("/source")).entry?.channels.body?.content, "ac");
        assert.equal((await read("/destination")).entry?.channels.body?.content, "XbY");
    } finally {
        await db.close();
    }
});

test("MOVE resolves line anchors at both resources and removes the selected current source", async () => {
    const { db, seed, read, dispatch } = await setup();
    try {
        const source = "alpha\nbeta\ngamma";
        const destination = "one\ntwo\nthree";
        await seed("/source", {
            channels: { body: { content: source, mimetype: "text/markdown" } },
        });
        await seed("/destination", {
            channels: { body: { content: destination, mimetype: "text/markdown" } },
        });

        const result = await dispatch(moveStmt(
            urlPath("multi", "/source"),
            urlPath("multi", "/destination"),
            null,
            { marks: [LineAnchors.token("multi:///source", 2, source)] },
            { marks: [LineAnchors.token("multi:///destination", 2, destination)] },
        ));
        assert.equal(result.status, 200);
        assert.equal((await read("/source")).entry?.channels.body?.content, "alpha\ngamma");
        assert.equal((await read("/destination")).entry?.channels.body?.content, "one\nbeta\nthree");
    } finally {
        await db.close();
    }
});

test("MOVE propagates tolerated source and destination scope normalizations", async () => {
    const { db, seed, read, dispatch } = await setup();
    try {
        await seed("/source", {
            channels: { body: { content: "abc\n", mimetype: "text/markdown" } },
        });
        await seed("/destination", {
            channels: { body: { content: "XY\n", mimetype: "text/markdown" } },
        });

        const result = await dispatch(moveStmt(
            urlPath("multi", "/source"),
            urlPath("multi", "/destination"),
            null,
            { marks: [1, 2, 1] },
            { marks: [1, 2, 1] },
        ));

        assert.equal(result.status, 200);
        assert.deepEqual(result.scopeNormalizations, [
            { requested: [1, 2, 1], canonical: [1, 2, 1, 4] },
            { requested: [1, 2, 1], canonical: [1, 2, 1, 3] },
        ]);
        assert.equal((await read("/source")).entry?.channels.body?.content, "a\n");
        assert.equal((await read("/destination")).entry?.channels.body?.content, "Xbc\n");
    } finally {
        await db.close();
    }
});

test("same-channel MOVE applies destination insertion and source deletion to one snapshot", async () => {
    const { db, seed, read, dispatch } = await setup();
    try {
        await seed("/document", {
            channels: {
                body: { content: "abcdef", mimetype: "text/markdown" },
            },
        });

        const result = await dispatch(moveStmt(
            urlPath("multi", "/document"),
            urlPath("multi", "/document"),
            null,
            { marks: [1, 2, 1, 4] },
            { marks: [1, 7, 1, 7] },
        ));
        assert.equal(result.status, 200);
        const effects = effectsOf(result);
        assert.deepEqual(
            effects.map(({ target, action }) => ({ target, action })),
            [
                { target: "multi:///document", action: "update" },
                { target: "multi:///document", action: "update" },
            ],
        );
        assert.deepEqual(
            effects.map(({ receipt }) => receipt?.effect.requested),
            ["<1,7,1,7>", "<1,2,1,4>"],
        );
        assert.equal((await read("/document")).entry?.channels.body?.content, "adefbc");
    } finally {
        await db.close();
    }
});

test("same-channel MOVE composes source and destination anchors against one snapshot", async () => {
    const { db, seed, read, dispatch } = await setup();
    try {
        const content = "abcdef";
        const anchor = LineAnchors.token("multi:///document", 1, content);
        await seed("/document", {
            channels: {
                body: { content, mimetype: "text/markdown" },
            },
        });

        const result = await dispatch(moveStmt(
            urlPath("multi", "/document"),
            urlPath("multi", "/document"),
            null,
            { marks: [anchor, 2, anchor, 4] },
            { marks: [anchor, 7, anchor, 7] },
        ));
        assert.equal(result.status, 200);
        assert.equal((await read("/document")).entry?.channels.body?.content, "adefbc");
    } finally {
        await db.close();
    }
});

test("same-channel MOVE rejects overlapping source and destination regions without mutation", async () => {
    const { db, seed, read, dispatch } = await setup();
    try {
        await seed("/document", {
            channels: {
                body: { content: "abcdef", mimetype: "text/markdown" },
            },
        });

        const result = await dispatch(moveStmt(
            urlPath("multi", "/document"),
            urlPath("multi", "/document"),
            null,
            { marks: [1, 2, 1, 5] },
            { marks: [1, 3, 1, 3] },
        ));
        assert.equal(result.status, 409);
        assert.equal((await read("/document")).entry?.channels.body?.content, "abcdef");
    } finally {
        await db.close();
    }
});

test("whole-channel MOVE removes only the selected source channel", async () => {
    const { db, seed, read, dispatch } = await setup();
    try {
        await seed("/source", {
            channels: {
                body: { content: "preserved", mimetype: "text/markdown" },
                notes: { content: "moved", mimetype: "text/markdown" },
            },
        });

        const result = await dispatch(moveStmt(
            urlPath("multi", "/source", "notes"),
            urlPath("multi", "/destination", "aux"),
        ));
        assert.equal(result.status, 201);
        assert.deepEqual(effectsOf(result), [
            { target: "multi:///destination#aux", action: "create" },
            { target: "multi:///source#notes", action: "delete" },
        ]);
        const source = await read("/source");
        assert.equal(source.entry?.channels.body?.content, "preserved");
        assert.equal(source.entry?.channels.notes, undefined);
        assert.equal((await read("/destination")).entry?.channels.aux?.content, "moved");
    } finally {
        await db.close();
    }
});

test("{§move-canonical-whole-source}: <1,-1> removes only the selected source channel", async () => {
    const { db, seed, read, dispatch } = await setup();
    try {
        await seed("/source", {
            channels: {
                body: { content: "preserved", mimetype: "text/markdown" },
                notes: { content: "moved", mimetype: "text/markdown" },
            },
        });

        const result = await dispatch(moveStmt(
            urlPath("multi", "/source", "notes"),
            urlPath("multi", "/destination", "aux"),
            null,
            { marks: [1, -1] },
        ));
        assert.equal(result.status, 201);
        assert.deepEqual(effectsOf(result), [
            { target: "multi:///destination#aux", action: "create" },
            { target: "multi:///source#notes", action: "delete" },
        ]);
        const source = await read("/source");
        assert.equal(source.entry?.channels.body?.content, "preserved");
        assert.equal(source.entry?.channels.notes, undefined);
        assert.equal((await read("/destination")).entry?.channels.aux?.content, "moved");
    } finally {
        await db.close();
    }
});

test("whole-channel MOVE removes the source entry when its final channel leaves", async () => {
    const { db, seed, read, dispatch } = await setup();
    try {
        await seed("/source", {
            channels: {
                notes: { content: "only", mimetype: "text/markdown" },
            },
        });

        const result = await dispatch(moveStmt(
            urlPath("multi", "/source", "notes"),
            urlPath("multi", "/destination", "aux"),
        ));
        assert.equal(result.status, 201);
        assert.deepEqual(effectsOf(result), [
            { target: "multi:///destination#aux", action: "create" },
            { target: "multi:///source#notes", action: "delete" },
        ]);
        assert.equal((await read("/source")).status, 404);
    } finally {
        await db.close();
    }
});

test("a destination region requires existing content and leaves the source untouched", async () => {
    const { db, seed, read, dispatch } = await setup();
    try {
        await seed("/source", {
            channels: {
                body: { content: "source", mimetype: "text/markdown" },
            },
        });

        const result = await dispatch(moveStmt(
            urlPath("multi", "/source"),
            urlPath("multi", "/missing"),
            null,
            null,
            { marks: [1, 1, 1, 1] },
        ));
        assert.equal(result.status, 404);
        assert.equal((await read("/source")).entry?.channels.body?.content, "source");
    } finally {
        await db.close();
    }
});

test("a divergent whole-channel destination conflicts and leaves the MOVE source untouched", async () => {
    const { db, seed, read, dispatch } = await setup();
    try {
        await seed("/source", {
            channels: {
                body: { content: "source", mimetype: "text/markdown" },
            },
        });
        await seed("/destination", {
            channels: {
                body: { content: "different", mimetype: "text/markdown" },
            },
        });

        const result = await dispatch(moveStmt(
            urlPath("multi", "/source"),
            urlPath("multi", "/destination"),
        ));
        assert.equal(result.status, 409);
        assert.equal((await read("/source")).entry?.channels.body?.content, "source");
        assert.equal((await read("/destination")).entry?.channels.body?.content, "different");
    } finally {
        await db.close();
    }
});

test("COPY and MOVE reject a binary marker without fabricating a byte-transfer channel (#140)", async () => {
    const { db, seed, read, dispatch } = await setup();
    try {
        await seed("/source", {
            channels: {
                blob: { content: "", mimetype: "application/octet-stream" },
            },
        });

        const copied = await dispatch(copyStmt(
            urlPath("multi", "/source", "blob"),
            urlPath("multi", "/destination", "blob"),
        ));
        assert.equal(copied.status, 415);
        assert.equal(
            copied.problem?.type,
            "https://problems.plurnk.xyz/engine/dispatcher/binary-source-unsupported",
        );
        assert.equal((await read("/destination")).status, 404);

        const sliced = await dispatch(copyStmt(
            urlPath("multi", "/source", "blob"),
            urlPath("multi", "/other", "blob"),
            null,
            { marks: [1] },
        ));
        assert.equal(sliced.status, 415);

        const moved = await dispatch(moveStmt(
            urlPath("multi", "/source", "blob"),
            urlPath("multi", "/destination", "blob"),
        ));
        assert.equal(moved.status, 415);
        assert.equal(
            moved.problem?.type,
            "https://problems.plurnk.xyz/engine/dispatcher/binary-source-unsupported",
        );
        assert.equal((await read("/destination")).status, 404);
        assert.equal((await read("/source")).entry?.channels.blob?.mimetype, "application/octet-stream");
    } finally {
        await db.close();
    }
});
