import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { PlurnkParser } from "@plurnk/plurnk-grammar";
import type { EditStatement, PlurnkStatement, ReadStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
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
    for (const [actionIndex, statement] of statements.entries()) {
        const result = await engine.dispatch({
            statement, sessionId: ctx.sessionId, runId: ctx.runId,
            loopId: ctx.loopId, turnId: ctx.turnId, actionIndex, origin: "model",
        });
        statuses.push(result.status);
    }
    return statuses;
};

test("parser roundtrip: <<EDIT[france,europe](known://countries/france/capital):Paris:EDIT writes the right entry", async () => {
    const db = await openMigrated();
    try {
        const env = seedEnvelope(db, "ws-roundtrip-edit");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const stmt = parseOne("<<EDIT[france,europe](known://countries/france/capital):Paris:EDIT") as EditStatement;
        const result = await engine.dispatch({
            statement: stmt,
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 0, origin: "model",
        });
        assert.equal(result.status, 201);
        const entry = db.prepare("SELECT scope, scheme, pathname, hostname FROM entries").get() as { scope: string; scheme: string; pathname: string; hostname: string | null };
        assert.equal(entry.scope, "session");
        assert.equal(entry.scheme, "known");
        assert.equal(entry.pathname, "countries/france/capital", "0.3.0: opaque-scheme path preserved without spurious hostname split");
        assert.equal(entry.hostname, null, "no hostname for opaque scheme");
        const body = (db.prepare("SELECT content FROM entry_channels WHERE name = 'body'").get() as { content: string }).content;
        assert.equal(body, "Paris");
        const tags = db.prepare("SELECT tag FROM entry_tags ORDER BY tag").all() as { tag: string }[];
        assert.deepEqual(tags.map((t) => t.tag), ["europe", "france"]);
    } finally { db.close(); }
});

test("parser roundtrip: multi-statement text parses + dispatches in order", async () => {
    const db = await openMigrated();
    try {
        const env = seedEnvelope(db, "ws-roundtrip-multi");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const text = `<<EDIT(known://a):first:EDIT
<<EDIT(known://b):second:EDIT
<<EDIT[noted](known://c):third:EDIT`;
        const statements = parseAll(text);
        assert.equal(statements.length, 3);
        const statuses = await dispatch(engine, env, statements);
        assert.deepEqual(statuses, [201, 201, 201]);
        const pathnames = db.prepare("SELECT pathname FROM entries ORDER BY pathname").all() as { pathname: string }[];
        assert.deepEqual(pathnames.map((p) => p.pathname), ["a", "b", "c"]);
        const logIndices = db.prepare("SELECT action_index, target_pathname FROM log_entries ORDER BY action_index").all() as { action_index: number; target_pathname: string }[];
        assert.deepEqual(logIndices.map((r) => r.action_index), [0, 1, 2]);
        assert.deepEqual(logIndices.map((r) => r.target_pathname), ["a", "b", "c"]);
    } finally { db.close(); }
});

test("parser roundtrip: <<EDIT…>> followed by <<READ…>> reads back what was written", async () => {
    const db = await openMigrated();
    try {
        const env = seedEnvelope(db, "ws-roundtrip-readback");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        await engine.dispatch({
            statement: parseOne("<<EDIT(known://france):The capital is Paris.:EDIT") as EditStatement,
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 0, origin: "model",
        });

        const readResult = await engine.dispatch({
            statement: parseOne("<<READ(known://france)::READ") as ReadStatement,
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 1, origin: "model",
        });
        assert.equal(readResult.status, 200);
        assert.equal((readResult as unknown as { content: string }).content, "The capital is Paris.");
    } finally { db.close(); }
});

test("parser roundtrip: HTTP-shape path still decomposes authority correctly", async () => {
    const db = await openMigrated();
    try {
        const env = seedEnvelope(db, "ws-roundtrip-http");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        const stmt = parseOne("<<READ(https://en.wikipedia.org/wiki/Paris)::READ") as ReadStatement;
        await engine.dispatch({
            statement: stmt,
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 0, origin: "model",
        });
        const log = db.prepare("SELECT target_scheme, target_hostname, target_pathname FROM log_entries").get() as { target_scheme: string; target_hostname: string | null; target_pathname: string };
        assert.equal(log.target_scheme, "https");
        assert.equal(log.target_hostname, "en.wikipedia.org", "0.3.0 still gives authority to HTTP");
        assert.equal(log.target_pathname, "/wiki/Paris");
    } finally { db.close(); }
});

test("parser roundtrip: real DSL with params + fragment on opaque scheme", async () => {
    const db = await openMigrated();
    try {
        const env = seedEnvelope(db, "ws-roundtrip-params");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        const stmt = parseOne("<<READ(known://france?lang=fr#History)::READ") as ReadStatement;
        await engine.dispatch({
            statement: stmt,
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 0, origin: "model",
        });
        const log = db.prepare("SELECT target_scheme, target_hostname, target_pathname, target_params, target_fragment FROM log_entries").get() as { target_scheme: string; target_hostname: string | null; target_pathname: string; target_params: string | null; target_fragment: string | null };
        assert.equal(log.target_scheme, "known");
        assert.equal(log.target_hostname, null);
        assert.equal(log.target_pathname, "france", "opaque pathname without spurious authority");
        const params = JSON.parse(log.target_params!) as Record<string, unknown>;
        assert.equal(params.lang, "fr");
        assert.equal(log.target_fragment, "History");
    } finally { db.close(); }
});
