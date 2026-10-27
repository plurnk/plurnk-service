import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import EntryScheme from "./_entry-scheme.ts";
import Workspace from "../../src/schemes/Workspace.ts";
import EntryCrud, { type EntryData } from "../../src/schemes/_entry-crud.ts";
import LineAnchors from "../../src/content/line-anchors.ts";
import { type CopyStatement, type MoveStatement } from "@plurnk/plurnk-contracts";
import { openMigrated, seedEnvelope, seedEntryWithChannel } from "./_db.ts";
import { makeSchemeCtx, DEFAULT_MIMETYPES } from "./_scheme.ts";
import { urlPath, localPath, editStmt, copyStmt, moveStmt, fullReplace, readStmt } from "./_dsl.ts";
import { BaseHandler, Mimetypes } from "@plurnk/plurnk-mimetypes";
import { type ResolvedEditStatement, type SchemeCtx, type SchemeHandler, type SchemeManifest } from "@plurnk/plurnk-schemes";


describe("Engine.copy-move", () => {
// Tests for SPEC {§copy} (Engine.copy orchestration) and {§move} (Engine.move).











const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`, { producer: "client" });
    const schemes = new SchemeRegistry();
    schemes.register("fixture", new EntryScheme());
    const engine = new Engine({ db, schemes });
    return { db, ...env, engine };
};

const dispatch = async (engine: Engine, env: { workspaceId: number; sessionId: number; loopId: number; turnId: number }, statement: CopyStatement | MoveStatement) => {
    return await engine.dispatch({
        statement, ...env, sequence: 1, origin: "client",
    });
};

test("{§copy} Engine.copy copies the default channel", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        await new Workspace().edit(editStmt(urlPath("workspace", "/france/capital"), "Paris"), makeSchemeCtx({ db, workspaceId, sessionId }));

        const r = await dispatch(engine, { workspaceId, sessionId, loopId, turnId }, copyStmt(urlPath("workspace", "/france/capital"), urlPath("workspace", "/europe/france")));
        assert.equal(r.status, 201);

        const dst = await db.test_get_entry_by_pathname_scheme.get<{ scheme: string; pathname: string }>({ pathname: "/europe/france", scheme: "workspace" });
        assert.equal(dst?.scheme, "workspace");
        const channel = await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/europe/france", name: "body" });
        assert.equal(channel?.content, "Paris");
    } finally { await db.close(); }
});

test("{§copy} Engine.copy cross-scheme (session commons → fixture)", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        await new Workspace().edit(editStmt(urlPath("workspace", "/topic"), "open question"), makeSchemeCtx({ db, workspaceId, sessionId }));

        const r = await dispatch(engine, { workspaceId, sessionId, loopId, turnId }, copyStmt(urlPath("workspace", "/topic"), urlPath("fixture", "/topic")));
        assert.equal(r.status, 201);

        const dst = await db.test_get_entry_by_pathname_scheme.get<{ scheme: string }>({ pathname: "/topic", scheme: "fixture" });
        assert.equal(dst?.scheme, "fixture");
        const channel = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/topic", scheme: "fixture", name: "body" });
        assert.equal(channel?.content, "open question");
    } finally { await db.close(); }
});

test("{§copy} Engine.copy missing source returns 404", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        const r = await dispatch(engine, { workspaceId, sessionId, loopId, turnId }, copyStmt(urlPath("workspace", "/nope"), urlPath("workspace", "/elsewhere")));
        assert.equal(r.status, 404);
        assert.equal(r.problem?.type, "https://problems.plurnk.xyz/scheme/workspace/entry-not-found");
        assert.equal(r.problem?.target, "workspace:///nope");
    } finally { await db.close(); }
});

test("{§copy} Engine.copy conflicting destination returns 409", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        const k = new Workspace();
        await k.edit(editStmt(urlPath("workspace", "/src"), "source body"), makeSchemeCtx({ db, workspaceId, sessionId }));
        await k.edit(editStmt(urlPath("workspace", "/dst"), "dest body"), makeSchemeCtx({ db, workspaceId, sessionId }));

        const r = await dispatch(engine, { workspaceId, sessionId, loopId, turnId }, copyStmt(urlPath("workspace", "/src"), urlPath("workspace", "/dst")));
        assert.equal(r.status, 409);
        const dstBody = (await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/dst", name: "body" }))?.content;
        assert.equal(dstBody, "dest body");
    } finally { await db.close(); }
});

test("{§copy} Engine.copy to a destination already holding identical content returns 304", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        const k = new Workspace();
        await k.edit(editStmt(urlPath("workspace", "/src"), "same body"), makeSchemeCtx({ db, workspaceId, sessionId }));
        // Three dispatches in one turn → distinct sequences (log_entries is unique on turn_id+sequence).
        const copy = (sequence: number) => engine.dispatch({ statement: copyStmt(urlPath("workspace", "/src"), urlPath("workspace", "/dst")), workspaceId, sessionId, loopId, turnId, sequence, origin: "client" });

        const created = await copy(1);
        assert.equal(created.status, 201, "first copy creates the destination");
        assert.deepEqual(created.effects, [{
            target: "workspace:///dst",
            action: "create",
        }]);
        const unchanged = await copy(2);
        assert.equal(unchanged.status, 304, "identical re-copy is a no-op, not a 409");
        assert.equal(unchanged.effects, undefined, "a no-op reports no effects");

        // Divergent destination is still a real collision; it stays untouched.
        await k.edit(editStmt(urlPath("workspace", "/src"), "changed body", fullReplace), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal((await copy(3)).status, 409, "divergent content is a collision");
        const dstBody = (await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/dst", name: "body" }))?.content;
        assert.equal(dstBody, "same body", "collision leaves the destination untouched");
    } finally { await db.close(); }
});
test("{§copy} Engine.move relocates: source deleted, dest created", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        await new Workspace().edit(editStmt(urlPath("workspace", "/src"), "movable"), makeSchemeCtx({ db, workspaceId, sessionId }));

        const r = await dispatch(engine, { workspaceId, sessionId, loopId, turnId }, moveStmt(urlPath("workspace", "/src"), urlPath("workspace", "/dst")));
        assert.equal(r.status, 201);

        const src = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/src" });
        assert.equal(src, undefined, "source removed");

        const dstBody = (await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/dst", name: "body" }))?.content;
        assert.equal(dstBody, "movable");
    } finally { await db.close(); }
});

test("{§move}: Engine.move treats <1,-1> as whole-channel source selection", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        await new Workspace().edit(editStmt(urlPath("workspace", "/src"), "movable"), makeSchemeCtx({ db, workspaceId, sessionId }));

        const result = await dispatch(
            engine,
            { workspaceId, sessionId, loopId, turnId },
            moveStmt(urlPath("workspace", "/src"), urlPath("workspace", "/dst"), fullReplace),
        );
        assert.equal(result.status, 201);
        assert.deepEqual(result.effects, [
            { target: "workspace:///dst", action: "create" },
            { target: "workspace:///src", action: "delete" },
        ]);
        assert.equal(
            await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/src" }),
            undefined,
            "the canonical whole-content marker removes the final source channel instead of hollowing it out",
        );
        const rows = await db.test_log_entries_by_loop.all<{ op: string; lineMarker: string | null }>({ loop_id: loopId });
        assert.equal(
            rows.find(({ op }) => op === "MOVE")?.lineMarker,
            JSON.stringify(fullReplace),
            "canonical cleanup does not erase the scope the model authored",
        );
    } finally { await db.close(); }
});

test("{§copy} Engine.move keeps an ordinary source region regional when it covers the current content", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        await new Workspace().edit(editStmt(urlPath("workspace", "/src"), "only line"), makeSchemeCtx({ db, workspaceId, sessionId }));

        const result = await dispatch(
            engine,
            { workspaceId, sessionId, loopId, turnId },
            moveStmt(urlPath("workspace", "/src"), urlPath("workspace", "/dst"), { marks: [1] }),
        );
        assert.equal(result.status, 201);
        assert.deepEqual(
            (result.effects as Array<{ action: string }>).map(({ action }) => action),
            ["create", "update"],
        );
        const source = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/src" });
        assert.notEqual(source, undefined, "ordinary regional syntax retains the source resource");
        const channel = await db.test_get_channel.get<{ content: string }>({ entry_id: source?.id, name: "body" });
        assert.equal(channel?.content, "");
    } finally { await db.close(); }
});

test("{§move} Engine.move to /dev/null is not a delete — source survives", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        await new Workspace().edit(editStmt(urlPath("workspace", "/obsolete"), "stale"), makeSchemeCtx({ db, workspaceId, sessionId }));

        // /dev/null carries no special meaning now (KILL is the delete). It's a
        // plain relocation to an unwritable dest — it fails, and the source stays.
        const r = await dispatch(engine, { workspaceId, sessionId, loopId, turnId }, moveStmt(urlPath("workspace", "/obsolete"), localPath("/dev/null")));
        assert.notEqual(r.status, 200, "not a successful delete");

        const remaining = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/obsolete" });
        assert.notEqual(remaining, undefined, "source survives — /dev/null is not a delete");
    } finally { await db.close(); }
});

test("{§move} Engine.move missing source returns 404", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        const r = await dispatch(engine, { workspaceId, sessionId, loopId, turnId }, moveStmt(urlPath("workspace", "/nope"), urlPath("workspace", "/elsewhere")));
        assert.equal(r.status, 404);
    } finally { await db.close(); }
});

test("{§copy} Engine.move cross-scheme (session commons → fixture) deletes source, creates dest", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        await new Workspace().edit(editStmt(urlPath("workspace", "/draft"), "answer"), makeSchemeCtx({ db, workspaceId, sessionId }));

        const r = await dispatch(engine, { workspaceId, sessionId, loopId, turnId }, moveStmt(urlPath("workspace", "/draft"), urlPath("fixture", "/answer")));
        assert.equal(r.status, 201);

        const srcRemaining = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ pathname: "/draft", scheme: "workspace" });
        assert.equal(srcRemaining, undefined, "the commons source is deleted");

        const dst = await db.test_get_entry_by_pathname_scheme.get<{ scheme: string }>({ pathname: "/answer", scheme: "fixture" });
        assert.equal(dst?.scheme, "fixture");
    } finally { await db.close(); }
});

test("{§op-invariants} Engine.copy with <L> slices the source range into the dest, no N:\\t prefix", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        await new Workspace().edit(editStmt(urlPath("workspace", "/long"), "alpha\nbeta\ngamma\ndelta"), makeSchemeCtx({ db, workspaceId, sessionId }));
        const base = copyStmt(urlPath("workspace", "/long"), urlPath("workspace", "/sliced"));
        const stmt: CopyStatement = { ...base, source: { ...base.source, lineMarker: { marks: [2, 3] } } };
        const r = await dispatch(engine, { workspaceId, sessionId, loopId, turnId }, stmt);
        assert.equal(r.status, 201);
        assert.ok(Array.isArray(r.effects));
        const [effect] = r.effects as Array<{
            action: string;
            receipt?: {
                before: number;
                after: number;
                effect: { requested: string; context: string };
            };
        }>;
        assert.equal(effect?.action, "create");
        assert.equal(effect?.receipt?.before, 0);
        assert.equal(effect?.receipt?.after, 2);
        assert.equal(effect?.receipt?.effect.requested, "<1,-1>");
        assert.match(effect?.receipt?.effect.context ?? "", /1(?:<@[0-9A-Za-z]{5}>|:)beta\n2(?:<@[0-9A-Za-z]{5}>|:)gamma/);
        const entryRow = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/sliced" });
        const dstChannel = await db.test_get_channel.get<{ content: string }>({ entry_id: entryRow?.id, name: "body" });
        assert.equal(dstChannel?.content, "beta\ngamma\n");
        // Symmetric with READ <L> but WITHOUT the N: prefix (Slicer.linesRaw) — the dest is content, not a view.
        assert.doesNotMatch(dstChannel?.content ?? "", /^\d+:/, "COPY <L> writes raw lines, never the READ line-number prefix");
    } finally { await db.close(); }
});

test("{§copy} Engine.copy with <L> out of range returns 416", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        await new Workspace().edit(editStmt(urlPath("workspace", "/src"), "only one line"), makeSchemeCtx({ db, workspaceId, sessionId }));
        const base = copyStmt(urlPath("workspace", "/src"), urlPath("workspace", "/dst"));
        const stmt: CopyStatement = { ...base, source: { ...base.source, lineMarker: { marks: [99] } } };
        const r = await dispatch(engine, { workspaceId, sessionId, loopId, turnId }, stmt);
        assert.equal(r.status, 416);
    } finally { await db.close(); }
});

test("{§copy} Engine.move with a source region removes only that region", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        await new Workspace().edit(editStmt(urlPath("workspace", "/orig"), "first\nsecond\nthird"), makeSchemeCtx({ db, workspaceId, sessionId }));
        const base = moveStmt(urlPath("workspace", "/orig"), urlPath("workspace", "/moved"));
        const stmt: MoveStatement = { ...base, source: { ...base.source, lineMarker: { marks: [1, 2] } } };
        const r = await dispatch(engine, { workspaceId, sessionId, loopId, turnId }, stmt);
        assert.equal(r.status, 201);
        assert.ok(Array.isArray(r.effects));
        const effects = r.effects as Array<{
            action: string;
            receipt?: { effect: { requested: string; context: string } };
        }>;
        assert.deepEqual(effects.map(({ action }) => action), ["create", "update"]);
        assert.equal(effects[0]?.receipt?.effect.requested, "<1,-1>");
        assert.match(effects[0]?.receipt?.effect.context ?? "", /1(?:<@[0-9A-Za-z]{5}>|:)first\n2(?:<@[0-9A-Za-z]{5}>|:)second/);
        assert.equal(effects[1]?.receipt?.effect.requested, "<1,2>");
        const srcRemaining = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/orig" });
        assert.notEqual(srcRemaining, undefined, "the source entry remains");
        const srcChannel = await db.test_get_channel.get<{ content: string }>({ entry_id: srcRemaining?.id, name: "body" });
        assert.equal(srcChannel?.content, "third");
        const entryRow = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/moved" });
        const dstChannel = await db.test_get_channel.get<{ content: string }>({ entry_id: entryRow?.id, name: "body" });
        assert.equal(dstChannel?.content, "first\nsecond\n");
    } finally { await db.close(); }
});
});

describe("Engine.copy-mimetype", () => {
const content = '## Finding\n- `a<b` & "quoted"\n\tcafé → 東京\n';

const setup = async (mimetypes = DEFAULT_MIMETYPES) => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `copy-mimetype-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes });
    const seed = (pathname: string, mimetype: string, body = content) => seedEntryWithChannel(db, {
        workspaceId: env.workspaceId, pathname, mimetype, content: body,
    });
    const read = async (pathname: string) => {
        const row = await db.test_get_channel_by_pathname.get<{ content: string; mimetype: string }>({ pathname, name: "body" });
        return row === undefined ? undefined : { content: row.content, mimetype: row.mimetype };
    };
    let sequence = 0;
    const dispatch = (statement: Parameters<Engine["dispatch"]>[0]["statement"]) =>
        engine.dispatch({ ...env, statement, sequence: ++sequence, origin: "model" });
    return { db, seed, read, dispatch };
};

for (const transfer of [copyStmt, moveStmt]) {
    const op = transfer(urlPath("workspace", "/src"), urlPath("workspace", "/dst")).op;
    for (const binary of [false, true]) {
        test(`{§network-address}: ${op} honors a handler's ${binary ? "binary" : "textual"} classification over the MIME prefix`, async () => {
            const mimetype = binary ? "text/x-encoded" : "application/x-treeish";
            const body = binary ? "AP+A" : content;
            const mimetypes = new Mimetypes({
                discovery: {
                    registry: { byExtension: new Map([[".md", "text/markdown"]]), byFilename: new Map() },
                    handlers: new Map([[mimetype, {
                        mimetype, binary, glyph: "", extensions: [],
                        packageName: "stub://transfer-classification",
                        projectionRevision: "test-1", source: "package",
                    }]]),
                    packageAttributions: new Map(), skipped: [],
                },
                loader: async () => ({ default: BaseHandler }),
            });
            const { db, seed, read, dispatch } = await setup(mimetypes);
            try {
                await seed("/src", mimetype, body);
                const result = await dispatch(transfer(urlPath("workspace", "/src"), urlPath("workspace", "/dst.md")));
                assert.equal(result.status, binary ? 415 : 201);
                if (binary) assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/mimetype-mismatch");
                assert.deepEqual(await read("/dst.md"), binary ? undefined : { content: body, mimetype: "text/markdown" });
                assert.deepEqual(await read("/src"), binary || op === "COPY" ? { content: body, mimetype } : undefined);
            } finally {
                await db.close();
                await mimetypes.dispose();
            }
        });
    }

    for (const pathname of ["/notes.txt", "/notes.md", "/notes"]) {
        test(`{§network-address}: ${op} plain text to new ${pathname} preserves content and resolves the destination type`, async () => {
            const { db, seed, read, dispatch } = await setup();
            try {
                const body = content.replaceAll("\n", "\r\n");
                await seed("/src", "text/plain", body);
                const result = await dispatch(transfer(urlPath("workspace", "/src"), urlPath("workspace", pathname)));
                assert.equal(result.status, 201);
                assert.deepEqual(await read(pathname), { content: body, mimetype: "text/markdown" });
                assert.deepEqual(await read("/src"), op === "COPY" ? { content: body, mimetype: "text/plain" } : undefined);
            } finally { await db.close(); }
        });
    }

    for (const pathname of ["/destination", "/destination.bin", "/destination.unknownext"]) {
        for (const [mimetype, body] of [
            ["application/json", '{"value":"kept"}'],
            ["application/octet-stream", "AP+A"],
            ["application/octet-stream", ""],
            ["image/png", "AP+A"],
        ] as const) {
            test(`{§copy}: ${op} carries ${mimetype} (${body.length} stored characters) into new ${pathname}`, async () => {
                const { db, seed, read, dispatch } = await setup();
                try {
                    await seed("/src", mimetype, body);
                    const result = await dispatch(transfer(urlPath("workspace", "/src"), urlPath("workspace", pathname)));
                    assert.equal(result.status, 201, JSON.stringify(result));
                    assert.deepEqual(await read(pathname), { content: body, mimetype });
                    assert.deepEqual(await read("/src"), op === "COPY" ? { content: body, mimetype } : undefined);
                } finally { await db.close(); }
            });
        }
    }

    for (const [pathname, destinationMimetype] of [["/destination.md", "text/markdown"], ["/destination.png", "image/png"]] as const) {
        test(`{§copy}: ${op} does not override the recognized type of absent ${pathname}`, async () => {
            const { db, seed, read, dispatch } = await setup();
            try {
                await seed("/src", "application/octet-stream", "AP+A");
                const result = await dispatch(transfer(urlPath("workspace", "/src"), urlPath("workspace", pathname)));
                assert.equal(result.status, 415);
                assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/mimetype-mismatch");
                assert.equal(result.problem?.destinationMimetype, destinationMimetype);
                assert.equal(await read(pathname), undefined);
                assert.deepEqual(await read("/src"), { content: "AP+A", mimetype: "application/octet-stream" });
            } finally { await db.close(); }
        });
    }

    for (const [sourceMimetype, destinationMimetype] of [
        ["text/plain", "text/markdown"],
        ["text/markdown", "text/plain"],
        ["text/plain", "text/plain"],
        ["text/vnd.plurnk", "text/plain"],
        ["application/json", "text/markdown"],
    ] as const) {
        test(`{§network-address}: scoped ${op} ${sourceMimetype} → ${destinationMimetype} preserves both declared types`, async () => {
            const { db, seed, read, dispatch } = await setup();
            try {
                await seed("/src", sourceMimetype);
                await seed("/dst.txt", destinationMimetype, "before\nreplace\nafter\n");
                const result = await dispatch(transfer(
                    urlPath("workspace", "/src"), urlPath("workspace", "/dst.txt"),
                    { marks: [2, 2] }, { marks: [2, 2] },
                ));
                assert.equal(result.status, 200);
                assert.deepEqual(await read("/dst.txt"), {
                    content: 'before\n- `a<b` & "quoted"\nafter\n', mimetype: destinationMimetype,
                });
                assert.deepEqual(await read("/src"), {
                    content: op === "COPY" ? content : "## Finding\n\tcafé → 東京\n", mimetype: sourceMimetype,
                });
            } finally { await db.close(); }
        });
    }

    for (const [mimetype, body] of [
        ["application/json", "{\"k\":1}"],
        ["text/html", "<p>value</p>"],
        ["text/csv", "k,v\n1,2\n"],
    ] as const) {
        test(`{§network-address}: ${op} from ${mimetype} to Markdown preserves the original text without conversion`, async () => {
            const { db, seed, read, dispatch } = await setup();
            try {
                await seed("/src", mimetype, body);
                const result = await dispatch(transfer(urlPath("workspace", "/src"), urlPath("workspace", "/dst.md")));
                assert.equal(result.status, 201);
                assert.deepEqual(await read("/dst.md"), { content: body, mimetype: "text/markdown" });
                assert.deepEqual(await read("/src"), op === "COPY" ? { content: body, mimetype } : undefined);
            } finally { await db.close(); }
        });
    }

    for (const [sourceMimetype, destinationMimetype, body] of [
        ["text/markdown", "application/json", content],
        ["application/json", "text/csv", '{"k":1}'],
        ["application/octet-stream", "text/markdown", "AP+A"],
        ["text/plain", "image/png", content],
    ] as const) {
        test(`{§channels}: ${op} ${sourceMimetype} → ${destinationMimetype} rejects before changing either resource`, async () => {
            const { db, seed, read, dispatch } = await setup();
            try {
                await seed("/src", sourceMimetype, body);
                await seed("/dst", destinationMimetype, "unchanged destination");
                const result = await dispatch(transfer(urlPath("workspace", "/src"), urlPath("workspace", "/dst"), null, { marks: [1, -1] }));
                assert.equal(result.status, 415);
                assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/mimetype-mismatch");
                assert.equal(result.problem?.channel, "body");
                assert.equal(result.problem?.sourceMimetype, sourceMimetype);
                assert.equal(result.problem?.destinationMimetype, destinationMimetype);
                assert.deepEqual(await read("/src"), { content: body, mimetype: sourceMimetype });
                assert.deepEqual(await read("/dst"), { content: "unchanged destination", mimetype: destinationMimetype });
            } finally { await db.close(); }
        });
    }
}

for (const same of [true, false]) {
    test(`{§copy} {§copy}: compatible COPY with ${same ? "identical" : "different"} destination content keeps ordinary collision semantics`, async () => {
        const { db, seed, read, dispatch } = await setup();
        try {
            const destinationContent = same ? content : "other content";
            await seed("/src", "text/markdown");
            await seed("/dst", "text/plain", destinationContent);
            const result = await dispatch(copyStmt(urlPath("workspace", "/src"), urlPath("workspace", "/dst")));
            assert.equal(result.status, same ? 304 : 409);
            if (!same) assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/copy-destination-exists");
            assert.equal(result.effects, undefined);
            assert.deepEqual(await read("/src"), { content, mimetype: "text/markdown" });
            assert.deepEqual(await read("/dst"), { content: destinationContent, mimetype: "text/plain" });
        } finally { await db.close(); }
    });
}
});

describe("Engine.copy-move-regions", () => {
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
            plain: "text/plain",
        },
        defaultChannel: "body",
        category: "data",
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
        sessionId: env.sessionId,
    });

    const seed = (pathname: string, entry: EntryData) =>
        EntryCrud.writeEntry({ authority: "", pathname }, entry, ctx, "multi");
    const read = (pathname: string) =>
        EntryCrud.readEntry({ authority: "", pathname }, ctx, "multi");
    let sequence = 0;
    const dispatch = (statement: Parameters<Engine["dispatch"]>[0]["statement"]) =>
        engine.dispatch({
            statement,
            workspaceId: env.workspaceId,
            sessionId: env.sessionId,
            loopId: env.loopId,
            turnId: env.turnId,
            sequence: sequence += 1,
            origin: "client",
        });
    return { db, env, seed, read, dispatch };
};

for (const transfer of [copyStmt, moveStmt]) {
    const op = transfer(urlPath("multi", "/src"), urlPath("multi", "/dst", "plain")).op;
    test(`{§copy}: ${op} rejects a binary transfer into a declared text default channel`, async () => {
        const { db, seed, read, dispatch } = await setup();
        try {
            await seed("/src", { channels: { blob: { content: "AP+A", mimetype: "application/octet-stream" } } });
            const result = await dispatch(transfer(urlPath("multi", "/src", "blob"), urlPath("multi", "/dst")));
            assert.equal(result.status, 415);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/mimetype-mismatch");
            assert.equal(result.problem?.destinationMimetype, "text/markdown");
            assert.equal((await read("/dst")).status, 404);
            assert.equal((await read("/src")).entry?.channels.blob?.content, "AP+A");
        } finally { await db.close(); }
    });

    test(`{§network-address}: ${op} creates a declared plain channel from Markdown without relabeling or disturbing siblings`, async () => {
        const { db, seed, read, dispatch } = await setup();
        try {
            const content = "# Finding\n\tverbatim <text> → result\n";
            await seed("/src", { channels: { body: { content, mimetype: "text/markdown" } } });
            await seed("/dst", { channels: { body: { content: "other channel", mimetype: "text/markdown" } } });
            const result = await dispatch(transfer(urlPath("multi", "/src"), urlPath("multi", "/dst", "plain")));
            assert.equal(result.status, 200);
            const destination = await read("/dst");
            assert.equal(destination.entry?.channels.plain?.content, content);
            assert.equal(destination.entry?.channels.plain?.mimetype, "text/plain");
            assert.equal(destination.entry?.channels.body?.content, "other channel");
            assert.equal(destination.entry?.channels.body?.mimetype, "text/markdown");
            const source = await read("/src");
            assert.equal(source.status, op === "COPY" ? 200 : 404);
            if (op === "COPY") {
                assert.equal(source.entry?.channels.body?.content, content);
                assert.equal(source.entry?.channels.body?.mimetype, "text/markdown");
            }
        } finally { await db.close(); }
    });
}

test("{§copy} COPY transfers only the selected channel", async () => {
    const { db, seed, read, dispatch } = await setup();
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
    } finally {
        await db.close();
    }
});

test("{§fs-write-surface}: empty destination scopes create independently of source length", async () => {
    const { db, seed, read, dispatch } = await setup();
    try {
        await seed("/copy-source", {
            channels: {
                body: { content: "one\ntwo\nthree", mimetype: "text/markdown" },
            },
        });
        const copied = await dispatch(copyStmt(
            urlPath("multi", "/copy-source"),
            urlPath("multi", "/copied"),
            { marks: [2, 3] },
            { marks: [1, 2] },
        ));
        assert.equal(copied.status, 201);
        assert.equal((await read("/copied")).entry?.channels.body?.content, "two\nthree");

        const clamped = await dispatch(copyStmt(
            urlPath("multi", "/copy-source"),
            urlPath("multi", "/clamped"),
            { marks: [2, 3] },
            { marks: [1, 3] },
        ));
        assert.equal(clamped.status, 201);
        assert.equal((await read("/clamped")).entry?.channels.body?.content, "two\nthree");

        await seed("/single-source", {
            channels: {
                body: { content: "single", mimetype: "text/markdown" },
            },
        });
        const single = await dispatch(copyStmt(
            urlPath("multi", "/single-source"),
            urlPath("multi", "/single-copy"),
            null,
            { marks: [1] },
        ));
        assert.equal(single.status, 201);
        assert.equal((await read("/single-copy")).entry?.channels.body?.content, "single");

        await seed("/move-source", {
            channels: {
                body: { content: "alpha\nbeta", mimetype: "text/markdown" },
            },
        });
        const moved = await dispatch(moveStmt(
            urlPath("multi", "/move-source"),
            urlPath("multi", "/moved"),
            null,
            { marks: [1, -1] },
        ));
        assert.equal(moved.status, 201);
        assert.equal((await read("/moved")).entry?.channels.body?.content, "alpha\nbeta");
        assert.equal((await read("/move-source")).status, 404);
    } finally {
        await db.close();
    }
});

test("{§copy} COPY composes source selection and destination insertion with Unicode code-point coordinates", async () => {
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

test("{§copy} COPY resolves line anchors independently at its source and destination", async () => {
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

test("{§copy} COPY treats an explicit default channel as the same line-anchor identity", async () => {
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
            { marks: [anchor!] },
            { marks: [2] },
        ));
        assert.equal(result.status, 200);
        assert.equal((await read("/destination")).entry?.channels.body?.content, "one\nbeta\nthree");
    } finally {
        await db.close();
    }
});

test("{§copy} COPY rejects a stale source anchor without changing either resource", async () => {
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

test("{§copy} COPY propagates tolerated source and destination scope normalizations in authored order", async () => {
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

test("{§copy} MOVE composes exact source and destination regions across resources", async () => {
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

test("{§copy} MOVE resolves line anchors at both resources and removes the selected current source", async () => {
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

test("{§copy} MOVE propagates tolerated source and destination scope normalizations", async () => {
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

test("{§op-methods-op-dispatch} same-channel MOVE applies destination insertion and source deletion to one snapshot", async () => {
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

test("{§copy} same-channel MOVE composes source and destination anchors against one snapshot", async () => {
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
            { marks: [anchor, 2, anchor, 4] },
            { marks: [anchor, 7, anchor, 7] },
        ));
        assert.equal(result.status, 200);
        assert.equal((await read("/document")).entry?.channels.body?.content, "adefbc");
    } finally {
        await db.close();
    }
});

test("{§op-methods-op-dispatch} same-channel MOVE rejects overlapping source and destination regions without mutation", async () => {
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
            { marks: [1, 2, 1, 5] },
            { marks: [1, 3, 1, 3] },
        ));
        assert.equal(result.status, 409);
        assert.equal((await read("/document")).entry?.channels.body?.content, "abcdef");
    } finally {
        await db.close();
    }
});

test("{§copy} whole-channel MOVE removes only the selected source channel", async () => {
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

test("{§move}: <1,-1> removes only the selected source channel", async () => {
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

test("{§copy} whole-channel MOVE removes the source entry when its final channel leaves", async () => {
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

test("{§op-shapes}: an exact insertion into an absent destination creates it", async () => {
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
            { marks: [1, 1, 1, 1] },
        ));
        assert.equal(result.status, 201);
        assert.equal((await read("/missing")).entry?.channels.body?.content, "source");
        assert.equal((await read("/source")).status, 404);
    } finally {
        await db.close();
    }
});

test("{§op-shapes}: an exact region beyond the empty destination leaves the source untouched", async () => {
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
            { marks: [1, 2, 1, 2] },
        ));
        assert.equal(result.status, 416);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/schemes/slicer/range-not-satisfiable");
        assert.match(result.problem?.detail ?? "", /Column 2 is outside line 1/);
        assert.equal((await read("/source")).entry?.channels.body?.content, "source");
        assert.equal((await read("/missing")).status, 404);
    } finally {
        await db.close();
    }
});

test("{§copy} a divergent whole-channel destination conflicts and leaves the MOVE source untouched", async () => {
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

test("{§binary-parity} COPY and MOVE preserve zero-byte channels; a nonempty source scope remains invalid", async () => {
    const { db, seed, read, dispatch } = await setup();
    try {
        await seed("/source", { channels: { blob: { content: "", mimetype: "application/octet-stream" } } });
        const copied = await dispatch(copyStmt(urlPath("multi", "/source", "blob"), urlPath("multi", "/copied", "blob")));
        assert.equal(copied.status, 201, JSON.stringify(copied));
        assert.equal((await read("/copied")).entry?.channels.blob?.content, "");
        assert.equal((await read("/copied")).entry?.channels.blob?.mimetype, "application/octet-stream");
        const sliced = await dispatch(copyStmt(urlPath("multi", "/source", "blob"), urlPath("multi", "/other", "blob"), { marks: [1] }));
        assert.equal(sliced.status, 416);
        assert.equal(sliced.problem?.type, "https://problems.plurnk.xyz/schemes/slicer/range-not-satisfiable");
        assert.equal((await read("/other")).status, 404);
        const moved = await dispatch(moveStmt(urlPath("multi", "/source", "blob"), urlPath("multi", "/moved", "blob"), { marks: [1, -1] }));
        assert.equal(moved.status, 201, JSON.stringify(moved));
        assert.equal((await read("/moved")).entry?.channels.blob?.content, "");
        assert.equal((await read("/moved")).entry?.channels.blob?.mimetype, "application/octet-stream");
        assert.equal((await read("/source")).entry?.channels.blob, undefined);
    } finally { await db.close(); }
});

test("{§binary-parity} failed binary acquisition cannot masquerade as a transferable empty resource", async () => {
    const { db, seed, read, dispatch } = await setup();
    try {
        const problem = { type: "https://problems.plurnk.xyz/test/acquisition-failed", title: "Acquisition failed", status: 502, detail: "No complete source was received." };
        await seed("/source", { channels: { blob: {
            content: "", mimetype: "application/octet-stream", state: "errored", producerResult: { status: 502, problem },
        } } });
        for (const operation of [copyStmt, moveStmt]) {
            const result = await dispatch(operation(urlPath("multi", "/source", "blob"), urlPath("multi", "/destination", "blob")));
            assert.equal(result.status, 502);
            assert.equal(result.problem?.type, problem.type);
            assert.equal((await read("/destination")).status, 404);
            assert.equal((await read("/source")).entry?.channels.blob?.state, "errored");
        }
    } finally { await db.close(); }
});
});

