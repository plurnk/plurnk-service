import test, { describe, before as beforeAll, after as afterAll } from "node:test";
import assert from "node:assert/strict";
import Engine, { type ProposalPendingEvent } from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import EntryScheme from "./_entry-scheme.ts";
import Workspace from "../../src/schemes/Workspace.ts";
import EntryCrud, { type EntryData } from "../../src/schemes/_entry-crud.ts";
import LineAnchors from "../../src/content/line-anchors.ts";
import EntryFind from "../../src/schemes/_entry-find.ts";
import MembershipMaterialization from "../../src/core/MembershipMaterialization.ts";
import { type CopyStatement, type MoveStatement, type ReadStatement, type FindStatement, type MatcherBody, type ParsedPath, type KillStatement } from "@plurnk/plurnk-contracts";
import { openMigrated, seedEnvelope, seedEntryWithChannel, insertWorkspace, insertSession, insertLoop, insertTurn } from "./_db.ts";
import { makeSchemeCtx, DEFAULT_MIMETYPES, readThroughScheme } from "./_scheme.ts";
import { urlPath, localPath, editStmt, copyStmt, moveStmt, fullReplace, readStmt } from "./_dsl.ts";
import { BaseHandler, Mimetypes } from "@plurnk/plurnk-mimetypes";
import { type ResolvedEditStatement, type SchemeCtx, type SchemeHandler, type SchemeManifest } from "@plurnk/plurnk-schemes";
import { mkdtemp, rm, writeFile, readFile, access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { viableWindow } from "./_provider.ts";
import { rpcCall, connect, withDaemon, waitForDb } from "./_rpc.ts";
import { resourcePaths } from "./_find.ts";
import { ownSession } from "./_approval.ts";
import { type Db } from "../../src/core/Db.ts";
import { assertResourceEffects } from "../../src/content/index.ts";

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

test("{§copy-l-source-range} Engine.copy with <L> slices the source range into the dest, no N:\\t prefix", async () => {
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
        // Symmetric with READ <L> but WITHOUT the N: prefix (sliceLinesRaw) — the dest is content, not a view.
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
        test(`{§mimetype-verbatim-transfer}: ${op} honors a handler's ${binary ? "binary" : "textual"} classification over the MIME prefix`, async () => {
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
        test(`{§mimetype-verbatim-transfer}: ${op} plain text to new ${pathname} preserves content and resolves the destination type`, async () => {
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
        test(`{§mimetype-verbatim-transfer}: scoped ${op} ${sourceMimetype} → ${destinationMimetype} preserves both declared types`, async () => {
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
        test(`{§mimetype-verbatim-transfer}: ${op} from ${mimetype} to Markdown preserves the original text without conversion`, async () => {
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

    test(`{§mimetype-verbatim-transfer}: ${op} creates a declared plain channel from Markdown without relabeling or disturbing siblings`, async () => {
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

test("{§empty-mutation-scope}: an exact insertion into an absent destination creates it", async () => {
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

test("{§empty-mutation-scope}: an exact region beyond the empty destination leaves the source untouched", async () => {
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

describe("binary-parity", () => {
// {§binary-parity} — a binary is not a second-class resource. COPY/MOVE transfers its bytes exactly —
// whole, by byte range, or spliced into a destination range — between files and through a session:// DB
// entry (stored base64 in content), byte-for-byte; a MOVE deletes the source. The refusals are narrow: a
// textual anchor on a binary region, authoring bytes from a text EDIT body, a scheme that keeps no bytes.


















// The task tree is a plain directory: admit its files as members, as the harness does.
const savedBinParityEnv: Record<string, string | undefined> = {};
beforeAll(() => {
    for (const [k, v] of Object.entries({
        PLURNK_MEMBERS_task: "**",
        PLURNK_MEMBERS_ENABLED: "1",
        PLURNK_SERVICE_OPTIMISTIC_WAIT_MS: "0",
        PLURNK_SERVICE_PROPOSALS: "accept",
    })) {
        savedBinParityEnv[k] = process.env[k];
        process.env[k] = v;
    }
});
afterAll(() => {
    for (const [k, v] of Object.entries(savedBinParityEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

// A complete, valid 1×1 PNG (signature, IHDR, IDAT, IEND).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const mockTurn = (dsl: string) => ({
    assistant: { content: dsl, reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 } },
    assistantRaw: null,
});

const runCopy = async (seed: Record<string, Buffer>, dsl: string) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-binparity-"));
    for (const [name, bytes] of Object.entries(seed)) await writeFile(join(root, name), bytes);
    const mock = new Mock({ contextWindow: viableWindow(), responses: [mockTurn(`${dsl}

\`\`\`\`NOTE
working
\`\`\`\``), mockTurn("````SEND [200]\ndone\n````")] });
    let status = 0;
    let operations: Array<{ op: string; status_rx: number; rx: string | null }> = [];
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `binparity-${Date.now()}`, projectRoot: root });
            const run = await rpcCall(ws, 2, "loop.run", { prompt: "relocate the binary" });
            const loopId = (run.result as { loopId: number }).loopId;
            await waitForDb(
                () => db.engine_loop_status.get<{ status: number }>({ loop_id: loopId }),
                (r) => r?.status === 200,
                { timeoutMs: 20000 },
            );
            status = 200;
            operations = await db.test_log_entries_by_loop.all({ loop_id: loopId });
        } finally { ws.close(); }
    });
    return { root, status, operations };
};

const gone = async (path: string): Promise<boolean> => access(path).then(() => false, () => true);

test("{§binary-parity} COPY of a whole binary file reproduces its bytes exactly", async () => {
    const { root } = await runCopy({ "logo.png": PNG }, "````COPY (logo.png) (copy.png)````");
    try {
        assert.ok(Buffer.from(await readFile(join(root, "copy.png"))).equals(PNG), "the copy is byte-identical");
        assert.ok(Buffer.from(await readFile(join(root, "logo.png"))).equals(PNG), "the source is untouched by COPY");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§binary-parity} an empty binary file can be copied and moved as a whole resource", async () => {
    const { root } = await runCopy({ "empty.png": Buffer.alloc(0) }, "````COPY (empty.png) (copied.png)````\n````MOVE (empty.png) <1,-1> (moved.png)````");
    try {
        assert.equal((await readFile(join(root, "copied.png"))).byteLength, 0);
        assert.equal((await readFile(join(root, "moved.png"))).byteLength, 0);
        assert.equal(await gone(join(root, "empty.png")), true);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§fs-write-surface} the four empty-destination scopes create identical binary files", async () => {
    const scopes = ["0", "1", "-1", "1,-1"];
    const { root } = await runCopy(
        { "logo.png": PNG },
        scopes.map((scope, index) => `\`\`\`\`COPY (logo.png) (copy-${index}.png) <${scope}>\`\`\`\``).join("\n"),
    );
    try {
        for (const [index, scope] of scopes.entries()) {
            assert.deepEqual(await readFile(join(root, `copy-${index}.png`)), PNG, `<${scope}> preserves every source byte`);
        }
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§binary-parity} new binary destinations still reject character-column regions", async () => {
    const { root, operations } = await runCopy({ "logo.png": PNG }, "````MOVE (logo.png) (copy.png) <1,1,1,1>````");
    try {
        const move = operations.find(({ op }) => op === "MOVE");
        assert.equal(move?.status_rx, 416);
        const receipt = JSON.parse(move?.rx ?? "null");
        assert.equal(receipt?.problem?.type, "https://problems.plurnk.xyz/schemes/slicer/range-not-satisfiable");
        await assert.rejects(readFile(join(root, "copy.png")), { code: "ENOENT" });
        assert.deepEqual(await readFile(join(root, "logo.png")), PNG);
    } finally { await rm(root, { recursive: true, force: true }); }
});

for (const operand of ["source", "destination"]) test(`{§binary-parity} a textual anchor on the byte ${operand} is a typed range refusal`, async () => {
    const dsl = operand === "source"
        ? "````COPY (logo.png) <@abcde> (copy.png)````"
        : "````COPY (logo.png) (copy.png) <@abcde>````";
    const { root, operations } = await runCopy({ "logo.png": PNG }, dsl);
    try {
        const receipt = operations.find(({ op }) => op === "COPY");
        assert.equal(receipt?.status_rx, 416, JSON.stringify(receipt));
        assert.match(JSON.parse(receipt?.rx ?? "null").problem.type, /\/range-not-satisfiable$/);
        await assert.rejects(readFile(join(root, "copy.png")), { code: "ENOENT" });
        assert.deepEqual(await readFile(join(root, "logo.png")), PNG);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§binary-parity} MOVE of a whole binary file relocates the bytes and deletes the source", async () => {
    const { root } = await runCopy({ "a.png": PNG }, "````MOVE (a.png) (b.png)````");
    try {
        assert.ok(Buffer.from(await readFile(join(root, "b.png"))).equals(PNG), "the destination has the bytes");
        assert.ok(await gone(join(root, "a.png")), "the source is gone after MOVE");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§binary-parity} <1,-1> is the whole resource, identical to unscoped", async () => {
    const { root } = await runCopy({ "logo.png": PNG }, "````COPY (logo.png) <1,-1> (whole.png)````");
    try {
        assert.ok(Buffer.from(await readFile(join(root, "whole.png"))).equals(PNG), "<1,-1> copies every byte");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§binary-parity} a byte range copies exactly those bytes (coordinate = byte)", async () => {
    const { root } = await runCopy({ "logo.png": PNG }, "````COPY (logo.png) <1,8> (head.png)````");
    try {
        // The 8-byte PNG signature, 1-indexed bytes 1..8 inclusive.
        assert.ok(Buffer.from(await readFile(join(root, "head.png"))).equals(PNG.subarray(0, 8)), "bytes 1..8 are the PNG signature");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§binary-parity} a byte-pattern COPY and MOVE select the same native fragments", async () => {
    const bytes = Buffer.from([0, 0x41, 0x42, 0xff, 0x41, 0x42, 0]);
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, `binpattern-transfer-${crypto.randomUUID()}`, { producer: "client" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const ctx = makeSchemeCtx({ db, ...env, mimetypes: DEFAULT_MIMETYPES });
        await EntryCrud.writeEntry({ authority: "", pathname: "/source.png" }, { channels: { body: { content: "", bytes, mimetype: "image/png" } } }, ctx, "workspace");
        const matcher = { dialect: "regex" as const, raw: "/AB/", pattern: "AB", flags: "" };
        const copyBase = copyStmt(urlPath("workspace", "/source.png"), urlPath("workspace", "/copy.png"));
        const moveBase = moveStmt(urlPath("workspace", "/source.png"), urlPath("workspace", "/move.png"));
        const copyRes = await engine.dispatch({ ...env, statement: { ...copyBase, source: { ...copyBase.source, matcher } }, sequence: 1, origin: "client" });
        const moveRes = await engine.dispatch({ ...env, statement: { ...moveBase, source: { ...moveBase.source, matcher } }, sequence: 2, origin: "client" });
        assert.deepEqual([copyRes.status, moveRes.status], [201, 201]);
        const readBytes = async (pathname: string) => Buffer.from((await EntryCrud.readEntry({ authority: "", pathname }, ctx, "workspace")).entry!.channels.body.content, "base64");
        assert.deepEqual(await readBytes("/copy.png"), Buffer.from("ABAB"));
        assert.deepEqual(await readBytes("/move.png"), Buffer.from("ABAB"));
        assert.deepEqual(await readBytes("/source.png"), Buffer.from([0, 0xff, 0]));
    } finally { await db.close(); }
});

test("{§binary-parity} a scoped binary MOVE removes exactly the transferred source bytes", async () => {
    const { root, operations } = await runCopy({ "source.png": PNG }, "````MOVE (source.png) <2,4> (move.png)````");
    try {
        assert.equal(operations.find(({ op }) => op === "MOVE")?.status_rx, 200);
        assert.deepEqual(await readFile(join(root, "move.png")), PNG.subarray(1, 4));
        assert.deepEqual(await readFile(join(root, "source.png")), Buffer.concat([PNG.subarray(0, 1), PNG.subarray(4)]));
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§binary-parity} a same-channel byte MOVE uses pre-mutation coordinates", async () => {
    const source = Buffer.from([0, 1, 2, 3, 4, 5]);
    const { root, operations } = await runCopy({ "source.png": source }, "````MOVE (source.png) <2,3> (source.png) <-1>````");
    try {
        assert.equal(operations.find(({ op }) => op === "MOVE")?.status_rx, 200);
        assert.deepEqual(await readFile(join(root, "source.png")), Buffer.from([0, 3, 4, 5, 1, 2]));
    } finally { await rm(root, { recursive: true, force: true }); }
});

for (const target of ["source.png", "workspace:///source.png"]) test(`{§binary-parity} pattern EDIT of ${target} is a typed refusal, not an anchor invariant failure`, async () => {
    const { root, operations } = await runCopy({ "source.png": PNG }, `${target.startsWith("workspace:") ? `\`\`\`\`COPY (source.png) (${target})\`\`\`\`\n` : ""}\`\`\`\`EDIT (${target}) /PNG/\nreplacement\n\`\`\`\``);
    try {
        const edit = operations.find(({ op }) => op === "EDIT");
        assert.equal(edit?.status_rx, 415, JSON.stringify(edit));
        assert.match(JSON.parse(edit?.rx ?? "null").problem.type, /\/binary-(edit|write)-unsupported$/);
        assert.deepEqual(await readFile(join(root, "source.png")), PNG);
    } finally { await rm(root, { recursive: true, force: true }); }
});

// Distinct, unambiguously-binary fixtures for the region splice (extension drives mimetype).
const BIN16 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
const PATCH = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);

test("{§binary-parity} a destination byte range is spliced: <c,d> becomes the source bytes, the rest untouched", async () => {
    const { root } = await runCopy({ "target.png": BIN16, "patch.png": PATCH }, "````COPY (patch.png) <1,4> (target.png) <5,8>````");
    try {
        const expected = Buffer.concat([BIN16.subarray(0, 4), PATCH, BIN16.subarray(8)]);
        assert.ok(Buffer.from(await readFile(join(root, "target.png"))).equals(expected), "bytes 5..8 became the patch, every other byte kept");
        assert.ok(Buffer.from(await readFile(join(root, "patch.png"))).equals(PATCH), "the source is untouched by the splice");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§binary-parity} a single destination byte position inserts the source bytes before it", async () => {
    const { root } = await runCopy({ "target.png": BIN16, "patch.png": PATCH }, "````COPY (patch.png) <1,2> (target.png) <3>````");
    try {
        const expected = Buffer.concat([BIN16.subarray(0, 2), PATCH.subarray(0, 2), BIN16.subarray(2)]);
        assert.ok(Buffer.from(await readFile(join(root, "target.png"))).equals(expected), "the two patch bytes were inserted before byte 3");
    } finally { await rm(root, { recursive: true, force: true }); }
});

// A binary is not confined to the filesystem: it may live in a session:// DB entry and come back out
// byte-for-byte. Two turns — stash the file into an entry, then copy the entry back to a new file.
const runRoundTrip = async (dsl0: string, dsl1: string) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-binentry-"));
    await writeFile(join(root, "logo.png"), PNG);
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        mockTurn(`${dsl0}

\`\`\`\`NOTE
stashed
\`\`\`\``),
        mockTurn(`${dsl1}

\`\`\`\`NOTE
copied
\`\`\`\``),
        mockTurn("````SEND [200]\ndone\n````"),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `binentry-${Date.now()}`, projectRoot: root });
            const run = await rpcCall(ws, 2, "loop.run", { prompt: "round-trip the binary" });
            const loopId = (run.result as { loopId: number }).loopId;
            await waitForDb(
                () => db.engine_loop_status.get<{ status: number }>({ loop_id: loopId }),
                (r) => r?.status === 200,
                { timeoutMs: 20000 },
            );
            const operations = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; rx: string }>({ loop_id: loopId });
            for (const operation of operations.filter(({ op }) => op === "COPY" || op === "MOVE")) {
                assert.ok([200, 201].includes(operation.status_rx), JSON.stringify(operation));
            }
        } finally { ws.close(); }
    });
    return root;
};

test("{§binary-parity} a binary lives in a session:// entry and round-trips to a file byte-for-byte", async () => {
    const root = await runRoundTrip("````COPY (logo.png) (workspace:///stash.png)````", "````COPY (workspace:///stash.png) (out.png)````");
    try {
        assert.ok(Buffer.from(await readFile(join(root, "out.png"))).equals(PNG), "the binary survived a session:// round-trip byte-for-byte");
    } finally { await rm(root, { recursive: true, force: true }); }
});

for (const intermediate of ["copy.bin", "workspace:///stash"]) {
    test(`{§copy} binary transfers through ${intermediate} retain bytes and type across real turns`, async () => {
        const root = await runRoundTrip(`\`\`\`\`COPY (logo.png) <1,8> (${intermediate})\`\`\`\``,
            `\`\`\`\`COPY (logo.png) <9,-1> (${intermediate}) <-1>\`\`\`\`\n\`\`\`\`MOVE (${intermediate}) (output.png)\`\`\`\``);
        try {
            assert.deepEqual(await readFile(join(root, "output.png")), PNG);
            assert.deepEqual(await readFile(join(root, "logo.png")), PNG);
            if (intermediate === "copy.bin") await assert.rejects(readFile(join(root, intermediate)), { code: "ENOENT" });
        } finally { await rm(root, { recursive: true, force: true }); }
    });
}

for (const op of ["COPY", "MOVE"]) {
    for (const target of ["absent.md", "existing.bin"]) {
        test(`{§copy} ${op} refuses the known textual type of ${target} without changing either file`, async () => {
            const original = Buffer.from("retained text\n");
            const { root, operations } = await runCopy({ "logo.png": PNG, "existing.bin": original },
                `\`\`\`\`${op} (logo.png) (${target}) <1,-1>\`\`\`\``);
            try {
                const result = operations.find((operation) => operation.op === op);
                assert.equal(result?.status_rx, 415, JSON.stringify(result));
                const receipt = JSON.parse(result?.rx ?? "null");
                assert.equal(receipt.problem.type, "https://problems.plurnk.xyz/engine/dispatcher/mimetype-mismatch");
                assert.equal(receipt.problem.destinationMimetype, "text/markdown");
                assert.deepEqual(await readFile(join(root, "logo.png")), PNG);
                assert.deepEqual(await readFile(join(root, "existing.bin")), original);
                await assert.rejects(readFile(join(root, "absent.md")), { code: "ENOENT" });
            } finally { await rm(root, { recursive: true, force: true }); }
        });
    }
}

test("{§binary-parity} a byte range copies out of a session:// entry exactly (coordinate = byte)", async () => {
    const root = await runRoundTrip("````COPY (logo.png) (workspace:///stash.png)````", "````COPY (workspace:///stash.png) <1,8> (head.png)````");
    try {
        assert.ok(Buffer.from(await readFile(join(root, "head.png"))).equals(PNG.subarray(0, 8)), "bytes 1..8 out of the entry are the PNG signature");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§binary-parity} a stored binary supports the same destination splice and scoped MOVE as a file", async () => {
    const root = await runRoundTrip("````COPY (logo.png) (workspace:///stash.png)````",
        "````COPY (logo.png) <2,4> (workspace:///stash.png) <5,8>````\n````MOVE (workspace:///stash.png) <2,4> (moved.png)````\n````COPY (workspace:///stash.png) (remaining.png)````");
    try {
        assert.deepEqual(await readFile(join(root, "moved.png")), PNG.subarray(1, 4));
        assert.deepEqual(await readFile(join(root, "remaining.png")), Buffer.concat([PNG.subarray(0, 1), PNG.subarray(1, 4), PNG.subarray(8)]));
    } finally { await rm(root, { recursive: true, force: true }); }
});

// The read side of the entry story, exercised directly: a binary channel stored in a DB entry keeps its
// bytes base64 in TEXT content, and a default READ recovers them as the hex byte view — no byte source
// handed in, synthesized from the stored content — exactly as a File member's #bytes reads.
const binaryReadStmt = (pathname: string): ReadStatement => ({
    metadata: null, op: "READ", aside: null,
    target: { kind: "url", raw: `workspace:///${pathname}`, scheme: "workspace", username: null, password: null, hostname: null, port: null, pathname: `/${pathname}`, query: null, fragment: null },
    lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 },
});

test("{§scheme-source-bytes} bytes declared as text retain exact UTF-8 rather than exposing base64", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "text-bytes");
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES });
        const coordinate = { authority: "", pathname: "/note.txt" };
        const text = "\ufeffcafé\r\nexact text\n";
        const entry = { channels: { body: { content: "", bytes: Buffer.from(text), mimetype: "text/plain" } } };
        assert.equal((await EntryCrud.writeEntry(coordinate, entry, ctx, "session")).status, 201);
        const stored = await EntryCrud.readEntry(coordinate, ctx, "session");
        assert.equal(stored.entry!.channels.body.content, text);
        await assert.rejects(EntryCrud.writeEntry(coordinate, {
            channels: { body: { ...entry.channels.body, bytes: new Uint8Array([0xff]) } },
        }, ctx, "session"), /encoded data was not valid/u);
        assert.equal((await EntryCrud.readEntry(coordinate, ctx, "session")).entry!.channels.body.content, text, "invalid text bytes do not destroy the existing resource");
    } finally { await db.close(); }
});

test("{§binary-parity} a binary entry stores its bytes base64 and READs back as the hex byte view", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `binentry-read-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES, weigh: (t: string) => Math.ceil(t.length / 4) });

        const written = await EntryCrud.writeEntry({ authority: "", pathname: "/stash.png" }, { channels: { body: { content: "", bytes: PNG, mimetype: "image/png" } } }, ctx, "workspace");
        assert.equal(written.status, 201);
        const rows = await db.entry_read_channels.all<{ name: string; content: string; mimetype: string }>({ entry_id: written.entryId });
        assert.equal(rows[0].mimetype, "image/png", "the binary mimetype is preserved");
        assert.equal(rows[0].content, PNG.toString("base64"), "the bytes are stored base64 in TEXT content");

        const read = await readThroughScheme("workspace", null, binaryReadStmt("stash.png"), ctx);
        assert.equal(read.status, 200, "a default READ of the binary entry succeeds");
        assert.equal(read.mimetype, "image/png", "the byte view never relabels the source mimetype");
        assert.equal(read.projection, "hex", "it projects as the hex byte view");
        assert.equal(read.startLine, 1, "the byte window starts at byte 1");
        assert.match(read.content ?? "", /^89\n50\n4e\n47\n/, "one hex octet per line, opening on the PNG signature 89 50 4e 47");
    } finally { await db.close(); }
});

test("{§binary-parity} a READ pattern selects source bytes, retaining byte coordinates and exact evidence", async () => {
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `binpattern-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const ctx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES });
    await EntryCrud.writeEntry({ authority: "", pathname: "/stash.png" }, { channels: { body: { content: "", bytes: PNG, mimetype: "image/png" } } }, ctx, "workspace");
    const statement: ReadStatement = { ...binaryReadStmt("stash.png"), matcher: { dialect: "regex", raw: "/\\r/", pattern: "\\r", flags: "" }, lineMarker: { marks: [1, 8] } };
    const read = await readThroughScheme("workspace", null, statement, ctx);
    assert.equal(read.status, 200, JSON.stringify(read));
    assert.equal(read.content, "0d\n");
    assert.equal(read.projection, "hex");
    assert.equal(read.mimetype, "image/png");
    assert.deepEqual(read.lineOrdinals, [5]);
    assert.deepEqual(read.range, { unit: "byte", total: PNG.length, requested: [1, 8], returned: [5, 5] });
    assert.deepEqual(read.matches, [{ region: { startLine: 5, startColumn: 1, endLine: 5, endColumn: 3 }, matched: "0d" }]);
    const empty = await readThroughScheme("workspace", null, { ...statement, lineMarker: { marks: [6, 8] } }, ctx);
    assert.equal(empty.status, 204);
    assert.equal(empty.content, "");
    assert.equal(empty.matched, 0);
    assert.deepEqual(empty.matches, []);
});

// FIND treats a binary entry as bytes, never as its base64 text: a byte run in the entry's bytes is
// found, and a text search over the workspace is never poisoned into matching a binary's base64.
const findBody = (raw: string, pattern: string): FindStatement => ({
    metadata: null, op: "FIND", aside: null,
    target: { kind: "url", raw: "workspace:///**", scheme: "workspace", username: null, password: null, hostname: null, port: null, pathname: "/**", query: null, fragment: null },
    lineMarker: null, matcher: { dialect: "regex", raw, pattern, flags: "" }, body: null, position: { line: 1, column: 1 },
});

test("{§binary-parity} FIND searches a binary entry as its bytes, never its base64 text", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `binfind-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES });
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/stash.png", channel: "body", content: PNG.toString("base64"), mimetype: "image/png" });
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/notes.md", channel: "body", content: "the needle is here", mimetype: "text/markdown" });

        // "IHDR" is a literal byte run in every PNG header — findable in the decoded bytes, not in the note.
        const png = await EntryFind.findWorkspaceEntries(findBody("/IHDR/", "IHDR"), ctx, Workspace.manifest, {  });
        assert.equal(png.status, 200);
        assert.equal(resourcePaths(png).filter((p) => p.includes("stash.png")).length, 1, "the byte run is found inside the binary entry");
        assert.equal(resourcePaths(png).some((p) => p.includes("notes.md")), false, "the text note has no such bytes");

        // A text needle matches the note only — a binary channel is never text-searched over its base64.
        const needle = await EntryFind.findWorkspaceEntries(findBody("/needle/", "needle"), ctx, Workspace.manifest, {  });
        assert.equal(needle.status, 200);
        assert.equal(resourcePaths(needle).filter((p) => p.includes("notes.md")).length, 1, "the text note matches");
        assert.equal(resourcePaths(needle).some((p) => p.includes("stash.png")), false, "the binary entry is never poisoned into a text match");
    } finally { await db.close(); }
});
});

describe("copy-move-pattern", () => {
// {§copy} — a pattern on a COPY or MOVE source selects exact matching spans; the
// destination is a place named by its scope. Zero matches change nothing.









const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`, { producer: "client" });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    await new Workspace().edit(editStmt(urlPath("workspace", "/notes.md"), "alpha\nTODO one\nbeta\nTODO two\ngamma"), makeSchemeCtx({ db, workspaceId: env.workspaceId, sessionId: env.sessionId }));
    let sequence = 0;
    const dispatch = (statement: CopyStatement | MoveStatement) => {
        sequence += 1;
        return engine.dispatch({ statement, workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence, origin: "client" });
    };
    const body = async (pathname: string) => (await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname, name: "body" }))?.content;
    return { db, dispatch, body };
};

const literal: MatcherBody = { dialect: "glob", raw: "TODO" };
const withSource = <T extends CopyStatement | MoveStatement>(statement: T, matcher: MatcherBody): T => ({ ...statement, source: { ...statement.source, matcher } });

test("{§copy} COPY by pattern lands exactly the matching text and leaves the source alone", async () => {
    const { db, dispatch, body } = await setup();
    try {
        const r = await dispatch(withSource(copyStmt(urlPath("workspace", "/notes.md"), urlPath("workspace", "/todos.md")), literal));
        assert.equal(r.status, 201, JSON.stringify(r));
        assert.equal(r.matched, 2, "the receipt counts the selected spans");
        assert.equal(await body("/todos.md"), "TODOTODO");
        assert.equal(await body("/notes.md"), "alpha\nTODO one\nbeta\nTODO two\ngamma", "COPY reads only");
    } finally { await db.close(); }
});

test("{§copy} a scoped source bounds the lines a pattern may select", async () => {
    const { db, dispatch, body } = await setup();
    try {
        const r = await dispatch(withSource(copyStmt(urlPath("workspace", "/notes.md"), urlPath("workspace", "/todos.md"), { marks: [1, 3] }), literal));
        assert.equal(r.status, 201, JSON.stringify(r));
        assert.equal(r.matched, 1);
        assert.equal(await body("/todos.md"), "TODO");
    } finally { await db.close(); }
});

test("{§copy} zero matches copy nothing and answer 204", async () => {
    const { db, dispatch, body } = await setup();
    try {
        const r = await dispatch(withSource(copyStmt(urlPath("workspace", "/notes.md"), urlPath("workspace", "/todos.md")), { dialect: "glob", raw: "DONE" }));
        assert.equal(r.status, 204, JSON.stringify(r));
        assert.equal(r.matched, 0);
        assert.equal(await body("/todos.md"), undefined, "no destination was created");
    } finally { await db.close(); }
});

test("{§copy} MOVE by pattern removes exactly the matching spans from the source", async () => {
    const { db, dispatch, body } = await setup();
    try {
        // Regex anchors refer to source lines without requiring an explicit `m` flag.
        const regex: MatcherBody = { dialect: "regex", raw: "/^TODO/", pattern: "^TODO", flags: "" };
        const r = await dispatch(withSource(moveStmt(urlPath("workspace", "/notes.md"), urlPath("workspace", "/todos.md")), regex));
        assert.equal(r.status, 201, JSON.stringify(r));
        assert.equal(r.matched, 2);
        assert.equal(await body("/todos.md"), "TODOTODO");
        assert.equal(await body("/notes.md"), "alpha\n one\nbeta\n two\ngamma", "surrounding content stays in the source");
        const effects = r.effects as ReadonlyArray<{ target: string; action: string }>;
        assert.deepEqual(effects.map(({ target, action }) => `${action} ${target}`), [
            "create workspace:///todos.md", "update workspace:///notes.md", "update workspace:///notes.md",
        ], "one destination effect, one source effect per removed span");
    } finally { await db.close(); }
});

test("{§copy} MOVE by pattern within one channel appends the spans and removes them where they were", async () => {
    const { db, dispatch, body } = await setup();
    try {
        const r = await dispatch(withSource(moveStmt(urlPath("workspace", "/notes.md"), urlPath("workspace", "/notes.md"), null, { marks: [-1] }), literal));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 2);
        assert.equal(await body("/notes.md"), "alpha\n one\nbeta\n two\ngamma\nTODOTODO");
    } finally { await db.close(); }
});

test("{§copy} a pattern on the destination is refused: a destination is a place", async () => {
    const { db, dispatch, body } = await setup();
    try {
        const statement = copyStmt(urlPath("workspace", "/notes.md"), urlPath("workspace", "/todos.md"));
        const r = await dispatch({ ...statement, destination: { ...statement.destination, matcher: literal } });
        assert.equal(r.status, 400, JSON.stringify(r));
        assert.match(String(r.problem?.type), /\/pattern-destination-unsupported$/);
        assert.equal(await body("/todos.md"), undefined);
    } finally { await db.close(); }
});

test("{§copy} a full-text pattern transfers matching tokens without surrounding source", async () => {
    const { db, dispatch, body } = await setup();
    try {
        const r = await dispatch(withSource(copyStmt(urlPath("workspace", "/notes.md"), urlPath("workspace", "/todos.md")), { dialect: "fts", raw: "~TODO" }));
        assert.equal(r.status, 201, JSON.stringify(r));
        assert.equal(await body("/todos.md"), "TODOTODO");
        assert.equal(await body("/notes.md"), "alpha\nTODO one\nbeta\nTODO two\ngamma");
    } finally { await db.close(); }
});
});

describe("copy-move-to-file", () => {
// COPY/MOVE into files — a disk write under {§copy},
// {§move}, and the {§proposal} gate.
// The dest write proposes (202); on accept the file lands + an entry registers.
// MOVE's source-delete is DEFERRED to after the accept, so a rejected MOVE leaves
// the source intact (no data loss behind a pending review).


















const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
};

type Ctx = { db: Db; engine: Engine; workspaceId: number; sessionId: number; loopId: number; turnId: number };

const withWorkspace = async (fn: (root: string, ctx: Ctx) => Promise<void>): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-cpmv-"));
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES, weigh: (t: string) => Math.ceil(t.length / 4) });
        const workspaceId = await insertWorkspace(db, `cpmv-${crypto.randomUUID()}`);
        await db.test_set_workspace_project_root.run({ id: workspaceId, project_root: root });
        const sessionId = await insertSession(db, workspaceId);
        await ownSession(db, workspaceId, sessionId);
        const loopId = await insertLoop(db, sessionId, 1, "cpmv");
        const turnId = await insertTurn(db, loopId, 1, 102);
        await fn(root, { db, engine, workspaceId, sessionId, loopId, turnId });
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
};

const seedSession = (ctx: Ctx, pathname: string, content: string) =>
    new Workspace().edit(editStmt(urlPath("workspace", `/${pathname}`), content), makeSchemeCtx({ db: ctx.db, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId }));

const sessionEntry = (ctx: Ctx, pathname: string) =>
    ctx.db.test_get_entry_by_pathname_scheme.get<{ pathname: string }>({ pathname: `/${pathname}`, scheme: "workspace" });

// {§file-snapshot-revision}: materialize through the production snapshot owner.
const seedFileMember = async (ctx: Ctx, root: string, rel: string, content: string): Promise<void> => {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    await ctx.db.test_seed_entry_workspace.get({ attributes: "{}", default_channel: "body", output: 0, workspace_id: ctx.workspaceId, scheme: "file", authority: "", pathname: rel });
    await MembershipMaterialization.materializeMember(rel, root, makeSchemeCtx({ ...ctx, mimetypes: DEFAULT_MIMETYPES }), new Map());
};

const fileMember = async (ctx: Ctx, rel: string) =>
    ctx.db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: ctx.workspaceId, scheme: "file", authority: "", pathname: rel });

const generatedPicks = (ctx: Ctx) =>
    ctx.db.crud_list_workspace_constraints.all<{ effect: string; glob: string; source: string }>({ workspace_id: ctx.workspaceId });

const killStmt = (target: ParsedPath): KillStatement => ({ metadata: null, op: "KILL", aside: null, target, lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 } });

const proposeAndResolve = async (
    ctx: Ctx,
    statement: Parameters<Engine["dispatch"]>[0]["statement"],
    decision: "accept" | "reject",
    body?: string,
) => {
    const id = deferred<number>();
    const dispatchPromise = ctx.engine.dispatch({
        statement, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId, turnId: ctx.turnId,
        sequence: 1, origin: "model", onDispatch: (logId) => id.resolve(logId),
    });
    const logEntryId = await id.promise;
    if (!ctx.engine.pendingProposalIds().includes(logEntryId)) assert.fail(`Expected a proposal, received ${JSON.stringify(await dispatchPromise)}`);
    ctx.engine.resolveProposal(logEntryId, {
        decision,
        ...(body === undefined ? {} : { body }),
    });
    return dispatchPromise;
};

test("{§fs-write-surface} {§copy}: COPY workspace:/// → file proposes then lands on accept", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedSession(ctx, "note", "copied content\n");
        const result = await proposeAndResolve(ctx, copyStmt(urlPath("workspace", "/note"), localPath("copied.txt")), "accept");
        assert.equal(result.status, 200);
        assert.deepEqual(result.effects, [{
            target: "copied.txt",
            action: "create",
        }]);
        assert.equal(await readFile(join(root, "copied.txt"), "utf8"), "copied content\n");
        assert.notEqual(await sessionEntry(ctx, "note"), undefined, "COPY leaves the source intact");
        assert.deepEqual(await generatedPicks(ctx), [
            { effect: "include", glob: "copied.txt", source: "create" },
        ], "COPY destination creation uses the ordinary generated-pick contract");
    });
});

for (const transfer of [copyStmt, moveStmt]) {
    const op = transfer(urlPath("workspace", "/note"), localPath("copied.txt")).op;
    for (const decision of ["accept", "reject"] as const) {
        test(`{§mimetype-verbatim-transfer}: ${op} plain text to a file respects ${decision} before changing either resource`, async () => {
            await withWorkspace(async (root, ctx) => {
                const content = "## Result\r\n\t<verbatim> café\r\n";
                await seedEntryWithChannel(ctx.db, { workspaceId: ctx.workspaceId, pathname: "/note", content, mimetype: "text/plain" });
                const result = await proposeAndResolve(ctx, transfer(urlPath("workspace", "/note"), localPath("copied.txt")), decision);
                if (decision === "accept") {
                    assert.equal(result.status, 200);
                    assert.equal(await readFile(join(root, "copied.txt"), "utf8"), content);
                    const destination = await ctx.db.test_get_channel_by_pathname_scheme.get<{ mimetype: string }>({ scheme: "file", pathname: "copied.txt", name: "body" });
                    assert.equal(destination?.mimetype, "text/markdown");
                } else {
                    assert.equal(result.status, 400);
                    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/proposal/rejected");
                    await assert.rejects(readFile(join(root, "copied.txt")), { code: "ENOENT" });
                }
                const source = await ctx.db.test_get_channel_by_pathname_scheme.get<{ content: string; mimetype: string }>({ scheme: "workspace", pathname: "/note", name: "body" });
                if (op === "MOVE" && decision === "accept") assert.equal(source, undefined);
                else {
                    assert.equal(source?.content, content);
                    assert.equal(source?.mimetype, "text/plain");
                }
            });
        });
    }
}

test("{§notifications-loop-proposal} live and reconnect use one COPY destination proposal projection", async () => {
    await withWorkspace(async (_root, ctx) => {
        await seedSession(ctx, "note", "copied content\n");
        const observed = deferred<ProposalPendingEvent>();
        ctx.engine.onProposalPending((event) => observed.resolve(event));
        const dispatched = ctx.engine.dispatch({
            statement: copyStmt(urlPath("workspace", "/note"), localPath("parity.txt")),
            workspaceId: ctx.workspaceId,
            sessionId: ctx.sessionId,
            loopId: ctx.loopId,
            turnId: ctx.turnId,
            sequence: 1,
            origin: "model",
        });

        const live = await observed.promise;
        const reconnect = await ctx.engine.pendingProposals(ctx.workspaceId);
        const { workspaceId, ...liveProjection } = live;
        assert.equal(workspaceId, ctx.workspaceId);
        assert.deepEqual(reconnect, [liveProjection], "live delivery and durable rediscovery are byte-for-byte the same domain projection");
        assert.deepEqual(live.target, { scheme: null, authority: "", pathname: "parity.txt" }, "COPY review addresses the applied destination, not its source");
        assert.match(live.body, /copied content/, "review body comes from the proposed result rather than serialized statement JSON");
        assert.deepEqual(live.disposition, { decision: "review" });

        ctx.engine.resolveProposal(live.logEntryId, { decision: "reject" });
        await dispatched;
    });
});

test("{§copy} a scoped COPY into a new file reports the accepted creation receipt", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedSession(ctx, "note", "alpha\nbeta\ngamma\n");
        const result = await proposeAndResolve(
            ctx,
            copyStmt(
                urlPath("workspace", "/note"),
                localPath("slice.md"),
                { marks: [2, 3] },
            ),
            "accept",
        );
        assert.equal(result.status, 200);
        assert.equal(await readFile(join(root, "slice.md"), "utf8"), "beta\ngamma\n");
        assert.ok(Array.isArray(result.effects));
        const [effect] = result.effects as Array<{
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
        assert.match(effect?.receipt?.effect.context ?? "", /1<@[0-9A-Za-z]{5}>beta\n2<@[0-9A-Za-z]{5}>gamma/);
    });
});

test("{§copy} a scoped COPY receipt reports parser recovery for the complete landed file", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedSession(ctx, "broken.go", "package sample\nfunc broken(\n");
        const result = await proposeAndResolve(
            ctx,
            copyStmt(
                urlPath("workspace", "/broken.go"),
                localPath("copied.go"),
                { marks: [1, 2] },
            ),
            "accept",
        );
        assert.equal(result.status, 200);
        const effect = (result.effects as Array<{
            receipt?: { parseIssues?: { before: number; after: number } };
        }> | undefined)?.[0];
        assert.equal(effect?.receipt?.parseIssues?.before, 0);
        assert.ok(Number.isSafeInteger(effect?.receipt?.parseIssues?.after));
        assert.ok((effect?.receipt?.parseIssues?.after ?? 0) > 0);
        assert.equal(await readFile(join(root, "copied.go"), "utf8"), "package sample\nfunc broken(\n");
        const entry = await fileMember(ctx, "copied.go");
        const channel = await ctx.db.test_get_channel.get<{ mimetype: string }>({
            entry_id: entry?.id,
            name: "body",
        });
        assert.equal(channel?.mimetype, "text/x-go");
    });
});

test("{§proposal-reject-fails}: a rejected COPY into a file never touches disk", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedSession(ctx, "note", "nope\n");
        const result = await proposeAndResolve(ctx, copyStmt(urlPath("workspace", "/note"), localPath("rejected.txt")), "reject");
        assert.ok(result.status >= 400, "rejected proposal is a 4xx");
        assert.equal(result.effects, undefined, "a rejected destination proposal lands no effect");
        await assert.rejects(readFile(join(root, "rejected.txt"), "utf8"), "the rejected COPY never created the file");
    });
});

test("{§copy} a regional COPY into a file reports the accepted text receipt", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedSession(ctx, "note", "alpha\nbeta\ngamma\n");
        await seedFileMember(ctx, root, "destination.md", "before\nreplace\nafter\n");
        const result = await proposeAndResolve(
            ctx,
            copyStmt(
                urlPath("workspace", "/note"),
                localPath("destination.md"),
                { marks: [2] },
                { marks: [2] },
            ),
            "accept",
        );
        assert.equal(result.status, 200);
        assert.equal(await readFile(join(root, "destination.md"), "utf8"), "before\nbeta\nafter\n");
        assert.ok(Array.isArray(result.effects));
        const [effect] = result.effects as Array<{
            target: string;
            action: string;
            receipt?: { effect?: { requested?: string; context?: string } };
        }>;
        assert.equal(effect?.target, "destination.md");
        assert.equal(effect?.action, "update");
        assert.equal(effect?.receipt?.effect?.requested, "<2>");
        assert.match(effect?.receipt?.effect?.context ?? "", /1<@[0-9A-Za-z]{5}>before\n2<@[0-9A-Za-z]{5}>beta\n3<@[0-9A-Za-z]{5}>after/);
    });
});

test("{§move}: accepted MOVE lands the file and deletes the source", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedSession(ctx, "movee", "moved content\n");
        const result = await proposeAndResolve(ctx, moveStmt(urlPath("workspace", "/movee"), localPath("moved.txt")), "accept");
        assert.equal(result.status, 200);
        assert.deepEqual(result.effects, [
            { target: "moved.txt", action: "create" },
            { target: "workspace:///movee", action: "delete" },
        ]);
        assert.equal(await readFile(join(root, "moved.txt"), "utf8"), "moved content\n");
        assert.equal(await sessionEntry(ctx, "movee"), undefined, "MOVE deletes the source on accept");
    });
});

test("{§copy} a same-file regional MOVE reports both accepted effects from one batch", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedFileMember(ctx, root, "document.md", "abcdef");
        const result = await proposeAndResolve(
            ctx,
            moveStmt(
                localPath("document.md"),
                localPath("document.md"),
                { marks: [1, 2, 1, 4] },
                { marks: [1, 7, 1, 7] },
            ),
            "accept",
        );
        assert.equal(result.status, 200);
        assert.equal(await readFile(join(root, "document.md"), "utf8"), "adefbc");
        assert.ok(Array.isArray(result.effects));
        const effects = result.effects as Array<{
            target: string;
            action: string;
            receipt?: { effect?: { requested?: string } };
        }>;
        assert.deepEqual(
            effects.map(({ target, action }) => ({ target, action })),
            [
                { target: "document.md", action: "update" },
                { target: "document.md", action: "update" },
            ],
        );
        assert.deepEqual(
            effects.map(({ receipt }) => receipt?.effect?.requested),
            ["<1,7,1,7>", "<1,2,1,4>"],
        );
    });
});

test("{§copy} a reviewer-rewritten same-file MOVE reports its one landed replacement effect (#172)", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedFileMember(ctx, root, "document.md", "abcdef");
        const reviewed = "reviewer\nreplacement\n";
        const result = await proposeAndResolve(
            ctx,
            moveStmt(
                localPath("document.md"),
                localPath("document.md"),
                { marks: [1, 2, 1, 4] },
                { marks: [1, 7, 1, 7] },
            ),
            "accept",
            reviewed,
        );

        assert.equal(result.status, 200);
        assert.equal(await readFile(join(root, "document.md"), "utf8"), reviewed);
        assert.ok(Array.isArray(result.effects));
        const effects = result.effects as Array<{
            target: string;
            action: string;
            receipt?: {
                disposition?: string;
                requested?: string;
                replacement?: {
                    requested: string;
                    source: string;
                    result: string;
                    removed: number;
                    inserted: number;
                    context: string;
                };
            };
        }>;
        assert.equal(effects.length, 1, "one arbitrary resource replacement earns one effect");
        assert.deepEqual(
            effects.map(({ target, action }) => ({ target, action })),
            [{ target: "document.md", action: "update" }],
        );
        assert.equal(effects[0]?.receipt?.disposition, "superseded");
        assert.equal(effects[0]?.receipt?.requested, "<1,7,1,7>");
        const { context: landedContext, ...landed } = effects[0]?.receipt?.replacement ?? {};
        assert.deepEqual(landed, { requested: "<1,-1>", source: "<1>", result: "<1,2>", removed: 1, inserted: 2 });
        assert.match(String(landedContext), /^1<@[0-9A-Za-z]{5}>reviewer\n2<@[0-9A-Za-z]{5}>replacement$/);
    });
});

test("{§copy} a reviewer-rewritten cross-resource MOVE still reports its landed source removal (#172)", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedSession(ctx, "source", "alpha\nbeta\ngamma\n");
        await seedFileMember(ctx, root, "destination.md", "before\nreplace\nafter\n");
        const reviewed = "reviewer\ndestination\n";
        const result = await proposeAndResolve(
            ctx,
            moveStmt(
                urlPath("workspace", "/source"),
                localPath("destination.md"),
                { marks: [2] },
                { marks: [2] },
            ),
            "accept",
            reviewed,
        );

        assert.equal(result.status, 200);
        assert.equal(await readFile(join(root, "destination.md"), "utf8"), reviewed);
        const source = await ctx.db.test_get_channel_by_pathname_scheme.get<{
            content: string;
        }>({ pathname: "/source", scheme: "workspace", name: "body" });
        assert.equal(source?.content, "alpha\ngamma\n");
        assert.ok(Array.isArray(result.effects));
        const effects = result.effects as Array<{
            target: string;
            action: string;
            receipt?: {
                disposition?: string;
                requested?: string;
                effect?: { requested?: string };
                replacement?: { context?: string };
            };
        }>;
        assert.deepEqual(
            effects.map(({ target, action }) => ({ target, action })),
            [
                { target: "destination.md", action: "update" },
                { target: "workspace:///source", action: "update" },
            ],
        );
        assert.equal(effects[0]?.receipt?.disposition, "superseded");
        assert.equal(effects[0]?.receipt?.requested, "<2>");
        assert.match(effects[0]?.receipt?.replacement?.context ?? "", /1<@[0-9A-Za-z]{5}>reviewer\n2<@[0-9A-Za-z]{5}>destination/);
        assert.equal(effects[1]?.receipt?.effect?.requested, "<2>");
    });
});

test("{§proposal-reject-fails}: a rejected MOVE into a file preserves the source", async () => {
    await withWorkspace(async (_root, ctx) => {
        await seedSession(ctx, "keepme", "keep\n");
        const result = await proposeAndResolve(ctx, moveStmt(urlPath("workspace", "/keepme"), localPath("rejected-move.txt")), "reject");
        assert.ok(result.status >= 400, "rejected proposal is a 4xx");
        assert.equal(result.effects, undefined, "a rejected destination proposal lands no effect");
        assert.notEqual(await sessionEntry(ctx, "keepme"), undefined, "the source MUST survive a rejected MOVE — the delete was deferred behind the dest write");
    });
});

test("{§fs-write-surface} {§move}: file MOVE into a new subdir lands and unlinks", async () => {
    // The file→file MOVE that was a silent noop: File lacked deleteEntry, so #handleMove returned a
    // bare 501 before any write — the model's correct MOVE did nothing while the session concluded 200.
    await withWorkspace(async (root, ctx) => {
        await seedFileMember(ctx, root, "brief.md", "the brief\n");
        const source = await fileMember(ctx, "brief.md");
        await ctx.db.crud_set_origin.run({ entry_id: source?.id, membership_origin: "constraint" });
        await ctx.db.crud_insert_generated_workspace_constraint.run({ workspace_id: ctx.workspaceId, glob: "brief.md" });
        // BARE paths — exactly what the model emits (`MOVE(brief.md):drafts/brief.md`). The source
        // read must normalize `brief.md` → the `/brief.md` member key, or it 404s a real member.
        const result = await proposeAndResolve(ctx, moveStmt(localPath("brief.md"), localPath("drafts/brief.md")), "accept");
        assert.equal(result.status, 200);
        assert.deepEqual(result.effects, [
            { target: "drafts/brief.md", action: "create" },
            { target: "brief.md", action: "delete" },
        ]);
        assert.equal(await readFile(join(root, "drafts/brief.md"), "utf8"), "the brief\n", "dest written into the freshly-created subdir");
        await assert.rejects(readFile(join(root, "brief.md"), "utf8"), "source file unlinked — a MOVE, not a COPY");
        assert.equal(await fileMember(ctx, "brief.md"), undefined, "source entry deregistered");
        assert.deepEqual(await generatedPicks(ctx), [
            { effect: "include", glob: "drafts/brief.md", source: "create" },
        ], "MOVE transfers generated creation provenance from source to destination");
    });
});

test("{§move}: file MOVE with <1,-1> to absent <0> unlinks rather than hollows the source", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedFileMember(ctx, root, "brief.md", "the brief\n");
        const result = await proposeAndResolve(
            ctx,
            moveStmt(localPath("brief.md"), localPath("drafts/brief.md"), fullReplace, { marks: [0] }),
            "accept",
        );
        assert.equal(result.status, 200);
        assert.deepEqual(result.effects, [
            { target: "drafts/brief.md", action: "create" },
            { target: "brief.md", action: "delete" },
        ]);
        assert.equal(await readFile(join(root, "drafts/brief.md"), "utf8"), "the brief\n");
        await assert.rejects(readFile(join(root, "brief.md"), "utf8"), "the canonical whole-content MOVE unlinks its source");
        assert.equal(await fileMember(ctx, "brief.md"), undefined, "the source member is deregistered");
    });
});

test("{§move} MOVE from a file to an internal destination applies the source proposal after the destination lands", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedFileMember(ctx, root, "source.md", "source content\n");
        const result = await proposeAndResolve(
            ctx,
            moveStmt(localPath("source.md"), urlPath("workspace", "/moved")),
            "accept",
        );
        assert.equal(result.status, 200);
        assert.deepEqual(result.effects, [
            { target: "workspace:///moved", action: "create" },
            { target: "source.md", action: "delete" },
        ]);
        assert.notEqual(await sessionEntry(ctx, "moved"), undefined);
        await assert.rejects(readFile(join(root, "source.md"), "utf8"));
        assert.equal(await fileMember(ctx, "source.md"), undefined);
    });
});

for (const destinationKind of ["file", "session"] as const) {
    for (const scoped of [false, true]) {
        test(`{§move} MOVE ${scoped ? "regional" : "whole"} file source to ${destinationKind} applies both effects`, async () => {
            await withWorkspace(async (root, ctx) => {
                await seedFileMember(ctx, root, "source.md", "keep\nmove\n");
                const statement = moveStmt(
                    localPath("source.md"),
                    destinationKind === "file" ? localPath("destination.md") : urlPath("workspace", "/destination"),
                    scoped ? { marks: [2] } : null,
                );
                const result = await proposeAndResolve(ctx, statement, "accept");
                assert.equal(result.status, 200, JSON.stringify(result));
                assert.deepEqual(assertResourceEffects(result.effects).map(({ target, action }) => ({ target, action })), [
                    { target: destinationKind === "file" ? "destination.md" : "workspace:///destination", action: "create" },
                    { target: "source.md", action: scoped ? "update" : "delete" },
                ]);
                if (scoped) assert.equal(await readFile(join(root, "source.md"), "utf8"), "keep\n");
                else await assert.rejects(readFile(join(root, "source.md")), { code: "ENOENT" });
                const expected = scoped ? "move\n" : "keep\nmove\n";
                if (destinationKind === "file") assert.equal(await readFile(join(root, "destination.md"), "utf8"), expected);
                else assert.equal((await ctx.db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
                    pathname: "/destination", scheme: "workspace", name: "body",
                }))?.content, expected);
            });
        });
    }
}

test("{§copy} rejecting a source-side MOVE proposal reports the already-written destination without deleting the source", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedFileMember(ctx, root, "source.md", "source content\n");
        const result = await proposeAndResolve(
            ctx,
            moveStmt(localPath("source.md"), urlPath("workspace", "/copied")),
            "reject",
        );
        assert.equal(result.status, 409);
        assert.equal(result.problem?.destinationWritten, true);
        assert.equal(result.problem?.destination, "workspace:///copied");
        assert.deepEqual(result.effects, [{
            target: "workspace:///copied",
            action: "create",
        }]);
        assert.notEqual(await sessionEntry(ctx, "copied"), undefined);
        assert.equal(await readFile(join(root, "source.md"), "utf8"), "source content\n");
        assert.notEqual(await fileMember(ctx, "source.md"), undefined);
    });
});

test("{§copy} EDIT onto an existing NON-member file is refused (403) and never clobbers it", async () => {
    // The unfair edge: a file exists on disk but was never tracked (git/client left it out), so it's
    // INVISIBLE to the model. The model, blind to it, tries to "create" it — and MUST NOT be able to
    // overwrite it. The refusal is opaque (never reveals the file exists) so the model can't probe the
    // untracked filesystem by watching which creates fail.
    await withWorkspace(async (root, ctx) => {
        await writeFile(join(root, "AGENTS.md"), "SECRET untracked policy\n", "utf8"); // on disk, NOT a member
        // A refused create returns 403 outright — it never PROPOSES (no review to accept), so dispatch directly.
        const result = await ctx.engine.dispatch({
            statement: editStmt(localPath("AGENTS.md"), "# the model's clobbering content"),
            workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 403, "create over an existing non-member is refused outright, never a proposal, never clobbered");
        assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "SECRET untracked policy\n", "the untracked file is untouched");
    });
});

test("{§copy} KILL of a file is a destructive host delete → it PROPOSES; on accept the file is unlinked + deregistered", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedFileMember(ctx, root, "doomed.txt", "delete me\n");
        const result = await proposeAndResolve(ctx, killStmt(localPath("doomed.txt")), "accept");
        assert.equal(result.status, 200, "KILL proposed for review, then applied on accept");
        await assert.rejects(readFile(join(root, "doomed.txt"), "utf8"), "the host file was unlinked");
        assert.equal(await fileMember(ctx, "doomed.txt"), undefined, "the entry was deregistered");
    });
});

test("{§copy} a REJECTED KILL of a file preserves it — a destructive delete never bypasses review", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedFileMember(ctx, root, "keep.txt", "keep me\n");
        const result = await proposeAndResolve(ctx, killStmt(localPath("keep.txt")), "reject");
        assert.ok(result.status >= 400, "rejected proposal is a 4xx");
        assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "keep me\n", "the file survives — review gates the destructive op, never a silent unlink");
    });
});

test("{§fs-write-surface} KILL of a NON-member file is 404 — the model can't delete untracked disk it can't see", async () => {
    await withWorkspace(async (root, ctx) => {
        await writeFile(join(root, "untracked.txt"), "not yours\n", "utf8"); // on disk, NOT a member
        const result = await ctx.engine.dispatch({
            statement: killStmt(localPath("untracked.txt")),
            workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 404, "a non-member KILL is 404 — invisible, never touched");
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/file/entry-not-found");
        assert.equal(result.problem?.detail, "No member of this workspace is at 'untracked.txt'.");
        assert.equal(await readFile(join(root, "untracked.txt"), "utf8"), "not yours\n", "the untracked file is untouched");
    });
});

// {§fs-write-surface} {§empty-mutation-scope}
test("{§fs-write-surface}: COPY destination scopes resolve against an empty absent entry", async () => {
    await withWorkspace(async (_root, ctx) => {
        const source = "first prompt\nsecond prompt\nthird prompt\n";
        await seedSession(ctx, "note", source);
        type DestinationMarker = NonNullable<Parameters<typeof copyStmt>[3]>;
        let sequence = 0;
        const dispatch = (dst: string, marker: DestinationMarker | null) => ctx.engine.dispatch({
            statement: copyStmt(urlPath("workspace", "/note"), urlPath("workspace", dst), null, marker),
            workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId, turnId: ctx.turnId, sequence: ++sequence, origin: "model",
        });

        const cases = [
            ["prepend.md", [0]],
            ["first-line.md", [1]],
            ["append.md", [-1]],
            ["whole.md", [1, -1]],
            ["clamped.md", [1, 50]],
            ["exact.md", [1, 1, 1, 1]],
        ] as const;
        for (const [pathname, marks] of cases) {
            const created = await dispatch(`/${pathname}`, { marks: [...marks] });
            assert.equal(created.status, 201, `<${marks.join(",")}> creates an absent destination`);
            const entry = await ctx.db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: `/${pathname}`, scheme: "workspace", name: "body" });
            assert.equal(entry?.content, source, `<${marks.join(",")}> applies the source to the empty destination`);
        }

        await seedSession(ctx, "empty.md", "");
        const intoEmpty = await dispatch("/empty.md", { marks: [1] });
        assert.equal(intoEmpty.status, 200);
        const emptyDestination = await ctx.db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/empty.md", scheme: "workspace", name: "body" });
        assert.equal(emptyDestination?.content, source, "an existing empty destination uses the same coordinate rule");

        const appended = await dispatch("/append.md", { marks: [-1] });
        assert.equal(appended.status, 200);
        const twice = await ctx.db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/append.md", scheme: "workspace", name: "body" });
        assert.equal(twice?.content, source + source, "the second COPY appends after the last line");

        const outsideEmptyDestination = await dispatch("/absent.md", { marks: [2] });
        assert.equal(outsideEmptyDestination.status, 416, "a coordinate outside the empty destination remains unsatisfiable");
        assert.equal(outsideEmptyDestination.problem?.type, "https://problems.plurnk.xyz/schemes/slicer/range-not-satisfiable");
        assert.match(outsideEmptyDestination.problem?.detail ?? "", /Line 2 cannot select from empty content/);
        assert.equal(await sessionEntry(ctx, "absent.md"), undefined);
    });
});

test("{§fs-write-surface}: MOVE <0> onto an absent session entry creates it and removes the source", async () => {
    await withWorkspace(async (_root, ctx) => {
        await seedSession(ctx, "brief.md", "the brief\n");
        const result = await ctx.engine.dispatch({
            statement: moveStmt(
                urlPath("workspace", "/brief.md"),
                urlPath("workspace", "/drafts/brief.md"),
                { marks: [1, -1] },
                { marks: [0] },
            ),
            workspaceId: ctx.workspaceId,
            sessionId: ctx.sessionId,
            loopId: ctx.loopId,
            turnId: ctx.turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 201);
        const destination = await ctx.db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/drafts/brief.md", scheme: "workspace", name: "body" });
        assert.equal(destination?.content, "the brief\n");
        assert.equal(await sessionEntry(ctx, "brief.md"), undefined, "MOVE removes its source after destination creation succeeds");
    });
});

test("{§fs-write-surface}: an impossible destination scope refuses MOVE before any write or source removal", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedSession(ctx, "source.md", "keep this\n");
        const result = await ctx.engine.dispatch({
            statement: moveStmt(urlPath("workspace", "/source.md"), localPath("missing.md"), null, { marks: [37] }),
            workspaceId: ctx.workspaceId,
            sessionId: ctx.sessionId,
            loopId: ctx.loopId,
            turnId: ctx.turnId,
            sequence: 1,
            origin: "model",
        });
        assert.equal(result.status, 416);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/schemes/slicer/range-not-satisfiable");
        assert.match(result.problem?.detail ?? "", /Line 37 cannot select from empty content/);
        const source = await ctx.db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/source.md", scheme: "workspace", name: "body" });
        assert.equal(source?.content, "keep this\n");
        await assert.rejects(readFile(join(root, "missing.md")), { code: "ENOENT" });
        assert.equal(await fileMember(ctx, "missing.md"), undefined);
        assert.deepEqual(await ctx.engine.pendingProposals(ctx.workspaceId), []);
    });
});
});
