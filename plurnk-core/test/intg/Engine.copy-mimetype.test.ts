import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { DEFAULT_MIMETYPES, openMigrated, seedEnvelope, seedEntryWithChannel } from "./_helpers.ts";
import { copyStmt, moveStmt, urlPath } from "./_dsl.ts";

const content = '## Finding\n- `a<b` & "quoted"\n\tcafé → 東京\n';

const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `copy-mimetype-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
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
    const op = transfer(urlPath("worker", "/src"), urlPath("worker", "/dst")).op;
    for (const pathname of ["/notes.txt", "/notes.md", "/notes"]) {
        test(`{§mimetype-verbatim-transfer}: ${op} plain text to new ${pathname} preserves content and resolves the destination type`, async () => {
            const { db, seed, read, dispatch } = await setup();
            try {
                const body = content.replaceAll("\n", "\r\n");
                await seed("/src", "text/plain", body);
                const result = await dispatch(transfer(urlPath("worker", "/src"), urlPath("worker", pathname)));
                assert.equal(result.status, 201);
                assert.deepEqual(await read(pathname), { content: body, mimetype: "text/markdown" });
                assert.deepEqual(await read("/src"), op === "COPY" ? { content: body, mimetype: "text/plain" } : undefined);
            } finally { await db.close(); }
        });
    }

    for (const [sourceMimetype, destinationMimetype] of [
        ["text/plain", "text/markdown"],
        ["text/markdown", "text/plain"],
        ["text/plain", "text/plain"],
    ] as const) {
        test(`{§mimetype-verbatim-transfer}: scoped ${op} ${sourceMimetype} → ${destinationMimetype} preserves both declared types`, async () => {
            const { db, seed, read, dispatch } = await setup();
            try {
                await seed("/src", sourceMimetype);
                await seed("/dst.txt", destinationMimetype, "before\nreplace\nafter\n");
                const result = await dispatch(transfer(
                    urlPath("worker", "/src"), urlPath("worker", "/dst.txt"),
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
        test(`{§channel-mimetype-cross-mimetype-415}: ${op} from ${mimetype} to Markdown remains 415 without mutation`, async () => {
            const { db, seed, read, dispatch } = await setup();
            try {
                await seed("/src", mimetype, body);
                const result = await dispatch(transfer(urlPath("worker", "/src"), urlPath("worker", "/dst.md")));
                assert.equal(result.status, 415);
                assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/mimetype-mismatch");
                assert.equal(result.problem?.channel, "body");
                assert.equal(result.problem?.sourceMimetype, mimetype);
                assert.equal(result.problem?.destinationMimetype, "text/markdown");
                assert.deepEqual(await read("/src"), { content: body, mimetype });
                assert.equal(await read("/dst.md"), undefined);
            } finally { await db.close(); }
        });
    }
}

for (const same of [true, false]) {
    test(`{§copy-noop-304} {§copy-conflict-409}: compatible COPY with ${same ? "identical" : "different"} destination content keeps ordinary collision semantics`, async () => {
        const { db, seed, read, dispatch } = await setup();
        try {
            const destinationContent = same ? content : "other content";
            await seed("/src", "text/markdown");
            await seed("/dst", "text/plain", destinationContent);
            const result = await dispatch(copyStmt(urlPath("worker", "/src"), urlPath("worker", "/dst")));
            assert.equal(result.status, same ? 304 : 409);
            if (!same) assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/copy-destination-exists");
            assert.equal(result.effects, undefined);
            assert.deepEqual(await read("/src"), { content, mimetype: "text/markdown" });
            assert.deepEqual(await read("/dst"), { content: destinationContent, mimetype: "text/plain" });
        } finally { await db.close(); }
    });
}
