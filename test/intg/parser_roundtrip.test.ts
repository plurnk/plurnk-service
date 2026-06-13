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
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: i + 1, origin: "model",
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
            sequence: 1, origin: "model",
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

test("parser roundtrip: digit-suffix <<EDIT1…:EDIT1 carries a bare :EDIT token in the body (0.26.0 nesting)", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, "ws-roundtrip-edit1");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const stmt = parseOne("<<EDIT1(known://doc):a body with a :EDIT token inside:EDIT1") as EditStatement;
        assert.equal(stmt.suffix, "1", "the digit suffix is parsed off the delimiter");
        assert.equal(stmt.body, "a body with a :EDIT token inside", "the un-suffixed :EDIT is literal body, not a delimiter");
        const result = await engine.dispatch({
            statement: stmt,
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 201);
        const body = await (db.test_parser_body_first as PrepMethod).get<{ content: string }>();
        assert.equal(body?.content, "a body with a :EDIT token inside", "the bare delimiter survives into storage verbatim");
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
        const logIndices = await (db.test_parser_log_indices as PrepMethod).all<{ sequence: number; pathname: string }>();
        assert.deepEqual(logIndices.map((r) => r.sequence), [1, 2, 3]);
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
            sequence: 1, origin: "model",
        });

        const readResult = await engine.dispatch({
            statement: parseOne("<<READ(known://france)::READ") as ReadStatement,
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            sequence: 2, origin: "model",
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
            sequence: 1, origin: "model",
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
            sequence: 1, origin: "model",
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

// Suffix invariance (SPEC.md §matcher — opening/closing tag suffix is disambiguation
// only). Per plurnk.md: `<<EDITouter(...):...:EDITouter` is the same statement
// as `<<EDIT(...):...:EDIT` except the suffix string itself. Verifying so
// downstream code can rely on it without case analysis on `statement.suffix`.

const stripVolatile = (stmt: PlurnkStatement): object => {
    // `suffix` and `position` differ across input strings by construction;
    // strip both so deep-equal asserts the shape-invariance the contract
    // actually claims.
    const { suffix: _suffix, position: _position, ...rest } = stmt as PlurnkStatement & { suffix: string; position: object };
    return rest;
};

test("parser: opening/closing tag suffix preserves statement AST (EDIT)", () => {
    const noSuffix = parseOne("<<EDIT[france,europe](known://countries/france/capital):Paris:EDIT");
    const withSuffix = parseOne("<<EDITouter[france,europe](known://countries/france/capital):Paris:EDITouter");
    assert.equal(noSuffix.op, "EDIT");
    assert.equal(withSuffix.op, "EDIT");
    assert.equal((withSuffix as { suffix: string }).suffix, "outer");
    assert.deepEqual(stripVolatile(noSuffix), stripVolatile(withSuffix));
});

test("parser: opening/closing tag suffix preserves statement AST (READ with matcher)", () => {
    const noSuffix = parseOne("<<READ(known://users.json):$.name:READ");
    const withSuffix = parseOne("<<READa(known://users.json):$.name:READa");
    assert.deepEqual(stripVolatile(noSuffix), stripVolatile(withSuffix));
});

test("parser: opening/closing tag suffix preserves statement AST (SEND directed)", () => {
    const noSuffix = parseOne("<<SEND[200](known://result):Paris:SEND");
    const withSuffix = parseOne("<<SENDouter[200](known://result):Paris:SENDouter");
    assert.deepEqual(stripVolatile(noSuffix), stripVolatile(withSuffix));
});

test("parser: opening/closing tag suffix preserves statement AST (EXEC)", () => {
    const noSuffix = parseOne("<<EXEC:uname -r:EXEC");
    const withSuffix = parseOne("<<EXECouter:uname -r:EXECouter");
    assert.deepEqual(stripVolatile(noSuffix), stripVolatile(withSuffix));
});

test("parser: nested same-op uses suffix to disambiguate fence boundaries", () => {
    // The fence-suffix contract is meant to enable nesting: an outer EDIT
    // body that contains literal text including `<<EDIT(...):...:EDIT` must
    // not be parsed as a nested statement. The outer EDITouter fence carries
    // through and the inner text stays in the body verbatim.
    const input = "<<EDITouter(known://demo):quoted: <<EDIT(known://inner):hello:EDIT\n:EDITouter";
    const stmts = parseAll(input);
    assert.equal(stmts.length, 1, "exactly one statement parsed (the outer); inner is text inside the body");
    const outer = stmts[0] as EditStatement & { suffix: string };
    assert.equal(outer.op, "EDIT");
    assert.equal(outer.suffix, "outer");
    assert.match(outer.body as string, /<<EDIT\(known:\/\/inner\):hello:EDIT/);
});

test("parser: digit suffix (plurnk.md 0.26.0) disambiguates nested-op fences", () => {
    // 0.26.0 tightened the fence suffix from optional-any to a required digit
    // when quoting an op inside a body: `<<EDIT1(...):...:EDIT1`. Same nesting
    // contract as the alpha case above — outer fence carries, inner stays text.
    const input = "<<EDIT1(known://demo):quoted: <<EDIT(known://inner):hello:EDIT\n:EDIT1";
    const stmts = parseAll(input);
    assert.equal(stmts.length, 1, "exactly one statement parsed (the outer EDIT1)");
    const outer = stmts[0] as EditStatement & { suffix: string };
    assert.equal(outer.op, "EDIT");
    assert.equal(outer.suffix, "1");
    assert.match(outer.body as string, /<<EDIT\(known:\/\/inner\):hello:EDIT/);
});

test("parser: mismatched suffix surfaces a parse-error item", () => {
    // The suffix is a fence-matching token. Mismatched suffixes don't get
    // silently absorbed: the parser emits an `error` item in result.items
    // alongside any best-effort statement extraction. Consumers can decide
    // whether to honor the best-effort statement or reject the whole input
    // when an error is present.
    const mismatched = "<<EDITouter(known://x):body:EDITother";
    const result = PlurnkParser.parse(mismatched);
    const errors = result.items.filter((i) => i.kind === "error");
    assert.ok(errors.length >= 1, "mismatched suffix yields at least one error item");
});
