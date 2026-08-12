import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import type { EditStatement, PlurnkStatement, ReadStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, seedEnvelope } from "./_helpers.ts";

const parseOne = (input: string): PlurnkStatement => {
    const result = PlurnkParser.parseStatements(input);
    for (const item of result.items) {
        if (item.kind === "statement") return item.statement;
    }
    throw new Error(`no statement parsed from: ${input}`);
};

const parseAll = (input: string): PlurnkStatement[] => {
    const result = PlurnkParser.parseStatements(input);
    return result.items.filter((i) => i.kind === "statement").map((i) => (i as { kind: "statement"; statement: PlurnkStatement }).statement);
};

const dispatch = async (engine: Engine, ctx: Awaited<ReturnType<typeof seedEnvelope>>, statements: PlurnkStatement[]): Promise<number[]> => {
    const statuses: number[] = [];
    for (const [i, statement] of statements.entries()) {
        const result = await engine.dispatch({
            statement, workspaceId: ctx.workspaceId, workerId: ctx.workerId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: i + 1, origin: "model",
        });
        statuses.push(result.status);
    }
    return statuses;
};

test("parser roundtrip: ## EDIT1 [france,europe] (worker:///countries/france/capital)\nParis writes the right entry", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, "ws-roundtrip-edit");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const stmt = parseOne("## EDIT1 [france,europe] (worker:///countries/france/capital)\nParis") as EditStatement;
        const result = await engine.dispatch({
            statement: stmt,
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 201);
        const entry = await db.test_parser_entries_first.get<{ owner_id: number; scheme: string; pathname: string }>();
        assert.ok((entry?.owner_id ?? 0) >= 1, "owner stamped ({§entry-owner})");
        assert.equal(entry?.scheme, "worker");
        assert.equal(entry?.pathname, "/countries/france/capital");
        const body = await db.test_parser_body_first.get<{ content: string }>();
        assert.equal(body?.content, "Paris");
        const tags = await db.test_parser_tags.all<{ tag: string }>();
        assert.deepEqual(tags.map((t) => t.tag), ["europe", "france"]);
    } finally { await db.close(); }
});

// {§empty-section} {§text-scope-semantics}
test("parser roundtrip: an empty EDIT section performs a scoped deletion", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, "ws-roundtrip-empty-edit");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const statements = [
            parseOne("## EDIT1 (worker:///scoped-delete)\nalpha\nbeta\ngamma"),
            parseOne("## EDIT1 (worker:///scoped-delete) <2>"),
        ];

        assert.deepEqual(await dispatch(engine, env, statements), [201, 200]);
        const body = await db.test_get_body_by_pathname.get<{ content: string }>({ pathname: "/scoped-delete" });
        assert.equal(body?.content, "alpha\ngamma");
    } finally { await db.close(); }
});

test("parser roundtrip: multi-statement text parses + dispatches in order", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, "ws-roundtrip-multi");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const text = `## EDIT1 (worker:///a)\nfirst\n\n## EDIT1 (worker:///b)\nsecond\n\n## EDIT1 [noted] (worker:///c)\nthird`;
        const statements = parseAll(text);
        assert.equal(statements.length, 3);
        const statuses = await dispatch(engine, env, statements);
        assert.deepEqual(statuses, [201, 201, 201]);
        const pathnames = await db.test_parser_pathnames.all<{ pathname: string }>();
        assert.deepEqual(pathnames.map((p) => p.pathname), ["/a", "/b", "/c"]);
        const logIndices = await db.test_parser_log_indices.all<{ sequence: number; pathname: string }>();
        assert.deepEqual(logIndices.map((r) => r.sequence), [1, 2, 3]);
        assert.deepEqual(logIndices.map((r) => r.pathname), ["/a", "/b", "/c"]);
    } finally { await db.close(); }
});

test("parser roundtrip: ## EDIT1…\n followed by ## READ1… reads back what was written", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, "ws-roundtrip-readback");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        await engine.dispatch({
            statement: parseOne("## EDIT1 (worker:///france)\nThe capital is Paris.") as EditStatement,
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });

        const readResult = await engine.dispatch({
            statement: parseOne("## READ1 (worker:///france)") as ReadStatement,
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
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

        const stmt = parseOne("## READ1 (https://en.wikipedia.org/wiki/Paris)") as ReadStatement;
        await engine.dispatch({
            statement: stmt,
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        const log = await db.test_parser_log_first.get<{ scheme: string; hostname: string | null; pathname: string }>();
        assert.equal(log?.scheme, "https");
        assert.equal(log?.hostname, "en.wikipedia.org");
        assert.equal(log?.pathname, "/wiki/Paris");
    } finally { await db.close(); }
});

test("parser roundtrip: real DSL preserves serialized query + fragment on opaque scheme", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, "ws-roundtrip-params");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        const stmt = parseOne("## READ1 (worker:///france?lang=fr#History)") as ReadStatement;
        await engine.dispatch({
            statement: stmt,
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        const log = await db.test_parser_log_first.get<{ scheme: string; hostname: string | null; pathname: string; query: string | null; fragment: string | null }>();
        assert.equal(log?.scheme, "worker");
        assert.equal(log?.hostname, null);
        assert.equal(log?.pathname, "/france");
        assert.equal(log?.query, "lang=fr");
        assert.equal(log?.fragment, "History");
    } finally { await db.close(); }
});

// Heading-lane invariance (SPEC.md {§lane-match}). Per plurnk.md,
// `## EDITouter (...)\n...` is the same statement as `## EDIT1 (...)\n...`
// except the suffix string itself. Verifying so
// downstream code can rely on it without case analysis on `statement.suffix`.

const stripVolatile = (stmt: PlurnkStatement): object => {
    // `suffix` and `position` differ across input strings by construction;
    // strip both so deep-equal asserts the shape-invariance the contract
    // actually claims.
    const { suffix: _suffix, position: _position, ...rest } = stmt as PlurnkStatement & { suffix: string; position: object };
    return rest;
};

test("parser: heading lane preserves statement AST (EDIT)", () => {
    const laneOne = parseOne("## EDIT1 [france,europe] (worker:///countries/france/capital)\nParis");
    const laneOuter = parseOne("## EDITouter [france,europe] (worker:///countries/france/capital)\nParis");
    assert.equal(laneOne.op, "EDIT");
    assert.equal(laneOuter.op, "EDIT");
    assert.equal((laneOuter as { suffix: string }).suffix, "outer");
    assert.deepEqual(stripVolatile(laneOne), stripVolatile(laneOuter));
});

test("parser: heading lane preserves statement AST (FIND with matcher)", () => {
    const laneOne = parseOne("## FIND1 (worker:///users.json)\n$.name");
    const laneA = parseOne("## FINDa (worker:///users.json)\n$.name");
    assert.deepEqual(stripVolatile(laneOne), stripVolatile(laneA));
});

test("parser: heading lane preserves statement AST (SEND directed)", () => {
    const laneOne = parseOne("## SEND1 [200] (worker:///result)\nParis");
    const laneOuter = parseOne("## SENDouter [200] (worker:///result)\nParis");
    assert.deepEqual(stripVolatile(laneOne), stripVolatile(laneOuter));
});

test("parser: heading lane preserves statement AST (EXEC)", () => {
    const laneOne = parseOne("## EXEC1\nuname -r");
    const laneOuter = parseOne("## EXECouter\nuname -r");
    assert.deepEqual(stripVolatile(laneOne), stripVolatile(laneOuter));
});

test("parser: an alternate heading lane remains literal section body", () => {
    const input = "## EDITouter (worker:///demo)\nquoted section:\n## EDIT1 (worker:///inner)\nhello";
    const stmts = parseAll(input);
    assert.equal(stmts.length, 1, "only the active-lane heading is structural");
    const outer = stmts[0] as EditStatement & { suffix: string };
    assert.equal(outer.op, "EDIT");
    assert.equal(outer.suffix, "outer");
    assert.equal(outer.body, "quoted section:\n## EDIT1 (worker:///inner)\nhello");
});

test("parser: a different numeric heading lane remains literal section body", () => {
    const input = "## EDIT1 (worker:///demo)\nquoted section:\n## EDIT2 (worker:///inner)\nhello";
    const stmts = parseAll(input);
    assert.equal(stmts.length, 1, "only lane 1 is structural");
    const outer = stmts[0] as EditStatement & { suffix: string };
    assert.equal(outer.op, "EDIT");
    assert.equal(outer.suffix, "1");
    assert.equal(outer.body, "quoted section:\n## EDIT2 (worker:///inner)\nhello");
});
