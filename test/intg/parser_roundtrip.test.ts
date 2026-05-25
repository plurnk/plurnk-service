import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-grammar";
import type { EditStatement, PlurnkStatement, ReadStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, seedEnvelope } from "./_helpers.ts";

const parseOne = (input: string): PlurnkStatement => {
    const result = PlurnkParser.parse(input);
    for (const item of result.items) {
        if (item.kind === "statement") return item.statement;
    }
    throw new Error(`no statement parsed from: ${input}`);
};

const parseAll = (input: string): PlurnkStatement[] => {
    const result = PlurnkParser.parse(input);
    return result.items.filter((i) => i.kind === "statement").map((i) => (i as { kind: "statement"; statement: PlurnkStatement }).statement);
};

const dispatch = async (engine: Engine, ctx: Awaited<ReturnType<typeof seedEnvelope>>, statements: PlurnkStatement[]): Promise<number[]> => {
    const statuses: number[] = [];
    for (const [i, statement] of statements.entries()) {
        const result = await engine.dispatch({
            statement, sessionId: ctx.sessionId, runId: ctx.runId,
            loopId: ctx.loopId, turnId: ctx.turnId, actionIndex: i + 1, origin: "model",
        });
        statuses.push(result.status);
    }
    return statuses;
};

test("parser roundtrip: <<EDIT[france,europe](known://countries/france/capital):Paris:EDIT writes the right entry", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, "ws-roundtrip-edit");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const stmt = parseOne("<<EDIT[france,europe](known://countries/france/capital):Paris:EDIT") as EditStatement;
        const result = await engine.dispatch({
            statement: stmt,
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 1, origin: "model",
        });
        assert.equal(result.status, 201);
        const entry = await (db.test_parser_entries_first as PrepMethod).get<{ scope: string; scheme: string; pathname: string; hostname: string | null }>();
        assert.equal(entry?.scope, "session");
        assert.equal(entry?.scheme, "known");
        assert.equal(entry?.pathname, "countries/france/capital");
        assert.equal(entry?.hostname, null);
        const body = await (db.test_parser_body_first as PrepMethod).get<{ content: string }>();
        assert.equal(body?.content, "Paris");
        const tags = await (db.test_parser_tags as PrepMethod).all<{ tag: string }>();
        assert.deepEqual(tags.map((t) => t.tag), ["europe", "france"]);
    } finally { await db.close(); }
});

test("parser roundtrip: multi-statement text parses + dispatches in order", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, "ws-roundtrip-multi");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const text = `<<EDIT(known://a):first:EDIT
<<EDIT(known://b):second:EDIT
<<EDIT[noted](known://c):third:EDIT`;
        const statements = parseAll(text);
        assert.equal(statements.length, 3);
        const statuses = await dispatch(engine, env, statements);
        assert.deepEqual(statuses, [201, 201, 201]);
        const pathnames = await (db.test_parser_pathnames as PrepMethod).all<{ pathname: string }>();
        assert.deepEqual(pathnames.map((p) => p.pathname), ["a", "b", "c"]);
        const logIndices = await (db.test_parser_log_indices as PrepMethod).all<{ action_index: number; pathname: string }>();
        assert.deepEqual(logIndices.map((r) => r.action_index), [1, 2, 3]);
        assert.deepEqual(logIndices.map((r) => r.pathname), ["a", "b", "c"]);
    } finally { await db.close(); }
});

test("parser roundtrip: <<EDIT…>> followed by <<READ…>> reads back what was written", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, "ws-roundtrip-readback");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        await engine.dispatch({
            statement: parseOne("<<EDIT(known://france):The capital is Paris.:EDIT") as EditStatement,
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 1, origin: "model",
        });

        const readResult = await engine.dispatch({
            statement: parseOne("<<READ(known://france)::READ") as ReadStatement,
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 2, origin: "model",
        });
        assert.equal(readResult.status, 200);
        assert.equal((readResult as unknown as { content: string }).content, "The capital is Paris.");
    } finally { await db.close(); }
});

test("parser roundtrip: HTTP-shape path still decomposes authority correctly", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, "ws-roundtrip-http");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        const stmt = parseOne("<<READ(https://en.wikipedia.org/wiki/Paris)::READ") as ReadStatement;
        await engine.dispatch({
            statement: stmt,
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 1, origin: "model",
        });
        const log = await (db.test_parser_log_first as PrepMethod).get<{ scheme: string; hostname: string | null; pathname: string }>();
        assert.equal(log?.scheme, "https");
        assert.equal(log?.hostname, "en.wikipedia.org");
        assert.equal(log?.pathname, "/wiki/Paris");
    } finally { await db.close(); }
});

test("parser roundtrip: real DSL with params + fragment on opaque scheme", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, "ws-roundtrip-params");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        const stmt = parseOne("<<READ(known://france?lang=fr#History)::READ") as ReadStatement;
        await engine.dispatch({
            statement: stmt,
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 1, origin: "model",
        });
        const log = await (db.test_parser_log_first as PrepMethod).get<{ scheme: string; hostname: string | null; pathname: string; params: string | null; fragment: string | null }>();
        assert.equal(log?.scheme, "known");
        assert.equal(log?.hostname, null);
        assert.equal(log?.pathname, "france");
        const params = JSON.parse(log?.params ?? "{}") as Record<string, unknown>;
        assert.equal(params.lang, "fr");
        assert.equal(log?.fragment, "History");
    } finally { await db.close(); }
});
